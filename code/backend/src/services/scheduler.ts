/**
 * 定时任务调度器(M3):一次性 + 周期统一模型,croner 驱动,到点复用派发通道
 * (createDispatch,同 weekly-draft.ts 的模式)创建一个真实派发会话执行 prompt。
 * 好处全是白拿的:运行中/需审批/已完成的实例同步出现在会话看板(带来源标),
 * 审批可直接在会话页处理,失败排查靠只读回放而不是新开会话问 Claude。
 *
 * 睡眠错过追赶策略:一次性任务错过触发窗口(进程重启或系统睡眠导致 croner 补触发延迟)
 * 超过 GRACE_MS 直接标记 missed 并通知,不做静默补跑;宽限期内视为"迟到但仍执行"。
 * 周期任务连续失败达 FUSE_THRESHOLD 次自动熔断,停止调度直到用户手动恢复。
 */
import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import { createDispatch } from './dispatch.js';
import { notifyMac } from '../adapters/notify.js';
import type { Storage } from '../storage/db.js';
import type { ScheduledJob, ScheduledJobKind, ScheduledRun } from '../types.js';

const GRACE_MS = 30 * 60_000;
const FUSE_THRESHOLD = 3;
const TIMEZONE = 'Asia/Shanghai';

export interface CreateJobInput {
  kind: ScheduledJobKind;
  name: string;
  prompt: string;
  cwd: string;
  model?: string;
  permissionMode: string;
  maxBudgetUsd?: number;
  /** kind='once' 必填,epoch ms */
  runAt?: number;
  /** kind='cron' 必填,croner 语法 */
  cronExpr?: string;
}

/** PATCH 用:每个字段 undefined = 不改,null = 显式清空(仅可空字段接受) */
export interface UpdateJobInput {
  name?: string;
  prompt?: string;
  cwd?: string;
  model?: string | null;
  permissionMode?: string;
  maxBudgetUsd?: number | null;
  runAt?: number | null;
  cronExpr?: string | null;
}

export class SchedulerService {
  private storage: Storage;
  private crons = new Map<string, Cron>();

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** 启动时加载全部待执行/挂起任务并重新注册触发器;server 重启不丢任务 */
  init() {
    for (const job of this.storage.listScheduledJobs()) {
      if (job.status === 'pending' || job.status === 'blocked') this.schedule(job);
    }
  }

  /** 关停全部触发器(测试 / 优雅退出用) */
  shutdown() {
    for (const c of this.crons.values()) c.stop();
    this.crons.clear();
  }

  // ---------- 增删改查(供 API 路由调用) ----------

  create(input: CreateJobInput): ScheduledJob {
    if (input.kind === 'once' && !input.runAt) throw new Error('once 任务需要 runAt');
    if (input.kind === 'cron' && !input.cronExpr) throw new Error('cron 任务需要 cronExpr');
    const id = randomUUID();
    this.storage.createScheduledJob({
      id,
      kind: input.kind,
      name: input.name,
      prompt: input.prompt,
      cwd: input.cwd,
      model: input.model ?? null,
      permissionMode: input.permissionMode,
      maxBudgetUsd: input.maxBudgetUsd ?? null,
      runAt: input.runAt ?? null,
      cronExpr: input.cronExpr ?? null,
      status: 'pending',
      consecutiveFailures: 0,
      resultSessionId: null,
      lastError: null,
      nextRunAt: null,
    });
    const job = this.storage.getScheduledJob(id);
    if (!job) throw new Error('创建后读取失败');
    this.schedule(job);
    // schedule() 会回写 nextRunAt,重新读取,不能返回排程前的快照
    return this.storage.getScheduledJob(id) ?? job;
  }

  list(): ScheduledJob[] {
    return this.storage.listScheduledJobs();
  }

  /** 编辑任务定义;运行中/审批中不可编辑。熔断/错过/取消态编辑后自动回到 pending 重新排程 */
  update(id: string, patch: UpdateJobInput): ScheduledJob {
    const job = this.storage.getScheduledJob(id);
    if (!job) throw new Error('任务不存在');
    if (job.status === 'running' || job.status === 'blocked') throw new Error('运行中的任务不能编辑,等它结束或先取消');
    this.unschedule(id);
    const revives: ScheduledJob['status'] =
      job.status === 'fused' || job.status === 'missed' || job.status === 'canceled' ? 'pending' : job.status;
    this.storage.updateScheduledJob(id, {
      name: patch.name ?? job.name,
      prompt: patch.prompt ?? job.prompt,
      cwd: patch.cwd ?? job.cwd,
      model: patch.model !== undefined ? (patch.model ?? null) : job.model,
      permissionMode: patch.permissionMode ?? job.permissionMode,
      maxBudgetUsd: patch.maxBudgetUsd !== undefined ? (patch.maxBudgetUsd ?? null) : job.maxBudgetUsd,
      runAt: patch.runAt !== undefined ? (patch.runAt ?? null) : job.runAt,
      cronExpr: patch.cronExpr !== undefined ? (patch.cronExpr ?? null) : job.cronExpr,
      status: revives,
      consecutiveFailures: revives === 'pending' && job.status !== 'pending' ? 0 : job.consecutiveFailures,
      lastError: revives === 'pending' && job.status !== 'pending' ? null : job.lastError,
    });
    const fresh = this.storage.getScheduledJob(id);
    if (!fresh) throw new Error('更新后读取失败');
    if (fresh.status === 'pending') {
      this.schedule(fresh);
      // schedule() 回写了 nextRunAt,重新读取,不能返回排程前的快照(同 create() 的教训)
      return this.storage.getScheduledJob(id) ?? fresh;
    }
    return fresh;
  }

