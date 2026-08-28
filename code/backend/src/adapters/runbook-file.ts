/**
 * 验收清单文件 adapter:读 worktree 内的 `.xuanji/runbook.json`。
 *
 * 归属:这是「派发会话写给璇玑看」的自有约定格式,不属于 ~/.claude,故读它不违反只读铁律;
 * 但解析仍收在 adapter 层(铁律 1 的一致性)——上层只拿归一化后的内部模型,
 * 格式演进(schemaVersion)只改这里。
 *
 * 容错取向:清单是「锦上添花」的交付元数据,任何解析失败都不该让派发页出错。
 * 一律降级为「没有清单」(面板不出现 = 现状体验),并把原因记进 warning 供排查。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AcceptanceRunbook, RunbookItem, RunbookItemType } from '../types.js';

export const RUNBOOK_REL_PATH = path.join('.xuanji', 'runbook.json');

const ITEM_TYPES: RunbookItemType[] = ['service', 'command', 'request', 'link', 'cleanup'];

export interface RunbookFileResult {
  runbook: AcceptanceRunbook | null;
  /** 解析失败/被忽略的原因;runbook 为 null 且有 warning 才是「本该有却没读成」 */
  warning?: string;
  /** 清单文件的最后修改时刻(ms)。归属判定靠它区分「本次交付写的」与「上次交付留下的」 */
  mtimeMs?: number;
}

/** 未知 type 的项不丢弃也不执行——渲染成只读文本,由前端呈现(schema 前向兼容) */
function normalizeItem(raw: unknown, defaultOrigin: 'template' | 'session'): RunbookItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (typeof o.title !== 'string' || !o.title) return null;
  const type = ITEM_TYPES.includes(o.type as RunbookItemType) ? (o.type as RunbookItemType) : 'command';
  const item: RunbookItem = {
    id: o.id,
    type,
    title: o.title,
    origin: o.origin === 'template' || o.origin === 'session' ? o.origin : defaultOrigin,
  };
  if (typeof o.description === 'string') item.description = o.description;
  if (typeof o.command === 'string') item.command = o.command;
  if (typeof o.cwd === 'string') item.cwd = o.cwd;
  if (typeof o.stopCommand === 'string') item.stopCommand = o.stopCommand;
  if (typeof o.timeoutSec === 'number') item.timeoutSec = o.timeoutSec;
  if (Array.isArray(o.dependsOn)) item.dependsOn = o.dependsOn.filter((x): x is string => typeof x === 'string');
  if (Array.isArray(o.params)) item.params = o.params as RunbookItem['params'];
  if (o.env && typeof o.env === 'object') item.env = o.env as Record<string, string>;
  if (o.readiness && typeof o.readiness === 'object') item.readiness = o.readiness as RunbookItem['readiness'];
  if (Array.isArray(o.links)) item.links = o.links as RunbookItem['links'];
  // request 专用
  if (typeof o.method === 'string') item.method = o.method as RunbookItem['method'];
  if (typeof o.url === 'string') item.url = o.url;
  if (o.headers && typeof o.headers === 'object') item.headers = o.headers as Record<string, string>;
  if (typeof o.body === 'string') item.body = o.body;
  if (typeof o.expect === 'string') item.expect = o.expect;
  return item;
}

/** 解析清单对象(已是 JS 对象);独立导出便于测试与将来从别处喂入 */
export function parseRunbook(raw: unknown): RunbookFileResult {
  if (!raw || typeof raw !== 'object') return { runbook: null, warning: '清单不是对象' };
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== 1) {
    return { runbook: null, warning: `不支持的 schemaVersion:${String(o.schemaVersion)}` };
  }
  const rb: AcceptanceRunbook = { schemaVersion: 1 };

  if (typeof o.sessionId === 'string' && o.sessionId) rb.sessionId = o.sessionId;

  const ref = o.templateRef as Record<string, unknown> | undefined;
  if (ref && typeof ref.id === 'string' && typeof ref.version === 'number') {
    rb.templateRef = { id: ref.id, version: ref.version };
  }
  if (o.paramValues && typeof o.paramValues === 'object') {
    rb.paramValues = o.paramValues as AcceptanceRunbook['paramValues'];
  }
  if (Array.isArray(o.omitItems)) {
    rb.omitItems = o.omitItems.filter((x): x is string => typeof x === 'string');
  }
  if (Array.isArray(o.extraItems)) {
    // extraItems 的 origin 恒为 session:它没经过用户确认入库,首次执行要弹确认
    rb.extraItems = o.extraItems
      .map((x) => normalizeItem(x, 'session'))
      .filter((x): x is RunbookItem => x !== null)
      .map((x) => ({ ...x, origin: 'session' as const }));
  }
  if (typeof o.notes === 'string') rb.notes = o.notes;

  const empty = !rb.templateRef && !rb.extraItems?.length;
  if (empty) return { runbook: null, warning: '清单既无 templateRef 也无 extraItems' };
  return { runbook: rb };
}

/**
 * 从会话 worktree 读清单。文件不存在是**正常情况**(项目不需要验收面板),
 * 返回 runbook=null 且不带 warning——调用方据此静默不渲染面板。
 */
export function readRunbookFile(sessionCwd: string): RunbookFileResult {
  const file = path.join(sessionCwd, RUNBOOK_REL_PATH);
  let text: string;
  let mtimeMs: number | undefined;
  try {
    text = fs.readFileSync(file, 'utf8');
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return { runbook: null };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { runbook: null, warning: `清单 JSON 解析失败:${e instanceof Error ? e.message : String(e)}` };
  }
  return { ...parseRunbook(json), mtimeMs };
}

/**
 * 把归属会话盖回清单文件(见 AcceptanceRunbook.sessionId)。
 * 只补 sessionId 一个字段,其余内容原样保留——清单是会话写的,璇玑不改它的内容。
 * 尽力而为:worktree 只读、文件被删等一切失败都只返回 false,不影响面板渲染。
 */
export function stampRunbookSession(sessionCwd: string, sessionId: string): boolean {
  const file = path.join(sessionCwd, RUNBOOK_REL_PATH);
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (json.sessionId === sessionId) return true;
    fs.writeFileSync(file, `${JSON.stringify({ ...json, sessionId }, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
