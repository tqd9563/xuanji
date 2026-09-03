/**
 * 壁纸设置字段组:现在只作为「设置 › 外观」分区的一部分出现,不再自带侧栏入口与弹层。
 * 参数含义与默认值见 DESIGN.md「外观 · 壁纸」——默认 40/0/30/0 是用户实测确认的舒适档。
 */
import { useRef, type ReactNode } from 'react';
import { toast } from '@/components/shared';
import { saveLocalImage, WALL_PRESETS, type WallMode, type WallState } from '@/lib/wallpaper';

const MODES: { m: WallMode; label: string }[] = [
  { m: 'off', label: '关闭' },
  { m: 'wall', label: '壁纸' },
  { m: 'glass', label: '玻璃' },
];

/** 由 Settings 传进来的行容器,保证壁纸各项与其它设置项共用同一套行布局与存储范围标记 */
type RowComp = (props: {
  label: string;
  desc?: string;
  scope: 'local' | 'acct';
  children: ReactNode;
  show?: boolean;
  off?: boolean;
}) => ReactNode;

export function WallpaperFields({
  wall,
  patch,
  Row,
}: {
  wall: WallState;
  patch: (p: Partial<WallState>) => void;
  Row: RowComp;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);

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

  const offAll = wall.mode === 'off';
  const offGlass = wall.mode !== 'glass';

  return (
    <>
      <Row
        label="模式"
        desc="玻璃 = 面板半透明 + 毛玻璃;所有浮层在玻璃档下保持不透明"
        scope="local"
      >
        <div className="filter-tabs" role="group" aria-label="壁纸模式">
          {MODES.map(({ m, label }) => (
            <button
              key={m}
              className={wall.mode === m ? 'active' : ''}
              aria-pressed={wall.mode === m}
              onClick={() => patch({ mode: m })}
            >
              {label}
            </button>
          ))}
        </div>
      </Row>

      <Row label="图片" desc="本地图片存浏览器 IndexedDB,不写 ~/.claude" scope="local" off={offAll}>
        <div className="stg-thumbs">
          {WALL_PRESETS.map((p) => (
            <button
              key={p.id}
              className={`stg-thumb ${wall.src === `preset:${p.id}` ? 'active' : ''}`}
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
        <input
          className="input"
          type="url"
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
      </Row>

      <Row label="不透明度" scope="local" off={offAll}>
        <Slider min={5} max={50} value={wall.opacity} unit="%" onChange={(v) => patch({ opacity: v })} />
      </Row>
      <Row label="模糊" scope="local" off={offAll}>
        <Slider min={0} max={24} value={wall.blur} unit="px" onChange={(v) => patch({ blur: v })} />
      </Row>
      <Row label="表面" desc="面板底色不透明度,仅玻璃档" scope="local" off={offGlass}>
        <Slider min={25} max={95} value={wall.surface} unit="%" onChange={(v) => patch({ surface: v })} />
      </Row>
      <Row label="磨砂" desc="面板毛玻璃模糊强度,仅玻璃档" scope="local" off={offGlass}>
        <Slider min={0} max={24} value={wall.frost} unit="px" onChange={(v) => patch({ frost: v })} />
      </Row>
    </>
  );
}

function Slider({
  min,
  max,
  value,
  unit,
  onChange,
}: {
  min: number;
  max: number;
  value: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
      />
      <span className="stg-val">
        {value}
        {unit}
      </span>
    </>
  );
}
