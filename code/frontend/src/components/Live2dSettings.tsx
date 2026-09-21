/**
 * 看板娘设置字段组(「设置 › 外观 › 看板娘」)。
 *
 * 模型来自 ~/.xuanji/live2d,由后端扫描目录得到——用户从 nizima / BOOTH 下载的包
 * 解压丢进去即可。缩略图在浏览器里渲染一次后缓存进 IndexedDB:Node 端没有 WebGL,
 * 这件事只能前端做。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { SettingsRow } from '@/components/Settings';
import { toast } from '@/components/shared';
import {
  getThumbUrl,
  LIVE2D_SIZES,
  pruneThumbs,
  putThumb,
  type Live2dSide,
  type Live2dState,
  type Live2dTalk,
} from '@/lib/live2d';
import { describeCaps, fetchCaps, renderThumb, type ModelCaps } from '@/lib/live2d-render';

export interface Live2dModelEntry {
  name: string;
  entry: string;
  fingerprint: string;
}

const SIZE_LABELS: Record<number, string> = { 200: '小', 300: '中', 400: '大' };
const SIDES: { v: Live2dSide; label: string }[] = [
  { v: 'left', label: '左下' },
  { v: 'right', label: '右下' },
];
const TALKS: { v: Live2dTalk; label: string }[] = [
  { v: 'mute', label: '不说话' },
  { v: 'event', label: '仅事件' },
  { v: 'chat', label: '事件+闲聊' },
];

function Tabs<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { v: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="filter-tabs" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.v)} className={value === o.v ? 'active' : ''} aria-pressed={value === o.v} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Live2dFields({
  state,
  patch,
  hit,
}: {
  state: Live2dState;
  patch: (p: Partial<Live2dState>) => void;
  hit: (...text: (string | undefined)[]) => boolean;
}) {
  const [models, setModels] = useState<Live2dModelEntry[]>([]);
  const [dir, setDir] = useState('');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [caps, setCaps] = useState<ModelCaps | null>(null);
  const [loadingCaps, setLoadingCaps] = useState(false);
  const urlsRef = useRef<string[]>([]);
  const thumbGenRef = useRef(0);

  const off = !state.enabled;
  const current = state.model || models[0]?.name || '';

  useEffect(() => {
    let alive = true;
    fetch('/api/live2d/models')
      .then((r) => r.json())
      .then((d: { models?: Live2dModelEntry[]; dir?: string }) => {
        if (!alive) return;
        setModels(d.models ?? []);
        setDir(d.dir ?? '');
        void pruneThumbs(d.models ?? []);
      })
      .catch(() => {
        /* 列表拉不到就显示空态,不打断设置面板 */
      });
    return () => {
      alive = false;
    };
  }, []);

  // 卸载时回收 object URL,避免反复开关设置面板泄漏内存
  useEffect(
    () => () => {
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
      urlsRef.current = [];
    },
    [],
  );

  /**
   * 缩略图:先查缓存,没有才渲染。串行逐个来——同时加载多个模型会一起挤占
   * WebGL 上下文与显存,几个模型就能把页面卡住。
   */
  useEffect(() => {
    if (off || !models.length) return;
    // generation 守卫:StrictMode 下 effect 会跑两遍,两个循环并发渲染同一批模型,
    // 开头几个都会在缓存里 miss,白白做双倍的重活(渲一张就要好几秒)。
    const gen = ++thumbGenRef.current;
    let alive = true;
    void (async () => {
      for (const m of models) {
        if (!alive || thumbGenRef.current !== gen) return;
        const cached = await getThumbUrl(m.name, m.fingerprint);
        if (!alive || thumbGenRef.current !== gen) return;
        if (cached) {
          urlsRef.current.push(cached);
          setThumbs((p) => ({ ...p, [m.name]: cached }));
          continue;
        }
        try {
          const blob = await renderThumb(m.entry);
          if (!alive) return;
          await putThumb(m.name, m.fingerprint, blob);
          const url = URL.createObjectURL(blob);
          urlsRef.current.push(url);
          setThumbs((p) => ({ ...p, [m.name]: url }));
        } catch {
          /* 单个模型渲染失败不影响其它,缩略图位留空,下次打开设置会再试 */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [models, off]);

  /**
   * 当前模型的能力说明。写死会骗人:官方样例里没有一个模型有 TapHead 组。
   * 只读 model3.json,不加载模型——否则会把主线程占满,连缓存好的缩略图都显示不出来。
   */
  const loadCaps = useCallback(async (entry: string) => {
    setLoadingCaps(true);
    try {
      setCaps(await fetchCaps(entry));
    } catch {
      setCaps(null);
    } finally {
      setLoadingCaps(false);
    }
  }, []);

  useEffect(() => {
    const m = models.find((x) => x.name === current);
    if (off || !m) {
      setCaps(null);
      return;
    }
    void loadCaps(m.entry);
  }, [current, models, off, loadCaps]);

  const capsText = off
    ? undefined
    : loadingCaps
      ? '读取中…'
      : caps
        ? describeCaps(caps)
        : models.length
          ? '读不出模型信息'
          : undefined;

  return (
    <>
      <SettingsRow
        hit={hit}
        label="显示看板娘"
        desc="右下角常驻的 Live2D 角色;关掉后不加载模型,不占显存"
        scope="local"
      >
        <span
          className={`switch${state.enabled ? ' on' : ''}`}
          role="switch"
          aria-checked={state.enabled}
          tabIndex={0}
          onClick={() => patch({ enabled: !state.enabled })}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              patch({ enabled: !state.enabled });
            }
          }}
        />
      </SettingsRow>

      <SettingsRow hit={hit} label="模型" desc={capsText} scope="local" off={off}>
        {models.length ? (
          <>
            <div className="l2d-picks">
              {models.map((m) => (
                <button
                  key={m.name}
                  className={`l2d-pick${current === m.name ? ' active' : ''}`}
                  style={thumbs[m.name] ? { backgroundImage: `url("${thumbs[m.name]}")` } : undefined}
                  title={m.name}
                  aria-label={`模型:${m.name}`}
                  aria-pressed={current === m.name}
                  onClick={() => patch({ model: m.name })}
                >
                  {thumbs[m.name] ? '' : m.name.slice(0, 1)}
                </button>
              ))}
            </div>
            <button className="btn btn-sm" onClick={() => toast(`把模型文件夹放进 ${dir} 即可`)}>
              添加…
            </button>
          </>
        ) : (
          <button className="btn btn-sm" onClick={() => toast(`把模型文件夹放进 ${dir} 后重开设置`)}>
            还没有模型,放哪儿?
          </button>
        )}
      </SettingsRow>

      <SettingsRow hit={hit} label="体型" desc="角色显示高度,不影响气泡" scope="local" off={off}>
        <Tabs
          label="看板娘体型"
          value={state.size}
          options={LIVE2D_SIZES.map((s) => ({ v: s as number, label: SIZE_LABELS[s] ?? String(s) }))}
          onChange={(v) => patch({ size: v })}
        />
      </SettingsRow>

      <SettingsRow hit={hit} label="停靠" desc="贴在哪一侧;气泡会跟着换边" scope="local" off={off}>
        <Tabs label="看板娘停靠" value={state.side} options={SIDES} onChange={(v) => patch({ side: v })} />
      </SettingsRow>

      <SettingsRow
        hit={hit}
        label="说话"
        desc="「仅事件」只在会话完成/待输入/失败时开口;「闲聊」会额外随机搭话"
        scope="local"
        off={off}
      >
        <Tabs label="看板娘说话" value={state.talk} options={TALKS} onChange={(v) => patch({ talk: v })} />
      </SettingsRow>
    </>
  );
}