  get(id: string): ScheduledJob | null {
    return this.storage.getScheduledJob(id);
  }

  runs(jobId: string, limit?: number): { runs: ScheduledRun[]; total: number } {
    return { runs: this.storage.listScheduledRuns(jobId, limit), total: this.storage.countScheduledRuns(jobId) };
  }

  /** 周期任务暂停:停止调度,状态可逆(resume 恢复) */
  pause(id: string): boolean {
    const job = this.storage.getScheduledJob(id);
    if (!job || job.kind !== 'cron') return false;
    this.unschedule(id);
    this.storage.updateScheduledJob(id, { status: 'paused', nextRunAt: null });
    return true;
  }

  /** 暂停/熔断的任务恢复调度;熔断恢复时清零连续失败计数 */
  resume(id: string): boolean {
    const job = this.storage.getScheduledJob(id);
    if (!job) return false;
    if (job.status === 'paused' || job.status === 'fused') {
      this.storage.updateScheduledJob(id, { status: 'pending', consecutiveFailures: 0, lastError: null });
    }
    const fresh = this.storage.getScheduledJob(id);
    if (!fresh) return false;
    this.schedule(fresh);
    return true;
  }

  /** 一次性任务取消(尚未触发时) */
  cancel(id: string): boolean {
    const job = this.storage.getScheduledJob(id);
    if (!job) return false;
    this.unschedule(id);
    this.storage.updateScheduledJob(id, { status: 'canceled', nextRunAt: null });
    return true;
  }

  remove(id: string) {
    this.unschedule(id);
    this.storage.deleteScheduledJob(id);
  }

  /** 立即触发一次,不影响原定调度(周期任务下次仍按 cron 表达式走) */
  runNow(id: string): boolean {
    const job = this.storage.getScheduledJob(id);
    if (!job) return false;
    this.fire(id, Date.now(), { manual: true }).catch((err) => {
      console.error(`[scheduler] runNow(${id}) 失败:`, err);
    });
    return true;
  }

  // ---------- 触发器注册 ----------

  private schedule(job: ScheduledJob) {
    this.unschedule(job.id);
    if (job.kind === 'once') {
      if (!job.runAt) return;
      const now = Date.now();
      if (now - job.runAt > GRACE_MS) {
        this.storage.updateScheduledJob(job.id, { status: 'missed', nextRunAt: null });
        notifyMac(job.name, '定时任务已错过触发窗口(超出 30 分钟补跑宽限期)');
        return;
      }
      const runAt = job.runAt;
      if (now >= runAt) {
        // 已到点但在宽限期内(如进程刚启动补触发):croner 的 Date 触发器是秒级精度,
        // 贴近当下的时间点可能被判定为"已过去"而不触发——直接 setTimeout 补跑,不经过 croner
        this.storage.updateScheduledJob(job.id, { nextRunAt: now });
        setTimeout(() => {
          this.fire(job.id, runAt).catch((err) => console.error(`[scheduler] fire(${job.id}) 失败:`, err));
        }, 0);
        return;
      }
      const c = new Cron(
        new Date(runAt),
        { timezone: TIMEZONE, catch: true },
        () => {
          this.fire(job.id, runAt).catch((err) => console.error(`[scheduler] fire(${job.id}) 失败:`, err));
        },
      );
      this.crons.set(job.id, c);
      this.storage.updateScheduledJob(job.id, { nextRunAt: runAt });
    } else {
      if (!job.cronExpr) return;
      const c = new Cron(
        job.cronExpr,
        { timezone: TIMEZONE, catch: true },
        () => {
          this.fire(job.id, Date.now()).catch((err) => console.error(`[scheduler] fire(${job.id}) 失败:`, err));
        },
      );
      this.crons.set(job.id, c);
      const next = c.nextRun();
      this.storage.updateScheduledJob(job.id, { nextRunAt: next ? next.getTime() : null });
    }
  }

