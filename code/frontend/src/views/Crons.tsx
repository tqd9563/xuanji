/**
 * 定时任务(M3):一次性 + 周期统一列表,croner 调度,到点创建真实派发会话。
 * 失败/需审批排查走只读回放(同会话看板同一份组件),不新开会话问 Claude——
 * 架构铁律:非公开格式(session jsonl)解析只在 Adapter 层,前端只消费后端已归一化的 Replay。
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api/client';
import type { Replay, ScheduledJob, ScheduledRun } from '@/api/types';
import { usePoll } from '@/lib/hooks';
import { setDispatchIntent } from '@/lib/dispatch';
import { CompactionCard, Drawer, Empty, Md, ToolCard, confirmBox, toast } from '@/components/shared';
import { DropUp } from '@/components/DropUp';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Filter = 'all' | 'once' | 'cron';

const STATE_PILL: Record<ScheduledJob['status'], { cls: string; txt: string }> = {
  pending: { cls: 'pill-sched', txt: '待执行' },
  running: { cls: 'pill-run', txt: '运行中' },
  blocked: { cls: 'pill-blk', txt: '需审批' },
  done: { cls: 'pill-done', txt: '已完成' },
  error: { cls: 'pill-err', txt: '失败' },
  fused: { cls: 'pill-err', txt: '已熔断' },
  missed: { cls: 'pill-blk', txt: '已错过' },
  canceled: { cls: 'pill-idle', txt: '已取消' },
  paused: { cls: 'pill-idle', txt: '已暂停' },
};

const CRON_LABELS: Record<string, string> = {
  '0 9 * * *': '每天 09:00',
  '0 18 * * 5': '每周五 18:00',
  '0 8 * * 1': '每周一 08:00',
};

function relTime(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return '即将执行';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `约 ${m} 分钟后`;
  const h = Math.round(m / 60);
  if (h < 24) return `约 ${h} 小时后`;
  return `约 ${Math.round(h / 24)} 天后`;
}

function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function whenOf(job: ScheduledJob): { when: string; rel: string } {
  if (job.kind === 'once') {
    const when = job.status === 'running' ? '运行中' : job.runAt ? fmtDateTime(job.runAt) : '—';
    const rel =
      job.status === 'pending' && job.runAt
        ? relTime(job.runAt)
        : job.status === 'done'
          ? '已完成'
          : job.status === 'error'
            ? '运行失败'
            : job.status === 'missed'
              ? '已错过'
              : job.status === 'canceled'
                ? '已取消'
                : '';
    return { when, rel };
  }
  const when = (job.cronExpr && CRON_LABELS[job.cronExpr]) || job.cronExpr || '—';
  const rel =
    job.status === 'fused'
      ? '已暂停(熔断)'
      : job.status === 'paused'
        ? '已暂停'
        : job.status === 'pending' && job.nextRunAt
          ? `下次 ${relTime(job.nextRunAt)}`
          : '';
  return { when, rel };
}

const PERM_LABEL: Record<string, string> = {
  acceptEdits: '自动接受编辑',
  default: '保守',
  plan: '计划模式',
  bypassPermissions: '完全放行',
};
const PERMS = ['acceptEdits', 'default', 'plan', 'bypassPermissions'];
const MODELS = ['sonnet', 'opus', 'haiku', 'fable'];
const BUDGETS: [string, number | undefined][] = [
  ['$10 / 次', 10],
  ['$20 / 次', 20],
  ['$50 / 次', 50],
  ['$100 / 次', 100],
  ['不限', undefined],
];
const TIME_CHIPS: [string, string][] = [
  ['20', '今晚 20:00'],
  ['22', '今晚 22:00'],
  ['tmr9', '明早 09:00'],
];
const CRON_CHIPS: [string, string][] = [
  ['0 9 * * *', '每天 09:00'],
  ['0 18 * * 5', '每周五 18:00'],
  ['0 8 * * 1', '每周一 08:00'],
];

function timeChipDate(key: string): Date {
  const now = new Date();
  const d = new Date(now);
  if (key === 'tmr9') {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  }
  d.setHours(key === '20' ? 20 : 22, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/** datetime-local input 需要的本地时间字符串(无时区后缀) */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- 新建/编辑任务模态 ----------

interface ModalState {
  kind: 'once' | 'cron';
  name: string;
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: string;
  budget: number | undefined;
  timeChip: string;
  customDate: string;
  cronChip: string;
  cronExpr: string;
}

