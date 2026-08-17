import { config } from '../config.js';
import { listAgents } from '../adapters/agents-cli.js';
import { findSessionFile, parseReplay, readJobStates } from '../adapters/claude-dir.js';
import { dispatchBoardState, liveDispatches } from './dispatch.js';
import { statusPatch } from './todos.js';
import type { AgentSession, Replay, SessionState } from '../types.js';
import type { Storage } from '../storage/db.js';

export interface SessionsBoard {
  ok: boolean;
  error?: string;
  columns: Record<SessionState, AgentSession[]>;
  refreshedAt: number;
}

export async function sessionsBoard(storage?: Storage): Promise<SessionsBoard> {
  const [agents, jobStates] = await Promise.all([listAgents(), readJobStates(config.claudeDir)]);
  const names = storage?.sessionNames();
  const webIds = storage?.webDispatchedIds();
  const hidden = storage?.hiddenSessionIds();
  const columns: Record<SessionState, AgentSession[]> = {
    idle: [],
    running: [],
    blocked: [],
    review: [],
    done: [],
  };
  // 本进程存活的派发会话:agents CLI 把它们列为 interactive+活 pid(名字还是自动生成的),
  // 用注册表的实时状态/会话名/attach 入口覆盖,CLI 尚未收录的补充合成卡
  const live = new Map(liveDispatches().map((d) => [d.sessionId, d]));
  for (const s of agents.sessions) {
    if (hidden?.has(s.sessionId)) continue; // 用户已「关闭」:仅从看板隐藏,~/.claude 数据不动
    const job = jobStates.get(s.id);
    if (job) {
      s.detail = job.detail;
      s.needs = job.needs;
      s.tokens = job.tokens;
      s.lastOutputAt = job.updatedAt;
    }
    const d = live.get(s.sessionId);
    if (d) {
      live.delete(s.sessionId);
      s.name = d.name;
      s.state = dispatchBoardState(d.state);
      s.readonly = false;
      s.source = 'web';
      s.dispatchId = d.dispatchId;
      s.lastOutputAt = d.lastOutputAt;
      if (d.state === 'awaiting-permission') {
        s.needs = d.detail === '回答 Claude 的提问' ? d.detail : `等待权限审批:${d.detail ?? ''}`;
      } else {
        s.needs = undefined;
        if (d.detail) s.detail = d.detail; // 运行中=正在做什么 / 空闲=最后产出摘要
      }
    }
    const override = names?.get(s.sessionId);
    if (override) s.name = override;
    if (webIds?.has(s.sessionId)) s.source = 'web';
    columns[s.state].push(s);
  }
  const seen = new Set(agents.sessions.map((s) => s.sessionId));
  for (const d of live.values()) {
    if (hidden?.has(d.sessionId)) continue;
    seen.add(d.sessionId);
    columns[dispatchBoardState(d.state)].push({
      id: d.sessionId.slice(0, 8),
      sessionId: d.sessionId,
      name: names?.get(d.sessionId) ?? d.name,
      cwd: d.cwd,
      project: d.cwd.split('/').filter(Boolean).pop() ?? d.cwd,
      kind: 'background',
      state: dispatchBoardState(d.state),
      startedAt: d.startedAt,
      readonly: false,
      detail: d.state === 'awaiting-permission' ? undefined : d.detail,
      needs:
        d.state === 'awaiting-permission'
          ? d.detail === '回答 Claude 的提问'
            ? d.detail
            : `等待权限审批:${d.detail ?? ''}`
          : undefined,
      source: 'web',
      dispatchId: d.dispatchId,
      lastOutputAt: d.lastOutputAt,
    });
  }
  // 历史 web 派发会话:进程已退出且 agents CLI 不再列出的,从自有 dispatches 表补回。
  // 死于后端重启的(快照非 ended)按「空闲」还原——上下文在转录里,点开发消息即原地续接;
  // 待验收标记与活动摘要一并从快照恢复。
  for (const row of storage?.allDispatches() ?? []) {
    if (seen.has(row.sessionId) || hidden?.has(row.sessionId)) continue;
    const wasAlive = !!row.lastState && row.lastState !== 'ended';
    columns[wasAlive ? 'idle' : 'done'].push({
      id: row.sessionId.slice(0, 8),
      sessionId: row.sessionId,
      name: names?.get(row.sessionId) ?? row.name ?? row.sessionId.slice(0, 8),
      cwd: row.cwd,
      project: row.cwd.split('/').filter(Boolean).pop() ?? row.cwd,
      kind: 'background',
      state: wasAlive ? 'idle' : 'done',
      startedAt: row.createdAt,
      readonly: false,
      detail: row.activity ?? undefined,
      lastOutputAt: row.lastOutputAt ?? undefined,
      source: 'web',
    });
  }
  applyArchives(columns, storage);
  promoteReview(columns, storage);
  syncTodosWithBoard(columns, agents.ok, storage);
  for (const col of Object.values(columns)) col.sort((a, b) => b.startedAt - a.startedAt);
  return { ok: agents.ok, error: agents.error, columns, refreshedAt: Date.now() };
}

/**
 * 待办状态跟着挂靠会话走:进行中的待办,其会话已归档进 done 列、或已从看板上
 * 彻底消失(被关闭/转录被清理/老到掉出列表)→ 自动转「已完成」。
 * 仍在 idle/running/blocked/review 的会话不动待办——会话没跑完或还没验收,事就没算完。
 * agents CLI 失败(ok=false)时列表可能残缺,「消失」不可信,整轮跳过防误判。
 */