  private unschedule(id: string) {
    const c = this.crons.get(id);
    if (c) {
      c.stop();
      this.crons.delete(id);
    }
  }

  // ---------- 触发执行 ----------

  private async fire(jobId: string, scheduledFor: number, opts: { manual?: boolean } = {}) {
    const job = this.storage.getScheduledJob(jobId);
    if (!job) return;
    if (!opts.manual && (job.status === 'canceled' || job.status === 'paused' || job.status === 'fused')) return;
    // 上一期还没结束(可能卡在审批):跳过本次,避免同一任务并发派发两个会话
    if (!opts.manual && (job.status === 'running' || job.status === 'blocked')) {
      console.warn(`[scheduler] job ${jobId} 上一期仍在进行,跳过本次触发`);
      return;
    }
    // croner 在系统睡眠后补触发时,再核对一次宽限期(仅一次性任务适用;手动立即运行不受限)
    if (!opts.manual && job.kind === 'once' && Date.now() - scheduledFor > GRACE_MS) {
      this.storage.updateScheduledJob(jobId, { status: 'missed', nextRunAt: null });
      notifyMac(job.name, '定时任务已错过触发窗口(超出 30 分钟补跑宽限期)');
      return;
    }

    const runId = this.storage.createScheduledRun({
      jobId,
      scheduledFor,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'running',
      sessionId: null,
      costUsd: null,
      durationMs: null,
      error: null,
    });
    this.storage.updateScheduledJob(jobId, { status: 'running' });

    const session = createDispatch(this.storage, {
      cwd: job.cwd,
      model: job.model ?? undefined,
      permissionMode: job.permissionMode,
      name: job.name,
    });

    const unsub = session.subscribe((e) => {
      switch (e.ev) {
        case 'init':
          this.storage.updateScheduledRun(runId, { sessionId: e.sessionId });
          this.storage.updateScheduledJob(jobId, { resultSessionId: e.sessionId });
          break;
        case 'status':
          if (e.state === 'awaiting-permission') {
            this.storage.updateScheduledRun(runId, { status: 'blocked' });
            this.storage.updateScheduledJob(jobId, { status: 'blocked' });
          }
          break;
        case 'result': {
          // 软预算校验:SDK 只在回合结束时给出总成本,无法中途打断——超支只能事后记录、通知
          const budgetLimit = job.maxBudgetUsd;
          const overBudget = budgetLimit != null && e.costUsd > budgetLimit;
          const note = overBudget ? `超预算:$${e.costUsd.toFixed(2)} > 上限 $${budgetLimit.toFixed(2)}` : null;
          this.storage.updateScheduledRun(runId, {
            status: 'done',
            finishedAt: Date.now(),
            costUsd: e.costUsd,
            durationMs: e.durationMs,
            error: note,
          });
          this.onOutcome(jobId, 'done', note ?? undefined);
          if (overBudget) notifyMac(job.name, `已完成,但${note}`);
          unsub();
          break;
        }
        case 'error':
          this.storage.updateScheduledRun(runId, { status: 'error', finishedAt: Date.now(), error: e.message });
          this.onOutcome(jobId, 'error', e.message);
          unsub();
          break;
        default:
          break;
      }
    });
    session.send(job.prompt);
  }

  /** 运行结束回写任务级状态:一次性直接终态;周期任务成功清零失败计数回到 pending,失败累加到阈值即熔断 */
  private onOutcome(jobId: string, result: 'done' | 'error', errorMessage?: string) {
    const job = this.storage.getScheduledJob(jobId);
    if (!job) return;
    // 运行期间用户手动取消/暂停:尊重用户操作,不再回写覆盖
    if (job.status === 'canceled' || job.status === 'paused') return;

    if (job.kind === 'once') {
      this.storage.updateScheduledJob(jobId, {
        status: result,
        lastError: result === 'error' ? (errorMessage ?? null) : null,
        nextRunAt: null,
      });
      return;
    }

    if (result === 'done') {
      this.storage.updateScheduledJob(jobId, { status: 'pending', consecutiveFailures: 0, lastError: null });
      return;
    }
    const failures = job.consecutiveFailures + 1;
    if (failures >= FUSE_THRESHOLD) {
      this.unschedule(jobId);
      this.storage.updateScheduledJob(jobId, {
        status: 'fused',
        consecutiveFailures: failures,
        lastError: errorMessage ?? null,
        nextRunAt: null,
      });
      notifyMac(job.name, `连续失败 ${failures} 次,已熔断:${errorMessage ?? ''}`.trim());
    } else {
      this.storage.updateScheduledJob(jobId, {
        status: 'pending',
        consecutiveFailures: failures,
        lastError: errorMessage ?? null,
      });
    }
  }
}