function initialModalState(cwdOptions: string[], job?: ScheduledJob): ModalState {
  if (job) {
    const isKnownCron = job.cronExpr ? CRON_CHIPS.some(([c]) => c === job.cronExpr) : false;
    return {
      kind: job.kind,
      name: job.name,
      prompt: job.prompt,
      cwd: job.cwd,
      model: job.model ?? MODELS[0]!,
      permissionMode: job.permissionMode,
      budget: job.maxBudgetUsd ?? undefined,
      timeChip: 'custom',
      customDate: job.runAt ? toLocalInputValue(new Date(job.runAt)) : '',
      cronChip: isKnownCron ? job.cronExpr! : 'custom',
      cronExpr: job.cronExpr ?? CRON_CHIPS[0]![0],
    };
  }
  return {
    kind: 'once',
    name: '',
    prompt: '',
    cwd: cwdOptions[0] ?? '',
    model: MODELS[0]!,
    permissionMode: 'acceptEdits',
    budget: 50,
    timeChip: '20',
    customDate: '',
    cronChip: '0 9 * * *',
    cronExpr: '0 9 * * *',
  };
}

const labelStyle = {
  display: 'block',
  fontSize: '0.6875rem',
  fontWeight: 600,
  color: 'var(--faint)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.04em',
  marginBottom: 6,
};

