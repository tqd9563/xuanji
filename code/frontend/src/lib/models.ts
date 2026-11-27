/**
 * 模型目录:派发页模型下拉 / ⌘M 切换面板 / 设置页默认模型的候选。
 *
 * 来源是后端 `/api/models`(即 CLI `/model` 面板那份,由 SDK supportedModels() 报告),
 * 不再写死模型名 —— CLI 每升一版就要手改一次前端、且改之前面板里看不到新模型。
 * FALLBACK 只在后端还没拉到目录时顶一下(全新安装、探测失败),内容是 2026-09 的一份快照。
 *
 * 值域约定:
 * - 选项值 = 目录行的 value(多为别名,如 `opus[1m]` / `sonnet`),它跟着 CLI 升级自动改指向;
 *   `default` 行 = CLI 当前默认模型,发给 SDK 时不传 model(见 toSdkModel)。
 * - 持久化的旧值可能是完整 id(如 `claude-opus-5[1m]`):按 resolvedModel 反查回目录行;
 *   查不到但长得像完整 id 的,原样保留为「手输值」——目录只列 CLI 想展示的几行,
 *   200K 的 opus 这类仍可用但不在目录里的模型靠这条旁路选。
 */
import { useEffect, useState } from 'react';
import { api } from '@/api/client';

/** 与后端 services/models.ts 的 ModelInfo 同形 */
export interface ModelOption {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  effortLevels?: string[];
}

/** `default` 行:CLI 当前默认模型 */
export const DEFAULT_MODEL = 'default';

/** 后端目录为空时的兜底(2026-11-10 SDK 自带 CLI 2.1.321 快照,只取前 5 行) */
export const FALLBACK_MODELS: ModelOption[] = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks' },
  { value: 'fable', resolvedModel: 'claude-fable-5-2', displayName: 'Fable 5.2', description: 'For your toughest challenges' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Most efficient for simpler tasks' },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'Fastest for quick answers' },
];

/** 长得像完整模型 id:`claude-` 开头,可带 `[1m]` 后缀 */
export function looksLikeModelId(v: string): boolean {
  return /^claude-[a-z0-9.-]+(\[1m\])?$/i.test(v.trim());
}

/** 按 value / resolvedModel / 显示名(不分大小写)找目录行 */
export function findModel(catalog: ModelOption[], v: string | null | undefined): ModelOption | undefined {
  if (!v) return undefined;
  const q = v.trim().toLowerCase();
  if (!q) return undefined;
  return (
    catalog.find((m) => m.value.toLowerCase() === q) ??
    catalog.find((m) => m.resolvedModel?.toLowerCase() === q) ??
    catalog.find((m) => m.displayName.toLowerCase() === q)
  );
}

/**
 * 把持久化/用户输入的值归一成选项值:目录里有 → 该行 value;
 * 不在目录但像完整 id → 原样(手输旁路);其余 → null(调用方回落默认)。
 */
export function normalizeModelValue(catalog: ModelOption[], v: string | null | undefined): string | null {
  if (!v) return null;
  const hit = findModel(catalog, v);
  if (hit) return hit.value;
  return looksLikeModelId(v) ? v.trim() : null;
}

/** 模型家族(按解析到的真实 id 判),认不出返回 null */
function familyOf(m: ModelOption): string | null {
  return /\b(opus|fable|sonnet|haiku)\b/i.exec((m.resolvedModel ?? m.value).replace(/-/g, ' '))?.[1]?.toLowerCase() ?? null;
}

/**
 * 主列表的目录行:CLI 2.1.29x 起 supportedModels() 除了 `opus`/`fable` 这类别名行,还会附带一串
 * 钉死版本的完整 id 行(claude-fable-5-1、claude-opus-4-8…)。同家族已有别名行时,完整 id 行
 * 属于「旧版本」,不进默认列表,只在搜索时出现(见 olderModels);家族没有别名行时
 * (如 2.1.280 目录里的 `claude-fable-5-1[1m]`)它就是该家族唯一入口,照常显示。
 */
export function primaryModels(catalog: ModelOption[]): ModelOption[] {
  const aliased = new Set(
    catalog.filter((m) => m.value !== DEFAULT_MODEL && !looksLikeModelId(m.value)).map(familyOf).filter(Boolean),
  );
  return catalog.filter((m) => !looksLikeModelId(m.value) || !aliased.has(familyOf(m)));
}

/** 被 primaryModels 收起的旧版本行(搜索时才出现) */
export function olderModels(catalog: ModelOption[]): ModelOption[] {
  const primary = new Set(primaryModels(catalog));
  return catalog.filter((m) => !primary.has(m));
}

/** 发给 SDK 的 model:`default` 行不传(交给 CLI 默认),其余原样 */
export function toSdkModel(v: string): string | undefined {
  return v === DEFAULT_MODEL ? undefined : v;
}

/** 面板左列短名:目录行用显示名,手输值原样 */
export function modelLabel(catalog: ModelOption[], v: string): string {
  return findModel(catalog, v)?.displayName ?? v;
}

/** 面板右列 / 下拉说明:该行解析到的真实 id;手输值自身就是 id */
export function modelDetail(catalog: ModelOption[], v: string): string {
  const hit = findModel(catalog, v);
  return hit?.resolvedModel ?? hit?.value ?? v;
}

/**
 * 「自动」思考档的落点:opus 系列默认 low(opus 思考本身很深,日常派发 low 已够且更省额度),
 * 其余不下发、交给模型自身默认(通常 high)。判定看解析到的真实 id,别名/手输值同样适用。
 */
export function defaultEffortOf(catalog: ModelOption[], v: string): string | undefined {
  const real = modelDetail(catalog, v).toLowerCase();
  return real.includes('opus') ? 'low' : undefined;
}

/** 目录(后端缓存 → 兜底);挂载时取一次,`refresh` 让调用方在会话 init 后再拉(CLI 可能刚升级) */
export function useModelCatalog(): { models: ModelOption[]; fromServer: boolean; refresh: () => void } {
  const [models, setModels] = useState<ModelOption[]>(FALLBACK_MODELS);
  const [fromServer, setFromServer] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    void api
      .models()
      .then((r) => {
        if (!alive || !r.models.length) return;
        setModels(r.models);
        setFromServer(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tick]);
  return { models, fromServer, refresh: () => setTick((t) => t + 1) };
}
