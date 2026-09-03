/**
 * 设置对话框:全站唯一的偏好入口(DESIGN.md「设置」组件)。
 *
 * 每一行都必须标注存储范围——「本机」只存这台浏览器,「账户」落后端并跨设备同步。
 * 个人工具在 Mac 与手机上共用一套数据,不标清楚就会反复出现「我在这边改了那边没变」。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { DropUp } from '@/components/DropUp';
import { confirmBox, toast } from '@/components/shared';
import { WallpaperFields } from '@/components/WallpaperSettings';
import {
  DEFAULT_ACCOUNT,
  DEFAULT_LOCAL,
  patchAccount,
  patchLocal,
  useAccountPrefs,
  useLocalPrefs,
} from '@/lib/prefs';
import {
  FIXED_KEYS,
  KEYMAP_DEFAULTS,
  KEY_ACTIONS,
  actionLabel,
  comboOf,
  findConflict,
  formatCombo,
  formatKeys,
  type ActionId,
} from '@/lib/keymap';
import { WALL_DEFAULTS, type WallState } from '@/lib/wallpaper';
import { cn } from '@/lib/utils';

type SecId = 'dispatch' | 'look' | 'keys' | 'notify' | 'adv';

const SECTIONS: { id: SecId; label: string; icon: string; title: string; desc: string }[] = [
  {
    id: 'dispatch',
    label: '派发',
    icon: 'M3 12l18-8-6 18-3-7z',
    title: '派发',
    desc: '新会话的初始参数;派发页底栏仍可临时改,只影响当次',
  },
  {
    id: 'look',
    label: '外观',
    icon: 'M3 4h18v16H3zM7 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4 17l4.5-4.5 3 3 4-5 4.5 5',
    title: '外观',
    desc: '只存本机;手机和 Mac 各自一套',
  },
  {
    id: 'keys',
    label: '快捷键',
    icon: 'M2 6h20v12H2zM6 10h1M10 10h1M14 10h1M18 10h1M7 14h10',
    title: '快捷键',
    desc: '点「改键」后按下新组合;与已有键位冲突会标黄,不会静默覆盖',
  },
  {
    id: 'notify',
    label: '通知',
    icon: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
    title: '通知',
    desc: '范围与事件分别控制;手机端走同一套',
  },
  { id: 'adv', label: '高级', icon: 'M4 6h16M4 12h16M4 18h16M8 4v4M14 10v4M10 16v4', title: '高级', desc: '不常动的东西' },
];

const MODEL_OPTS = [
  '',
  'claude-fable-5-1',
  'claude-opus-5',
  'claude-opus-5[1m]',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
];
const EFFORT_OPTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const PERM_OPTS = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
const PERM_LABEL: Record<string, string> = {
  default: 'default(逐项审批)',
  acceptEdits: 'acceptEdits',
  bypassPermissions: 'bypassPermissions(免审批)',
  plan: 'plan',
};

export function Settings({
  open,
  onClose,
  cwdOptions,
  wall,
  patchWall,
}: {
  open: boolean;
  onClose: () => void;
  cwdOptions: string[];
  wall: WallState;
  patchWall: (p: Partial<WallState>) => void;
}) {
  const [sec, setSec] = useState<SecId>('dispatch');
  const [q, setQ] = useState('');
  const local = useLocalPrefs();
  const { prefs } = useAccountPrefs();
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** 正在录入新键位的动作;null = 没有 */
  const [recording, setRecording] = useState<ActionId | null>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setRecording(null);
    const t = setTimeout(() => searchRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open]);

  /** 面板内键盘:录入态优先吃掉一切按键,其次 Esc 关闭、⌘F 聚焦搜索 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (recording) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          setRecording(null);
          return;
        }
        const combo = comboOf(e);
        if (!combo) return; // 只按了修饰键,继续等
        patchLocal({ keymap: { ...local.keymap, [recording]: combo } });
        setRecording(null);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, recording, local.keymap, onClose]);

  const searching = q.trim().length > 0;
  const hit = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (...text: (string | undefined)[]) =>
      !s || text.some((t) => (t ?? '').toLowerCase().includes(s));
  }, [q]);

  if (!open) return null;

  const resetSec = async (id: SecId) => {
    if (id === 'dispatch') {
      const { model, effort, perm, cwd, bg, wrapupPrompt } = DEFAULT_ACCOUNT;
      await patchAccount({ model, effort, perm, cwd, bg, wrapupPrompt });
    } else if (id === 'look') {
      patchLocal({
        fontScale: DEFAULT_LOCAL.fontScale,
        turnHead: DEFAULT_LOCAL.turnHead,
        reduceMotion: DEFAULT_LOCAL.reduceMotion,
      });
      patchWall(WALL_DEFAULTS);
    } else if (id === 'keys') {
      patchLocal({ keymap: { ...KEYMAP_DEFAULTS } });
    } else if (id === 'notify') {
      await patchAccount({ notify: DEFAULT_ACCOUNT.notify });
    }
    toast(`「${SECTIONS.find((x) => x.id === id)!.title}」已恢复默认`);
  };

  /** 一行设置。scope 决定行尾那枚标记,是这个组件的语义核心 */
  const Row = ({
    label,
    desc,
    scope,
    children,
    show = true,
    off,
  }: {
    label: string;
    desc?: string;
    scope: 'local' | 'acct';
    children: React.ReactNode;
    show?: boolean;
    off?: boolean;
  }) => {
    if (!show || !hit(label, desc)) return null;
    return (
      <div className={cn('stg-row', off && 'is-off')}>
        <div className="stg-lab">
          <span>{label}</span>
          {desc && <small>{desc}</small>}
        </div>
        <div className="stg-ctl">{children}</div>
        <span className="stg-scope" data-scope={scope}>
          {scope === 'local' ? '本机' : '账户'}
        </span>
      </div>
    );
  };

  const Switch = ({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) => (
    <span
      className={cn('switch', on && 'on')}
      role="switch"
      aria-checked={on}
      tabIndex={0}
      onClick={() => onChange(!on)}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onChange(!on);
        }
      }}
    />
  );

  const Tabs = <T extends string>({
    value,
    options,
    onChange,
  }: {
    value: T;
    options: { v: T; label: string }[];
    onChange: (v: T) => void;
  }) => (
    <div className="filter-tabs" role="group">
      {options.map((o) => (
        <button
          key={o.v}
          className={value === o.v ? 'active' : ''}
          onClick={() => onChange(o.v)}
          aria-pressed={value === o.v}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  const Group = ({ children, show = true }: { children: string; show?: boolean }) =>
    !searching && show ? <div className="stg-group">{children}</div> : null;

  const SecHead = ({ id }: { id: SecId }) => {
    const s = SECTIONS.find((x) => x.id === id)!;
    return (
      <div className="stg-sec-head">
        <h3>{s.title}</h3>
        <p>{s.desc}</p>
        {id !== 'adv' && (
          <button className="btn btn-quiet" onClick={() => void resetSec(id)}>
            恢复默认
          </button>
        )}
      </div>
    );
  };

  /* ---- 快捷键行 ---- */
  const KeyRow = ({ id }: { id: ActionId }) => {
    const a = KEY_ACTIONS.find((x) => x.id === id)!;
    if (!hit(a.label, a.hint)) return null;
    const combo = local.keymap[id];
    const conflict = findConflict(local.keymap, combo, id);
    const rec = recording === id;
    return (
      <tr className={cn(rec && 'rec', conflict && 'conflict')}>
        <td>
          {a.label}
          {a.hint && <small>{a.hint}</small>}
        </td>
        <td className="k">
          {rec ? null : (
            <>
              <kbd>{formatCombo(combo)}</kbd>
              {conflict && <span className="stg-conf">⚠ 与「{actionLabel(conflict)}」冲突</span>}
            </>
          )}
        </td>
        <td className="a">
          <button onClick={() => setRecording(rec ? null : id)}>{rec ? '取消' : '改键'}</button>
        </td>
      </tr>
    );
  };

  const FixedRow = ({ f }: { f: (typeof FIXED_KEYS)[number] }) =>
    hit(f.label, f.hint) ? (
      <tr className="fixed">
        <td>
          {f.label}
          {f.hint && <small>{f.hint}</small>}
        </td>
        <td className="k">
          {formatKeys(f.keys).map((k, i) => (
            <kbd key={i}>{k}</kbd>
          ))}
        </td>
        <td className="a">
          {f.label === '发送 / 换行' && (
            <button onClick={() => setSec('dispatch')}>去设置</button>
          )}
        </td>
      </tr>
    ) : null;

  const keyGroups = ['全局', '派发', '会话看板'] as const;
  const keysTable = keyGroups.map((g) => {
    const acts = KEY_ACTIONS.filter((a) => a.group === g);
    const fixed = FIXED_KEYS.filter((f) => f.group === g);
    const rows = [
      ...acts.map((a) => <KeyRow key={a.id} id={a.id} />),
      ...fixed.map((f, i) => <FixedRow key={`f${i}`} f={f} />),
    ].filter(Boolean);
    return { g, rows };
  });

  const secShown = (id: SecId) => (searching ? true : sec === id);

  /* 搜索态下把所有分区都摊开,由每行自己决定显隐;命中为零时给空态 */
  const panes = (
    <>
      <section className="stg-sec" hidden={!secShown('dispatch')}>
        {!searching && <SecHead id="dispatch" />}
        <Row
          label="默认模型"
          desc="现在是「上次用过的」,这里改成固定值后不再随上次漂移"
          scope="acct"
        >
          <DropUp
            down
            portalTo={bodyRef}
            value={prefs.model}
            options={MODEL_OPTS}
            labelOf={(v) => v || '沿用上次用过的'}
            onChange={(v) => void patchAccount({ model: v })}
          />
        </Row>
        <Row
          label="默认思考深度"
          desc="自动 = 按模型取默认(opus-5 → low,其余交给模型自身)"
          scope="acct"
        >
          <DropUp
            down
            className="dim"
            portalTo={bodyRef}
            value={prefs.effort}
            options={EFFORT_OPTS}
            labelOf={(v) => v || '(自动)'}
            onChange={(v) => void patchAccount({ effort: v })}
          />
        </Row>
        <Row label="默认权限模式" desc="后台派发(--bg)固定为 default,不受此项影响" scope="acct">
          <DropUp
            down
            className="dim"
            portalTo={bodyRef}
            value={prefs.perm}
            options={PERM_OPTS}
            labelOf={(v) => PERM_LABEL[v] ?? v}
            onChange={(v) => void patchAccount({ perm: v })}
          />
        </Row>
        <Row
          label="默认工作目录"
          desc="候选来自 ~/.claude/projects;不设则用最近一次派发的目录"
          scope="acct"
        >
          <DropUp
            down
            portalTo={bodyRef}
            value={prefs.cwd}
            options={['', ...cwdOptions]}
            labelOf={(v) => v || '最近一次派发的目录'}
            onChange={(v) => void patchAccount({ cwd: v })}
          />
        </Row>
        <Row label="默认转后台(--bg)" desc="开启后新会话默认勾选「转后台」" scope="acct">
          <Switch on={prefs.bg} onChange={(v) => void patchAccount({ bg: v })} />
        </Row>
        <Group>输入框</Group>
        <Row
          label="发送键"
          desc="IME 候选中的回车不会触发发送;Ctrl+⏎ 始终等同 ⌘⏎"
          scope="local"
        >
          <Tabs
            value={local.sendKey}
            options={[
              { v: 'mod' as const, label: '⌘⏎ 发送 · Enter 换行' },
              { v: 'enter' as const, label: 'Enter 发送 · ⇧⏎ 换行' },
            ]}
            onChange={(v) => patchLocal({ sendKey: v })}
          />
        </Row>
        <Row label="任务总结触发语" desc="输入 /wrapup 时实际发给会话的话" scope="acct">
          <input
            className="input"
            type="text"
            defaultValue={prefs.wrapupPrompt}
            spellCheck={false}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== prefs.wrapupPrompt) void patchAccount({ wrapupPrompt: v });
              else e.target.value = prefs.wrapupPrompt;
            }}
          />
        </Row>
      </section>

      <section className="stg-sec" hidden={!secShown('look')}>
        {!searching && <SecHead id="look" />}
        <Group>壁纸</Group>
        <WallpaperFields wall={wall} patch={patchWall} Row={Row} />
        <Group>阅读</Group>
        <Row label="正文字号" scope="local">
          <Tabs
            value={local.fontScale}
            options={[
              { v: 'sm' as const, label: '小' },
              { v: 'md' as const, label: '标准' },
              { v: 'lg' as const, label: '大' },
            ]}
            onChange={(v) => patchLocal({ fontScale: v })}
          />
        </Row>
        <Row label="吸顶轮次头" desc="提问滚出视口后在顶部显示当前轮" scope="local">
          <Switch on={local.turnHead} onChange={(v) => patchLocal({ turnHead: v })} />
        </Row>
        <Row label="减少动效" desc="默认跟随系统 prefers-reduced-motion" scope="local">
          <Tabs
            value={local.reduceMotion}
            options={[
              { v: 'system' as const, label: '跟随系统' },
              { v: 'on' as const, label: '开' },
              { v: 'off' as const, label: '关' },
            ]}
            onChange={(v) => patchLocal({ reduceMotion: v })}
          />
        </Row>
      </section>

      <section className="stg-sec" hidden={!secShown('keys')}>
        {!searching && <SecHead id="keys" />}
        {keysTable.map(({ g, rows }) =>
          rows.length ? (
            <div key={g}>
              <Group>{g}</Group>
              <table className="stg-keys">
                <tbody>{rows}</tbody>
              </table>
            </div>
          ) : null,
        )}
      </section>

      <section className="stg-sec" hidden={!secShown('notify')}>
        {!searching && <SecHead id="notify" />}
        <Group>范围</Group>
        <Row label="璇玑派发的会话" scope="acct">
          <Switch
            on={prefs.notify.dispatched}
            onChange={(v) => void patchAccount({ notify: { ...prefs.notify, dispatched: v } })}
          />
        </Row>
        <Row label="定时任务" scope="acct">
          <Switch
            on={prefs.notify.scheduled}
            onChange={(v) => void patchAccount({ notify: { ...prefs.notify, scheduled: v } })}
          />
        </Row>
        <Row label="终端里的交互会话" desc="默认关;你在终端前,不需要网页再提醒一次" scope="acct">
          <Switch
            on={prefs.notify.terminal}
            onChange={(v) => void patchAccount({ notify: { ...prefs.notify, terminal: v } })}
          />
        </Row>
        <Group>事件</Group>
        <Row label="需要审批 / blocked" scope="acct">
          <Switch
            on={prefs.notify.blocked}
            onChange={(v) => void patchAccount({ notify: { ...prefs.notify, blocked: v } })}
          />
        </Row>
        <Row label="回合结束" scope="acct">
          <Switch
            on={prefs.notify.turnEnd}
            onChange={(v) => void patchAccount({ notify: { ...prefs.notify, turnEnd: v } })}
          />
        </Row>
        <Row label="出错退出" scope="acct">
          <Switch
            on={prefs.notify.error}
            onChange={(v) => void patchAccount({ notify: { ...prefs.notify, error: v } })}
          />
        </Row>
      </section>

      <section className="stg-sec" hidden={!secShown('adv')}>
        {!searching && <SecHead id="adv" />}
        <Row
          label="清空本机偏好"
          desc="外观、快捷键、发送键回到默认;账户偏好与壁纸图片不受影响"
          scope="local"
        >
          <button
            className="btn btn-sm btn-danger"
            onClick={async () => {
              if (!(await confirmBox('清空本机偏好?外观、快捷键、发送键将回到默认。'))) return;
              patchLocal(DEFAULT_LOCAL);
              toast('本机偏好已清空');
            }}
          >
            清空…
          </button>
        </Row>
        {!searching && (
          <div className="stg-storage">
            本机偏好存 <code>localStorage</code> 的 <code>xuanji.prefs</code>,壁纸另存{' '}
            <code>xuanji.wall</code> 与 IndexedDB <code>xuanji/wallpaper</code>;账户偏好存后端
            SQLite <code>meta</code> 表,经 <code>GET/PUT /api/prefs</code>。两者都不写{' '}
            <code>~/.claude</code>。后端端口与数据目录由环境变量 <code>XUANJI_PORT</code>、
            <code>XUANJI_DATA_DIR</code> 决定,不在此处。
          </div>
        )}
      </section>
    </>
  );

  return (
    <>
      <div className="backdrop show" onClick={onClose} />
      <div className="modal stg-modal show" role="dialog" aria-modal="true" aria-label="设置">
        <div className="stg-head">
          <h2>设置</h2>
          <div className="stg-search">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" strokeLinecap="round" />
            </svg>
            <input
              ref={searchRef}
              className="input"
              type="search"
              placeholder="搜索设置项…(如 模型、发送、壁纸)"
              aria-label="搜索设置项"
              spellCheck={false}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <kbd>⌘F</kbd>
          </div>
          <button className="x-btn" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="stg-body" ref={bodyRef}>
          <nav className="stg-nav" aria-label="设置分区">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={!searching && sec === s.id ? 'active' : ''}
                onClick={() => {
                  setQ('');
                  setSec(s.id);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
                  <path d={s.icon} />
                </svg>
                {s.label}
              </button>
            ))}
            <div className="stg-nav-foot">
              <span className="stg-legend">
                <span className="stg-scope" data-scope="local">
                  本机
                </span>
                仅此浏览器
              </span>
              <span className="stg-legend">
                <span className="stg-scope" data-scope="acct">
                  账户
                </span>
                跨设备同步
              </span>
            </div>
          </nav>
          <div className="stg-pane">{panes}</div>
        </div>
      </div>
    </>
  );
}