function JobModal({
  job,
  cwdOptions,
  onClose,
  onSaved,
}: {
  job: ScheduledJob | 'new';
  cwdOptions: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = job !== 'new';
  const [s, setS] = useState<ModalState>(() => initialModalState(cwdOptions, editing ? job : undefined));
  const [busy, setBusy] = useState(false);
  const patch = (p: Partial<ModalState>) => setS((prev) => ({ ...prev, ...p }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const runAt = useMemo(() => {
    if (s.timeChip === 'custom') return s.customDate ? new Date(s.customDate).getTime() : undefined;
    return timeChipDate(s.timeChip).getTime();
  }, [s.timeChip, s.customDate]);
  const cronExpr = s.cronChip === 'custom' ? s.cronExpr : s.cronChip;

  const whenLabel =
    s.kind === 'once'
      ? s.timeChip === 'custom'
        ? s.customDate
          ? fmtDateTime(new Date(s.customDate).getTime())
          : '选择时间'
        : (TIME_CHIPS.find(([k]) => k === s.timeChip)?.[1] ?? '')
      : `cron ${cronExpr}`;

  const save = async () => {
    if (!s.name.trim() || !s.prompt.trim() || !s.cwd.trim()) {
      toast('名称 / Prompt / 工作目录不能为空');
      return;
    }
    if (s.kind === 'once' && !runAt) {
      toast('请选择执行时间');
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        await api.updateSchedule(job.id, {
          name: s.name.trim(),
          prompt: s.prompt.trim(),
          cwd: s.cwd.trim(),
          model: s.model,
          permissionMode: s.permissionMode,
          maxBudgetUsd: s.budget ?? null,
          runAt: s.kind === 'once' ? (runAt ?? null) : null,
          cronExpr: s.kind === 'cron' ? cronExpr : null,
        });
        toast('任务已更新');
      } else {
        await api.createSchedule({
          kind: s.kind,
          name: s.name.trim(),
          prompt: s.prompt.trim(),
          cwd: s.cwd.trim(),
          model: s.model,
          permissionMode: s.permissionMode,
          maxBudgetUsd: s.budget,
          runAt: s.kind === 'once' ? runAt : undefined,
          cronExpr: s.kind === 'cron' ? cronExpr : undefined,
        });
        toast('任务已保存,到点后端自动执行 ✓');
      }
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="backdrop show" onClick={onClose} />
      <div className="modal show" role="dialog" aria-modal="true" aria-label={editing ? '编辑定时任务' : '新建定时任务'}>
        <div className="modal-head">
          <h2>{editing ? '编辑定时任务' : '新建定时任务'}</h2>
          <span className="spacer" />
          <button className="x-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="mfield">
            <label>任务类型</label>
            <div className="seg">
              <button className={s.kind === 'once' ? 'active' : ''} disabled={editing} onClick={() => patch({ kind: 'once' })}>
                一次性
              </button>
              <button className={s.kind === 'cron' ? 'active' : ''} disabled={editing} onClick={() => patch({ kind: 'cron' })}>
                周期
              </button>
            </div>
          </div>

          <div className="mfield">
            <label>任务名称</label>
            <Input placeholder="例:今晚汇总本周周报草稿" value={s.name} onChange={(e) => patch({ name: e.target.value })} />
          </div>

          <div className="mfield">
            <label>Prompt(发给 Claude 的指令)</label>
            <textarea
              className="input"
              rows={4}
              placeholder="汇总本周会话产出与 git log,按组周报模板生成草稿,存到 drafts/ 等待人工审阅。"
              value={s.prompt}
              onChange={(e) => patch({ prompt: e.target.value })}
            />
          </div>

          <div className="mfield two-col">
            <div>
              <label style={labelStyle}>工作目录(cwd)</label>
              <DropUp
                id="jm-cwd-dd"
                className="down"
                value={s.cwd}
                options={cwdOptions.length ? cwdOptions : [s.cwd]}
                onChange={(v) => patch({ cwd: v })}
              />
            </div>
            <div>
              <label style={labelStyle}>模型</label>
              <DropUp id="jm-model-dd" className="down" value={s.model} options={MODELS} onChange={(v) => patch({ model: v })} />
            </div>
          </div>

          {s.kind === 'once' ? (
            <div className="mfield">
              <label>执行时间</label>
              <div className="time-chips">
                {TIME_CHIPS.map(([k, label]) => (
                  <button key={k} className={s.timeChip === k ? 'active' : ''} onClick={() => patch({ timeChip: k })}>
                    {label}
                  </button>
                ))}
                <button className={s.timeChip === 'custom' ? 'active' : ''} onClick={() => patch({ timeChip: 'custom' })}>
                  自定义
                </button>
              </div>
              {s.timeChip === 'custom' && (
                <Input type="datetime-local" value={s.customDate} onChange={(e) => patch({ customDate: e.target.value })} />
              )}
              <div className="hint">
                将在 <b style={{ color: 'var(--jade)' }}>{whenLabel}</b> 执行一次
              </div>
            </div>
          ) : (
            <div className="mfield">
              <label>周期(cron 表达式)</label>
              <div className="time-chips">
                {CRON_CHIPS.map(([expr, label]) => (
                  <button key={expr} className={s.cronChip === expr ? 'active' : ''} onClick={() => patch({ cronChip: expr })}>
                    {label}
                  </button>
                ))}
                <button className={s.cronChip === 'custom' ? 'active' : ''} onClick={() => patch({ cronChip: 'custom' })}>
                  自定义
                </button>
              </div>
              {s.cronChip === 'custom' && <Input className="mono" value={s.cronExpr} onChange={(e) => patch({ cronExpr: e.target.value })} />}
              <div className="hint">croner 解析,支持时区(Asia/Shanghai)</div>
            </div>
          )}

          <div className="mfield two-col">
            <div>
              <label style={labelStyle}>权限模式</label>
              <DropUp
                id="jm-perm-dd"
                className="down"
                value={s.permissionMode}
                options={PERMS}
                labelOf={(v) => PERM_LABEL[v] ?? v}
                onChange={(v) => patch({ permissionMode: v })}
              />
              <div className="hint">保守模式被卡时会弹审批横幅并挂起,你可以随时继续</div>
            </div>
            <div>
              <label style={labelStyle}>预算上限</label>
              <DropUp
                id="jm-budget-dd"
                className="down"
                value={String(s.budget ?? 'unlimited')}
                options={BUDGETS.map(([, v]) => String(v ?? 'unlimited'))}
                labelOf={(v) => BUDGETS.find(([, bv]) => String(bv ?? 'unlimited') === v)?.[0] ?? v}
                onChange={(v) => patch({ budget: v === 'unlimited' ? undefined : Number(v) })}
              />
              <div className="hint">超限自动停,防无人值守跑飞</div>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <span className="msummary">
            {s.kind === 'once' ? '一次性' : '周期'} · <b>{whenLabel}</b> · {s.cwd} · {s.model}
          </span>
          <span className="spacer" />
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            保存任务
          </Button>
        </div>
      </div>
    </>
  );
}

// ---------- 主视图 ----------

export function Crons() {
  const { data, refresh } = usePoll(api.schedules, 15_000);
  const { data: projectsData } = usePoll(api.projects, 60_000);
  const cwdOptions = useMemo(() => (projectsData?.projects ?? []).map((p) => p.path), [projectsData]);

  const [filter, setFilter] = useState<Filter>('all');
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [runsCache, setRunsCache] = useState<Record<string, { runs: ScheduledRun[]; total: number }>>({});
  const [modalJob, setModalJob] = useState<ScheduledJob | 'new' | null>(null);

  const [replay, setReplay] = useState<Replay | null>(null);
  const [replayMeta, setReplayMeta] = useState<{ sessionId: string; cwd: string; status: string; resumable: boolean } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const jobs = data?.jobs ?? [];
  const filtered = jobs.filter((j) => filter === 'all' || j.kind === filter);

  const loadRuns = async (jobId: string, limit?: number) => {
    try {
      const r = await api.scheduleRuns(jobId, limit);
      setRunsCache((prev) => ({ ...prev, [jobId]: r }));
    } catch {
      /* 静默:折叠详情区兜底展示"尚未运行" */
    }
  };

  const toggle = (job: ScheduledJob) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(job.id)) next.delete(job.id);
      else {
        next.add(job.id);
        if (!runsCache[job.id]) void loadRuns(job.id, 7);
      }
      return next;
    });
  };

  const openReplay = async (sessionId: string, meta: { cwd: string; status: string; resumable: boolean }) => {
    setDrawerOpen(true);
    setReplay(null);
    setReplayMeta({ sessionId, ...meta });
    try {
      setReplay(await api.replay(sessionId));
    } catch {
      toast('回放不可用:会话记录不存在或已清理');
      setDrawerOpen(false);
    }
  };

  const resumeToDispatch = (jobName: string, cwd: string, sessionId: string) => {
    setDrawerOpen(false);
    setDispatchIntent({ resume: { sessionId, name: jobName, cwd, project: cwd.split('/').filter(Boolean).pop() ?? cwd } });
    location.hash = 'dispatch';
  };

  const runNow = async (job: ScheduledJob) => {
    try {
      await api.runScheduleNow(job.id);
      toast('已触发一次立即运行');
      refresh();
      if (openIds.has(job.id)) void loadRuns(job.id, 7);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const pauseOrCancel = async (job: ScheduledJob) => {
    const isCron = job.kind === 'cron';
    if (!(await confirmBox(isCron ? `暂停周期任务「${job.name}」?\n到点不再触发,随时可恢复。` : `取消一次性任务「${job.name}」?\n到点不再触发。`))) return;
    try {
      if (isCron) await api.pauseSchedule(job.id);
      else await api.cancelSchedule(job.id);
      toast(isCron ? '已暂停' : '已取消');
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const resumeJob = async (job: ScheduledJob) => {
    try {
      await api.resumeSchedule(job.id);
      toast('已恢复调度');
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (job: ScheduledJob) => {
    if (!(await confirmBox(`删除任务「${job.name}」?\n定义与运行历史一并删除,不可恢复。`))) return;
    try {
      await api.deleteSchedule(job.id);
      toast('已删除');
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="view-head">
        <h1>定时任务</h1>
        <span className="sub">安排未来 / 周期任务,到点由常驻后端自动开一个 Claude 会话执行</span>
        <span className="spacer" />
        <div className="filter-tabs">
          {(
            [
              ['all', '全部'],
              ['once', '一次性'],
              ['cron', '周期'],
            ] as [Filter, string][]
          ).map(([f, label]) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
        <Button variant="primary" onClick={() => setModalJob('new')}>
          ＋ 新建任务
        </Button>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>璇玑调度</h2>
          <span className="sub">croner 调度 · 定义与运行历史存 SQLite · 预算超限 / 连续失败熔断</span>
        </div>
        <div className="sys-note">
          到点运行 = 创建一个真实派发会话:运行中 / 需审批 / 已完成的实例会同步出现在「会话」看板,审批可直接在会话页处理;此处的「结果会话」链接跳转同一份只读回放,不新开会话查询。
        </div>
        {filtered.length === 0 && (
          <Empty>
            <p>{jobs.length === 0 ? '还没有定时任务。' : '该分类下暂无任务。'}</p>
          </Empty>
        )}
        <div>
          {filtered.map((job) => {
            const { when, rel } = whenOf(job);
            const open = openIds.has(job.id);
            const cached = runsCache[job.id];
            const whenColor =
              job.status === 'fused' || job.status === 'missed' || job.status === 'canceled' || job.status === 'paused'
                ? 'var(--faint)'
                : job.status === 'blocked'
                  ? 'var(--amber)'
                  : 'var(--ink)';
            return (
              <div key={job.id} className={`cron-item ${open ? 'open' : ''}`}>
                <div className="cron-row" onClick={() => toggle(job)}>
                  <span className={`pill ${STATE_PILL[job.status].cls}`}>
                    <span className="dot" />
                    {STATE_PILL[job.status].txt}
                  </span>
                  <span className="kind">{job.kind === 'once' ? '一次性' : '周期'}</span>
                  <span className="name">{job.name}</span>
                  <span className="when">
                    {job.kind === 'cron' && cached && cached.runs.length > 0 && (
                      <span className="runline" title="近期运行状态(左旧右新)">
                        {[...cached.runs]
                          .slice(0, 7)
                          .reverse()
                          .map((r) => (
                            <i key={r.id} className={r.status === 'done' ? 'g' : r.status === 'error' ? 'r' : 'a'} />
                          ))}
                      </span>
                    )}
                    <span className="clock" style={{ color: whenColor }}>
                      {when}
                    </span>
                    <span className="rel">{rel}</span>
                  </span>
                </div>
                {open && (
                  <div className="cron-detail">
                    {job.status === 'blocked' && job.resultSessionId && (
                      <div className="notice-amber">
                        <span>◷</span>
                        <span>已挂起等审批:{job.lastError || '会话正在等待权限确认'}。审批横幅已发,你处理后自动继续。</span>
                        <span className="spacer" />
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            void openReplay(job.resultSessionId!, { cwd: job.cwd, status: job.status, resumable: true });
                          }}
                        >
                          去审批
                        </button>
                      </div>
                    )}
                    {job.status === 'fused' && (
                      <div className="fuse-note">
                        <span>⚠</span>
                        <span>
                          连续失败 {job.consecutiveFailures} 次已熔断{job.lastError ? `:${job.lastError}` : ''}。修复后手动恢复调度。
                        </span>
                        <button
                          className="btn btn-sm"
                          style={{ marginLeft: 'auto' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            void resumeJob(job);
                          }}
                        >
                          恢复
                        </button>
                      </div>
                    )}
                    {job.status === 'missed' && (
                      <div className="notice-amber">
                        <span>◷</span>
                        <span>电脑睡眠错过触发,且超出 30 分钟补跑宽限期,已标记为「已错过」。</span>
                        <button
                          className="btn btn-sm"
                          style={{ marginLeft: 'auto' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            void runNow(job);
                          }}
                        >
                          立即补跑
                        </button>
                      </div>
                    )}
                    <div className="cron-meta">
                      <span>
                        目录 <b className="mono">{job.cwd}</b>
                      </span>
                      <span>
                        模型 <b>{job.model ?? '默认'}</b>
                      </span>
                      <span>
                        权限 <b>{PERM_LABEL[job.permissionMode] ?? job.permissionMode}</b>
                      </span>
                      <span>
                        预算 <b>{job.maxBudgetUsd != null ? `$${job.maxBudgetUsd} / 次` : '不限'}</b>
                      </span>
                      <span>
                        执行 <b>Agent SDK 会话</b>
                      </span>
                    </div>
                    <div className="prompt">{job.prompt}</div>
                    {!cached || cached.runs.length === 0 ? (
                      <div style={{ fontSize: '0.75rem', color: 'var(--faint)', padding: '4px 0' }}>尚未运行,无历史记录。</div>
                    ) : (
                      <>
                        <table className="runs">
                          <thead>
                            <tr>
                              <th>{job.kind === 'cron' ? '周期(计划时间)' : '时间'}</th>
                              <th>耗时</th>
                              <th>成本</th>
                              <th>结果会话 / 日志</th>
                              <th>状态</th>
                            </tr>
                          </thead>
                          <tbody>
                            {cached.runs.map((r) => (
                              <tr key={r.id}>
                                <td>
                                  {new Date(r.scheduledFor).toLocaleString('zh-CN', {
                                    month: 'numeric',
                                    day: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    hour12: false,
                                  })}
                                  {r.error && <div style={{ color: 'var(--red)', fontSize: '0.6875rem', marginTop: 2 }}>{r.error}</div>}
                                </td>
                                <td>{r.durationMs != null ? `${Math.round(r.durationMs / 1000)}s` : r.status === 'running' ? '进行中' : '—'}</td>
                                <td>{r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : '—'}</td>
                                <td>
                                  {r.sessionId ? (
                                    <button
                                      className="sid"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void openReplay(r.sessionId!, {
                                          cwd: job.cwd,
                                          status: r.status,
                                          resumable: r.status === 'blocked' || r.status === 'running',
                                        });
                                      }}
                                    >
                                      {r.sessionId.slice(0, 8)} · 查看日志
                                    </button>
                                  ) : (
                                    '—'
                                  )}
                                </td>
                                <td>
                                  {r.status === 'done' && (
                                    <span className="pill pill-done">
                                      <span className="dot" />
                                      成功
                                    </span>
                                  )}
                                  {r.status === 'running' && (
                                    <span className="pill pill-run">
                                      <span className="dot" />
                                      运行中
                                    </span>
                                  )}
                                  {r.status === 'blocked' && (
                                    <span className="pill pill-blk">
                                      <span className="dot" />
                                      审批中
                                    </span>
                                  )}
                                  {r.status === 'missed' && (
                                    <span className="pill pill-blk">
                                      <span className="dot" />
                                      错过
                                    </span>
                                  )}
                                  {r.status === 'error' && (
                                    <span className="pill pill-err">
                                      <span className="dot" />
                                      失败
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {cached.total > cached.runs.length && (
                          <button className="runs-more" onClick={() => void loadRuns(job.id, cached.total)}>
                            查看全部 {cached.total} 期运行 →
                          </button>
                        )}
                      </>
                    )}
                    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                      <button
                        className="btn btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          void runNow(job);
                        }}
                      >
                        立即运行
                      </button>
                      <button
                        className="btn btn-sm btn-quiet"
                        disabled={job.status === 'running' || job.status === 'blocked'}
                        onClick={(e) => {
                          e.stopPropagation();
                          setModalJob(job);
                        }}
                      >
                        编辑
                      </button>
                      {(job.status === 'pending' || (job.kind === 'cron' && job.status !== 'canceled')) && (
                        <button
                          className="btn btn-sm btn-quiet"
                          onClick={(e) => {
                            e.stopPropagation();
                            void pauseOrCancel(job);
                          }}
                        >
                          {job.kind === 'once' ? '取消' : '暂停'}
                        </button>
                      )}
                      <button
                        className="btn btn-sm btn-danger"
                        style={{ marginLeft: 'auto' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(job);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {modalJob && <JobModal job={modalJob} cwdOptions={cwdOptions} onClose={() => setModalJob(null)} onSaved={refresh} />}

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={replay?.title ?? '定时任务运行'}
        meta={
          replayMeta && (
            <>
              <span className="tag">◷ 定时触发</span>
              <span className="mono">{replayMeta.cwd}</span>
              <span className="mono">session {replayMeta.sessionId}</span>
            </>
          )
        }
        foot={
          <>
            {replayMeta?.resumable && (
              <button
                className="btn btn-sm btn-primary"
                onClick={() => resumeToDispatch(replay?.title ?? '定时任务', replayMeta.cwd, replayMeta.sessionId)}
              >
                {replayMeta.status === 'blocked' ? '去处理审批' : '续接此会话(--resume)'}
              </button>
            )}
            <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
              只读回放 · source of truth 在 ~/.claude,不新开会话查询
              {replay && replay.skippedLines > 0 && ` · ${replay.skippedLines} 行无法解析已跳过`}
            </span>
          </>
        }
      >
        {!replay && (
          <Empty>
            <p>回放加载中…</p>
          </Empty>
        )}
        {replay?.events.map((ev, i) => {
          if (ev.kind === 'tool') return <ToolCard key={i} {...ev} />;
          if (ev.kind === 'compact') return <CompactionCard key={i} {...ev} />;
          if (ev.kind === 'raw')
            return (
              <div className="raw-event" key={i}>
                <div className="note">⚠ 未知事件类型「{ev.type}」,已按原始文本降级展示(adapter 兜底)</div>
                {ev.json}
              </div>
            );
          return (
            <div className="replay-msg" key={i}>
              <div className={`who ${ev.kind === 'user' ? 'u' : ''}`}>{ev.kind === 'user' ? '你' : 'Claude'}</div>
              {ev.kind === 'assistant' ? (
                <div className="body md">
                  <Md>{ev.text}</Md>
                </div>
              ) : (
                <div className="body">{ev.text}</div>
              )}
            </div>
          );
        })}
        {replay && replay.events.length === 0 && (
          <Empty>
            <p>此会话没有可回放的事件。</p>
          </Empty>
        )}
      </Drawer>
    </>
  );
}
