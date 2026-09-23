/**
 * 模型目录:派发页模型选择器的候选,来源只有 Agent SDK 的 `query.supportedModels()`
 * (即 CLI `/model` 面板那份:别名、解析到的真实 id、显示名、说明、思考档)。
 *
 * 不再在前端写死模型名 —— 每次 CLI 升级都要手改一次前端,且改之前用户在面板里
 * 看不到新模型(2026-09-23 Opus 5.5 即此)。目录跟 CLI 走,CLI 升级、后端重启即自动跟上。
 *
 * 两条刷新路径:
 *  - 每个派发会话 init 之后顺手拉一次(零成本,与斜杠命令目录同款);
 *  - 后端启动时若缓存的 CLI 版本与当前不一致,起一个不发消息的空会话专门拉一次
 *    (实测 ~8s、0 token),这样升级 CLI 后打开面板不用先派发一个会话才能看到新模型。
 * 目录落 meta 表(单键 JSON),重启后立刻可用;fresh=false 表示这是缓存而非本次会话报的。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { cliVersion } from '../adapters/agents-cli.js';
import type { Storage } from '../storage/db.js';

const META_KEY = 'model-catalog';

/** 与前端 lib/models.ts 的 ModelOption 同形 */
export type ModelInfo = {
  /** 传给 SDK 的值(多为别名,如 `opus[1m]` / `sonnet`;`default` = CLI 当前默认) */
  value: string;
  /** 别名解析到的真实 id(如 `claude-opus-5-5[1m]`),持久化的完整 id 靠它反查行 */
  resolvedModel?: string;
  displayName: string;
  description: string;
  /** 该模型支持的思考档;缺省 = 不支持 effort */
  effortLevels?: string[];
};

export interface ModelCatalog {
  models: ModelInfo[];
  /** 拉取目录时的 CLI 版本(`claude --version` 首行);null = 未探测到 */
  cliVersion: string | null;
  at: number;
}

/** SDK 报的 ModelInfo 形状(只取用得到的字段,其余透传丢弃) */
type RawModel = {
  value?: unknown;
  resolvedModel?: unknown;
  displayName?: unknown;
  description?: unknown;
  supportedEffortLevels?: unknown;
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** 整理 SDK 报的目录:丢掉没有 value 的行、value 去重;缺显示名用 value 顶 */
export function normalizeModelCatalog(raw: unknown): ModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const r of raw as RawModel[]) {
    const value = str(r?.value);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const resolved = str(r.resolvedModel);
    const levels = Array.isArray(r.supportedEffortLevels)
      ? r.supportedEffortLevels.filter((x): x is string => typeof x === 'string' && x.length > 0)
      : [];
    out.push({
      value,
      ...(resolved ? { resolvedModel: resolved } : {}),
      displayName: str(r.displayName) || value,
      description: str(r.description),
      ...(levels.length ? { effortLevels: levels } : {}),
    });
  }
  return out;
}

/** 进程内最新一份(会话报的即时值);进程重启后由 meta 表补回 */
let live: ModelCatalog | null = null;

export function rememberModelCatalog(storage: Storage, models: ModelInfo[], version: string | null): void {
  if (!models.length) return;
  live = { models, cliVersion: version, at: Date.now() };
  storage.setMeta(META_KEY, JSON.stringify(live));
}

export function cachedModelCatalog(storage: Storage): ModelCatalog | null {
  if (live) return live;
  const raw = storage.getMeta(META_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ModelCatalog>;
    const models = normalizeModelCatalog(parsed.models);
    if (!models.length) return null;
    live = {
      models,
      cliVersion: typeof parsed.cliVersion === 'string' ? parsed.cliVersion : null,
      at: typeof parsed.at === 'number' ? parsed.at : 0,
    };
    return live;
  } catch {
    return null;
  }
}

/** 测试用:清掉进程内缓存 */
export function resetModelCatalogForTest(): void {
  live = null;
}

/**
 * 不发消息、只为拿目录的空会话:输入流永不产出,拿到 supportedModels 就关。
 * 之所以能 0 token:控制协议的 initialize 在第一条用户消息之前就完成,目录随之可查。
 */
export async function probeModelCatalog(): Promise<ModelInfo[]> {
  async function* never(): AsyncGenerator<never> {
    await new Promise<never>(() => {});
  }
  const q = query({
    prompt: never() as never,
    options: { cwd: process.cwd(), permissionMode: 'plan', env: { ...process.env, XUANJI_DISPATCH: '1' } },
  });
  try {
    if (typeof q.supportedModels !== 'function') return [];
    return normalizeModelCatalog(await q.supportedModels());
  } finally {
    // 旧 SDK 无 close;有则关掉子进程,别留一个空转的 CLI
    (q as { close?: () => void }).close?.();
  }
}

/**
 * 启动预热:缓存里的目录是别的 CLI 版本拉的(或压根没有)才探测,版本一致则零开销。
 * 探测失败只记日志 —— 前端有写死的兜底清单,少的只是新模型那几行。
 */
export async function warmModelCatalog(storage: Storage): Promise<'hit' | 'refreshed' | 'failed'> {
  const version = await cliVersion();
  const cached = cachedModelCatalog(storage);
  if (cached && version && cached.cliVersion === version) return 'hit';
  try {
    const models = await probeModelCatalog();
    if (!models.length) return 'failed';
    rememberModelCatalog(storage, models, version);
    return 'refreshed';
  } catch (e) {
    console.error('[xuanji] model catalog probe failed:', e instanceof Error ? e.message : e);
    return 'failed';
  }
}
