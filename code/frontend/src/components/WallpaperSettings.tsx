/**
 * 壁纸设置字段组:现在只作为「设置 › 外观」分区的一部分出现,不再自带侧栏入口与弹层。
 * 参数含义与默认值见 DESIGN.md「外观 · 壁纸」——默认 40/0/30/0 是用户实测确认的舒适档。
 */
import { toast } from '@/components/shared';
import { SettingsRow } from '@/components/Settings';
import { saveLocalImage, WALL_PRESETS, type WallMode, type WallState } from '@/lib/wallpaper';

const MODES: { m: WallMode; label: string }[] = [
  { m: 'off', label: '关闭' },
  { m: 'wall', label: '壁纸' },
  { m: 'glass', label: '玻璃' },
];

export function WallpaperFields({
  wall,
  patch,
  hit,
}: {
  wall: WallState;
  patch: (p: Partial<WallState>) => void;
  /** 当前搜索词的命中判定,与其它设置项共用同一套行布局与存储范围标记 */
  hit: (...text: (string | undefined)[]) => boolean;
}) {
  const offAll = wall.mode === 'off';
  const offGlass = wall.mode !== 'glass';

  /**
   * 选图时若壁纸是关的,顺手开到「壁纸」档。
   *
   * 挑图这个动作本身就表达了「我想用壁纸」,要求先盲开再挑是把顺序颠倒了;
   * 旧的壁纸弹层在关闭档禁用整个图片行,表现为「点了本地没反应」(2026-09-03 用户实测报缺陷)。
   * 参数滑杆仍然禁用——壁纸关着时它们确实没有可调的对象。
   */
  const pickSrc = (p: Partial<WallState>) => patch(offAll ? { ...p, mode: 'wall' } : p);

  const onPickFile = (f: File | undefined) => {
    if (!f) return;
    // 换图前回收上一张 object URL,避免内存泄漏
    if (wall.custom.startsWith('blob:')) URL.revokeObjectURL(wall.custom);
    saveLocalImage(f)
      .then(({ url, persistent }) => {
        pickSrc({ custom: url, src: 'custom' });
        if (!persistent) toast('浏览器不支持本地持久化,图片仅本次会话生效');
      })
      .catch(() => toast('图片读取失败'));
  };

  return (
    <>
      <SettingsRow hit={hit}
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
      </SettingsRow>

      <SettingsRow hit={hit}
        label="图片"
        desc={
          offAll
            ? '本地图片存浏览器 IndexedDB,不写 ~/.claude;壁纸关闭时选图会自动开启'
            : '本地图片存浏览器 IndexedDB,不写 ~/.claude'
        }
        scope="local"
      >
        <div className="stg-thumbs">
          {WALL_PRESETS.map((p) => (
            <button
              key={p.id}
              className={`stg-thumb ${wall.src === `preset:${p.id}` ? 'active' : ''}`}
              style={{ backgroundImage: `url('${p.url}')` }}
              title={p.name}
              aria-label={`预设壁纸:${p.name}`}
              onClick={() => pickSrc({ src: `preset:${p.id}` })}
            />
          ))}
        </div>
        {/* 用 label 包住 file input,而不是按钮里 fileRef.click():
            label 的激活行为是浏览器原生打开选择器,不依赖「程序化 click 是否被判定为用户手势」——
            WKWebView 与部分自动化环境会拦下程序化 click,表现为「点了没反应」(2026-09-03 用户实测)。 */}
        <label className="btn btn-sm stg-file">
          本地…
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              onPickFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
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
            pickSrc({ src: v });
            toast('已应用 URL 壁纸');
          }}
        />
      </SettingsRow>

      <SettingsRow hit={hit} label="不透明度" scope="local" off={offAll}>
        <Slider min={5} max={50} value={wall.opacity} unit="%" onChange={(v) => patch({ opacity: v })} />
      </SettingsRow>
      <SettingsRow hit={hit} label="模糊" scope="local" off={offAll}>
        <Slider min={0} max={24} value={wall.blur} unit="px" onChange={(v) => patch({ blur: v })} />
      </SettingsRow>
      <SettingsRow hit={hit} label="表面" desc="面板底色不透明度,仅玻璃档" scope="local" off={offGlass}>
        <Slider min={25} max={95} value={wall.surface} unit="%" onChange={(v) => patch({ surface: v })} />
      </SettingsRow>
      <SettingsRow hit={hit} label="磨砂" desc="面板毛玻璃模糊强度,仅玻璃档" scope="local" off={offGlass}>
        <Slider min={0} max={24} value={wall.frost} unit="px" onChange={(v) => patch({ frost: v })} />
      </SettingsRow>
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