export function syncTodosWithBoard(columns: Record<SessionState, AgentSession[]>, ok: boolean, storage?: Storage) {
  if (!storage || !ok) return;
  const active = new Set<string>();
  for (const state of ['idle', 'running', 'blocked', 'review'] as const) {
    for (const s of columns[state]) active.add(s.sessionId);
  }
  for (const t of storage.listTodos()) {
    if (t.status !== 'doing' || !t.sessionId) continue;
    if (!active.has(t.sessionId)) storage.updateTodo(t.id, statusPatch('done'));
  }
}

/**
 * 套用手动归档覆盖:把用户拖到「已完成」的卡从推导列搬到 done。
 *
 * 自动失效两条件(命中任一即删除归档记录,卡片回归推导态):
 *  1) 推导态是 running / blocked —— 会话正在跑或在等你,归档显然过期了;
 *  2) lastOutputAt 比归档时前进 —— 你进去接着聊过,轮询间隙里它可能已经聊完又回到 idle,
 *     只看状态会漏判,故以产出时间兜底。
 * 归档态本身是 done 的会话不改归属,但保留记录以便前端给撤销入口。
 */
function applyArchives(columns: Record<SessionState, AgentSession[]>, storage?: Storage) {
  const archives = storage?.sessionArchives();
  if (!archives?.size) return;
  for (const state of Object.keys(columns) as SessionState[]) {
    const keep: AgentSession[] = [];
    for (const s of columns[state]) {
      const a = archives.get(s.sessionId);
      if (!a) {
        keep.push(s);
        continue;
      }
      const revived =
        state === 'running' || state === 'blocked' || (s.lastOutputAt ?? 0) > a.markedLastOutputAt;
      if (revived) {
        storage?.unarchiveSession(s.sessionId);
        keep.push(s);
        continue;
      }
      s.archived = true;
      if (state === 'done') keep.push(s);
      else {
        s.state = 'done';
        columns.done.push(s);
      }
    }
    columns[state] = keep;
  }
}

/**
 * 把「跑完了但还没处置」的会话从 idle/done 提升到验收中。
 *
 * 收进验收中的四个条件(全满足):
 *  1) 推导态是 idle 或 done —— running/blocked 是真实进行态,没什么可验收;
 *  2) 有 lastOutputAt 且晚于启用基线 —— 从没产出的会话不占验收位,
 *     基线以前的历史存量也不倒灌(否则功能上线当天验收列直接堆几十张);
 *  3) 不是终端存活的只读会话 —— 那是别人的会话,璇玑只旁观不验收;
 *  4) 未被显式处置 —— 归档(archived)= 已验收,挂起(suspends)= 看过暂不处理。
 *
 * 挂起与归档同构地自动失效:挂起后会话又有新产出,说明它重新需要你,撤销挂起回验收中。
 */
function promoteReview(columns: Record<SessionState, AgentSession[]>, storage?: Storage) {
  if (!storage) return;
  const baseline = storage.reviewBaseline();
  const suspends = storage.sessionSuspends();
  for (const state of ['idle', 'done'] as const) {
    const keep: AgentSession[] = [];
    for (const s of columns[state]) {
      if (s.archived || s.readonly || !s.lastOutputAt || s.lastOutputAt <= baseline) {
        keep.push(s);
        continue;
      }
      const sus = suspends.get(s.sessionId);
      if (sus) {
        if (s.lastOutputAt <= sus.markedLastOutputAt) {
          // 挂起仍然有效:留在空闲停车场,并打标让前端给「回验收」入口
          s.suspended = true;
          if (state === 'idle') keep.push(s);
          else {
            s.state = 'idle';
            columns.idle.push(s);
          }
          continue;
        }
        storage.unsuspendSession(s.sessionId); // 有新产出 → 挂起过期
      }
      s.state = 'review';
      columns.review.push(s);
    }
    columns[state] = keep;
  }
}

export async function sessionReplay(sessionId: string): Promise<Replay | null> {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return null; // 路径注入防护
  const file = await findSessionFile(config.claudeDir, sessionId);
  if (!file) return null;
  return parseReplay(file, sessionId);
}

export interface ClosedSession {
  sessionId: string;
  name: string;
  cwd: string;
  project: string;
  hiddenAt: number;
}

/**
 * 已关闭(隐藏)会话清单:/resume 弹窗数据源,按关闭时间倒序。
 * 元数据与看板同源:自有 dispatches 表优先(web 派发必有记录),agents CLI 补全终端来源;
 * display-name 覆盖同样生效。元数据已不可寻的(会话记录被清理)不展示,避免恢复出一张空卡。
 */
export async function closedSessions(storage: Storage, cwd?: string): Promise<ClosedSession[]> {
  const rows = storage.hiddenSessions();
  if (rows.length === 0) return [];
  const hiddenIds = new Set(rows.map((r) => r.sessionId));
  const meta = new Map<string, { name: string; cwd: string }>();
  for (const d of storage.allDispatches()) {
    if (hiddenIds.has(d.sessionId)) {
      meta.set(d.sessionId, { name: d.name ?? d.sessionId.slice(0, 8), cwd: d.cwd });
    }
  }
  const agents = await listAgents();
  for (const s of agents.sessions) {
    if (hiddenIds.has(s.sessionId) && !meta.has(s.sessionId)) {
      meta.set(s.sessionId, { name: s.name, cwd: s.cwd });
    }
  }
  const names = storage.sessionNames();
  const out: ClosedSession[] = [];
  for (const row of rows) {
    const m = meta.get(row.sessionId);
    if (!m) continue;
    if (cwd && m.cwd !== cwd) continue;
    out.push({
      sessionId: row.sessionId,
      name: names.get(row.sessionId) ?? m.name,
      cwd: m.cwd,
      project: m.cwd.split('/').filter(Boolean).pop() ?? m.cwd,
      hiddenAt: row.hiddenAt,
    });
  }
  return out.sort((a, b) => b.hiddenAt - a.hiddenAt);
}
