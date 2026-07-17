/**
 * 壁纸设置:侧栏底部入口按钮 + 向上弹出面板。
 * 布局/参数/文案 1:1 还原 wiki/design/prototype.html 壁纸演示(获批稿)。
 */
import { useEffect, useRef } from 'react';
import { toast } from '@/components/shared';
import {
  saveLocalImage,
  wallStateLabel,
  WALL_PRESETS,
  type WallMode,
  type WallState,
} from '@/lib/wallpaper';

const MODES: { m: WallMode; label: string }[] = [
  { m: 'off', label: '关闭' },
  { m: 'wall', label: '壁纸' },
  { m: 'glass', label: '玻璃' },
];

export function WallpaperSettings({
  wall,
  patch,
  open,
  onToggle,
}: {
  wall: WallState;
  patch: (p: Partial<WallState>) => void;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const popRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Esc 关闭(还焦点给入口按钮)+ 点击面板外关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onToggle(false);
        btnRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) onToggle(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [open, onToggle]);

  const onPickFile = (f: File | undefined) => {
    if (!f) return;
    // 换图前回收上一张 object URL,避免内存泄漏
    if (wall.custom.startsWith('blob:')) URL.revokeObjectURL(wall.custom);
    saveLocalImage(f)
      .then(({ url, persistent }) => {
        patch({ custom: url, src: 'custom' });
        if (!persistent) toast('浏览器不支持本地持久化,图片仅本次会话生效');
      })
      .catch(() => toast('图片读取失败'));
  };

  const stateLabel = wallStateLabel(wall);

  return (
    <>
      <button
        ref={btnRef}
        className="wall-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
          <circle cx="5.5" cy="6" r="1.2" />
          <path d="M2 12l3.5-3.5 2.5 2.5 3-3.5 3 3.5" strokeLinejoin="round" />
        </svg>
        壁纸<span className="wp-state">{stateLabel}</span>
      </button>

      {open && (
        <div ref={popRef} className="wall-pop" role="dialog" aria-label="壁纸设置">
          <div className="wp-head">
            <h3>壁纸</h3>
            <button className="x-btn" aria-label="关闭" onClick={() => onToggle(false)}>
              ✕
            </button>
          </div>
          <div className="wp-row">
            <span className="wp-label">模式</span>
            <div className="filter-tabs" role="group" aria-label="壁纸模式">
              {MODES.map(({ m, label }) => (
                <button
                  key={m}
                  className={wall.mode === m ? 'active' : ''}
                  onClick={() => patch({ mode: m })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className={wall.mode === 'off' ? 'is-off' : ''} aria-disabled={wall.mode === 'off'}>
            <div className="wp-row">
              <span className="wp-label">图片</span>
              <div className="wp-thumbs">
                {WALL_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    className={`wp-thumb ${wall.src === `preset:${p.id}` ? 'active' : ''}`}
                    style={{ backgroundImage: `url('${p.url}')` }}
                    title={p.name}
                    aria-label={`预设壁纸:${p.name}`}
                    onClick={() => patch({ src: `preset:${p.id}` })}
                  />
                ))}
              </div>
              <button className="btn btn-sm" onClick={() => fileRef.current?.click()}>
                本地…
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  onPickFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
            <div className="wp-row">
              <label className="wp-label" htmlFor="wall-url">
                URL
              </label>
              <input
                id="wall-url"
                className="input"
                placeholder="https://… 回车应用"
                spellCheck={false}
                defaultValue={wall.src.startsWith('preset:') || wall.src === 'custom' ? '' : wall.src}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  const v = e.currentTarget.value.trim();
                  if (!v) return;
                  patch({ src: v });
                  toast('已应用 URL 壁纸');
                }}
              />
            </div>
            <Slider label="不透明度" min={5} max={50} value={wall.opacity} unit="%" onChange={(v) => patch({ opacity: v })} />
            <Slider label="模糊" min={0} max={24} value={wall.blur} unit="px" onChange={(v) => patch({ blur: v })} />
            <div className={wall.mode !== 'glass' ? 'is-off' : ''} aria-disabled={wall.mode !== 'glass'}>
              <Slider label="表面" min={25} max={95} value={wall.surface} unit="%" onChange={(v) => patch({ surface: v })} />
              <Slider label="磨砂" min={0} max={24} value={wall.frost} unit="px" onChange={(v) => patch({ frost: v })} />
            </div>
          </div>
          <p className="wp-note">
            「表面」= 面板底色不透明度,「磨砂」= 面板毛玻璃模糊强度,均仅玻璃档生效。
            设置与本地图片只存本机浏览器,不写 ~/.claude。
          </p>
        </div>
      )}
    </>
  );
}

function Slider({
  label,
  min,
  max,
  value,
  unit,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  const id = `wall-slider-${label}`;
  return (
    <div className="wp-row">
      <label className="wp-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
      />
      <span className="wp-val">
        {value}
        {unit}
      </span>
    </div>
  );
}
