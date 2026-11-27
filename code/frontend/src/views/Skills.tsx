import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '@/api/client';
import type { Skill, SkillUsage } from '@/api/types';
import { usePoll, useIsMobile } from '@/lib/hooks';
import { Drawer, Empty, Tag, confirmBox, toast } from '@/components/shared';
import { Input } from '@/components/ui/input';
import { useLocalPrefs } from '@/lib/prefs';
import { matchKey } from '@/lib/keymap';

type Filter = 'all' | 'on' | 'off' | 'plugin';
/** 统计窗口(天),与后端 USAGE_WINDOWS 对齐 */
type Win = 7 | 30 | 90;
const WINDOWS: Win[] = [7, 30, 90];

const countOf = (s: Skill, w: Win): number => s.usage?.[`d${w}` as keyof SkillUsage] as number ?? 0;

const fmtDay = (ms?: number) => (ms ? new Date(ms).toLocaleDateString('zh-CN') : '从未触发');

type PluginInfo = NonNullable<Skill['plugin']>;
/** 插件技能的短名:name 是 `插件:技能`,组内只显示后半(命名空间由组行提供) */
const shortName = (s: Skill) => (s.plugin ? s.name.slice(s.plugin.name.length + 1) : s.name);
/** 表格/卡片列表的一行:用户技能逐条,插件一组一条 */
type Item =
  | { kind: 'user'; s: Skill; en: boolean; name: string; n: number }
  | { kind: 'group'; p: PluginInfo; skills: Skill[]; kids: Skill[]; en: boolean; name: string; n: number; open: boolean };

const Chevron = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4.5 2.5 8 6l-3.5 3.5" />
  </svg>
);

export function Skills() {
  const { data, refresh } = usePoll(api.skills, 60_000);
  const [filter, setFilter] = useState<Filter>('all');
  const [win, setWin] = useState<Win>(30);
  /** 默认按启用+名称排;点「触发」列头切到按次数降序 */
  const [byUsage, setByUsage] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Skill | null>(null);
  /** 「插件」筛选下的二级筛选:all 或插件 id */
  const [plug, setPlug] = useState('all');
  /** 手动展开的插件组 */
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [daily, setDaily] = useState<number[] | null>(null);
  const isMobile = useIsMobile();
  const searchRef = useRef<HTMLInputElement>(null);

  /** ⌘F(与「查找」同一个键位,可在设置里改):技能页没有 FindBar,
      页内检索就是右上角这个过滤框——把焦点送过去并全选,再按一次可直接重打 */
  const findKey = useLocalPrefs().keymap['sessions.find'];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchKey(e, findKey)) return;
      // 视图切换用 display:none、所有视图常驻挂载:没有矩形就说明技能页此刻不可见,
      // 不能把别的视图的 ⌘F 抢走(WebKit 下 display:none 元素仍可能持有焦点,故只认矩形)
      const el = searchRef.current;
      if (!el || el.getClientRects().length === 0) return;
      e.preventDefault();
      el.focus();
      el.select();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [findKey]);

  /** 抽屉打开时才拉逐日分布:列表页不需要,省一次全表扫描 */
  useEffect(() => {
    if (!sel) return setDaily(null);
    let alive = true;
    setDaily(null);
    api
      .skillUsageDaily(sel.name)
      .then((r) => alive && setDaily(r.days))
      .catch(() => alive && setDaily([]));
    return () => {
      alive = false;
    };
  }, [sel]);

  /** 铁律例外②:显式触发 + 二次确认的可逆管理操作 */
  const toggle = async (s: Skill) => {
    const action = s.enabled ? '禁用' : '启用';
    const detail = s.enabled
      ? `目录将移入 skills-disabled/,新会话不再加载它。`
      : `目录将移回 skills/,新会话恢复加载。`;
    if (!(await confirmBox(`确认${action}技能「${s.name}」?\n${detail}(操作可逆)`))) return;
    try {
      await api.toggleSkill(s.name, !s.enabled);
      toast(`已${action} ${s.name}`);
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  /** 插件启停:铁律例外②(2026-11-27 批准),后端执行 claude plugin enable/disable */
  const togglePlugin = async (p: PluginInfo, n: number) => {
    const action = p.enabled ? '停用' : '启用';
    const cmd = p.enabled ? 'disable' : 'enable';
    const msg =
      `确认${action}插件「${p.id}」?\n将执行 claude plugin ${cmd} ${p.id},改写 ~/.claude/settings.json 的 enabledPlugins。\n` +
      `其中 ${n} 个技能${p.enabled ? '从新会话起不再加载' : '从新会话起恢复加载'},运行中的会话不受影响。(操作可逆)`;
    if (!(await confirmBox(msg))) return;
    try {
      await api.togglePlugin(p.id, !p.enabled);
      toast(`已${action}插件 ${p.name} · ${n} 个技能,新会话生效`);
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const skills = data?.skills ?? [];
  const groups = new Map<string, { p: PluginInfo; skills: Skill[] }>();
  for (const s of skills) {
    if (!s.plugin) continue;
    const g = groups.get(s.plugin.id) ?? { p: s.plugin, skills: [] };
    g.skills.push(s);
    groups.set(s.plugin.id, g);
  }
  const ql = q.toLowerCase();
  const hit = (txt: string) => !ql || txt.toLowerCase().includes(ql);
  const rows: Item[] = [];
  if (filter !== 'plugin') {
    for (const s of skills) {
      if (s.plugin) continue;
      if (filter === 'on' && !s.enabled) continue;
      if (filter === 'off' && s.enabled) continue;
      if (!hit(s.name + s.description)) continue;
      rows.push({ kind: 'user', s, en: s.enabled, name: s.name, n: countOf(s, win) });
    }
  }
  for (const { p, skills: all } of groups.values()) {
    if (filter === 'on' && !p.enabled) continue;
    if (filter === 'off' && p.enabled) continue;
    if (filter === 'plugin' && plug !== 'all' && plug !== p.id) continue;
    const selfHit = hit(p.name + p.id + (p.description ?? ''));
    const kids = all.filter((s) => selfHit || hit(s.name + s.description));
    if (!kids.length) continue;
    kids.sort(byUsage ? (a, b) => countOf(b, win) - countOf(a, win) || a.name.localeCompare(b.name) : (a, b) => a.name.localeCompare(b.name));
    // 搜索只命中组内技能 / 二级筛选选中单个插件时自动展开
    const forced = (!!ql && !selfHit) || (filter === 'plugin' && plug === p.id);
    const n = all.reduce((a, s) => a + countOf(s, win), 0);
    rows.push({ kind: 'group', p, skills: all, kids, en: p.enabled, name: p.name, n, open: forced || open.has(p.id) });
  }
  rows.sort(byUsage ? (a, b) => b.n - a.n || a.name.localeCompare(b.name) : (a, b) => Number(b.en) - Number(a.en) || a.name.localeCompare(b.name));
  /** 条宽按当前窗口内的最大值归一:换窗口后长短对比仍然成立 */
  const max = Math.max(
    1,
    ...rows.flatMap((it) => (it.kind === 'group' ? [it.n, ...(it.open ? it.kids.map((k) => countOf(k, win)) : [])] : [it.n])),
  );

  const caliber = (s: Skill) =>
    `近 ${win} 天触发 ${countOf(s, win)} 次\n最近触发:${fmtDay(s.usage?.lastUsedAt)}\n口径:${data?.usageCaliber ?? ''}`;

  const usageCell = (s: Skill) => usageCellN(countOf(s, win), caliber(s));
  const usageCellN = (n: number, title: string) => {
    return (
      <span className="usage-cell" title={title}>
        <span className={`usage-n${n === 0 ? ' zero' : ''}`}>{n}</span>
        {n > 0 && <span className="usage-bar" style={{ width: `${Math.max(2, Math.round((n / max) * 72))}px` }} />}
      </span>
    );
  };

  /** 插件开关:真开关,确认后走 claude plugin enable/disable */
  const pluginSwitch = (it: Extract<Item, { kind: 'group' }>, style?: React.CSSProperties) => (
    <span
      className={`switch psk-switch ${it.p.enabled ? 'on' : ''}`}
      role="switch"
      tabIndex={0}
      aria-checked={it.p.enabled}
      aria-label={`启用插件 ${it.p.id}`}
      title={`${it.p.enabled ? '停用' : '启用'}整个插件(${it.skills.length} 个技能)`}
      style={style}
      onClick={(e) => {
        e.stopPropagation();
        void togglePlugin(it.p, it.skills.length);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        void togglePlugin(it.p, it.skills.length);
      }}
    />
  );
  const offTag = (p: PluginInfo) => (p.enabled ? null : <span className="psk-off-tag">已停用</span>);
  const market = (p: PluginInfo) => {
    const m = p.id.split('@')[1] ?? '';
    return m.length > 24 ? `${m.slice(0, 18)}…` : m;
  };

  const desktopGroup = (it: Extract<Item, { kind: 'group' }>) => {
    const { p } = it;
    const off = p.enabled ? '' : ' psk-off';
    return (
      <Fragment key={p.id}>
        <tr className={`rowlink psk-group${off}`} aria-expanded={it.open} onClick={() => toggleOpen(p.id)}>
          <td className="mono cell-name" style={{ fontSize: '0.8125rem', fontWeight: 600 }} title={p.id}>
            <div className="psk-gname">
              <button
                className="psk-caret"
                type="button"
                aria-expanded={it.open}
                aria-label={`${it.open ? '收起' : '展开'} ${p.name} 的技能`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleOpen(p.id);
                }}
              >
                <Chevron />
              </button>
              <span>{p.name}</span>
            </div>
          </td>
          <td>
            <div className="skill-desc" title={p.description}>
              <span className="psk-gmeta"><b>{it.skills.length}</b> 个技能 · @{market(p)}</span>
              {offTag(p)}
              {p.description}
            </div>
          </td>
          <td>{usageCellN(it.n, `近 ${win} 天插件内技能合计触发 ${it.n} 次\n口径:${data?.usageCaliber ?? ''}`)}</td>
          <td className="mono psk-ver" style={{ color: 'var(--muted)' }} title={p.version ? `v${p.version}` : undefined}>{p.version ?? '—'}</td>
          <td><span className="uncheck">—</span></td>
          <td><Tag>plugin</Tag></td>
          <td>{pluginSwitch(it)}</td>
        </tr>
        {it.open &&
          it.kids.map((k) => (
            <tr key={k.name} className={`rowlink psk-child${off}`} onClick={() => setSel(k)}>
              <td className="mono cell-name" style={{ fontSize: '0.8125rem', fontWeight: 600 }} title={k.name}>
                <div className="psk-fq"><span className="psk-sn">{shortName(k)}</span></div>
              </td>
              <td><div className="skill-desc" title={k.description}>{k.description}</div></td>
              <td>{usageCell(k)}</td>
              <td className="mono" style={{ color: 'var(--muted)' }}>{k.version ?? '—'}</td>
              <td>{k.userInvocable ? <span className="check">✓</span> : <span className="uncheck">—</span>}</td>
              <td><Tag>plugin</Tag></td>
              <td><span className="psk-follow" title={`插件技能不能单独启停,随所属插件 ${p.id} 一起启用/停用`}>随插件</span></td>
            </tr>
          ))}
      </Fragment>
    );
  };

  const mobileGroup = (it: Extract<Item, { kind: 'group' }>) => {
    const { p } = it;
    return (
      <div
        key={p.id}
        className={`mcard psk-mgroup${p.enabled ? '' : ' psk-off'}`}
        role="button"
        tabIndex={0}
        aria-expanded={it.open}
        onClick={() => toggleOpen(p.id)}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div className="psk-dim" style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="psk-caret" aria-hidden aria-expanded={it.open}><Chevron /></span>
              <span className="mono" style={{ fontSize: '0.8125rem', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              <span className="mono" style={{ color: 'var(--faint)', fontSize: '0.6875rem', flex: 'none' }}>v{p.version ?? '—'}</span>
              <Tag>插件</Tag>
            </div>
            <div style={{ color: 'var(--muted)', fontSize: '0.8125rem', marginTop: 4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              <span className="psk-gmeta"><b>{it.skills.length}</b> 个技能</span>
              {offTag(p)}
              {p.description}
            </div>
            <div style={{ marginTop: 6 }}>{usageCellN(it.n, `插件内技能合计 ${it.n} 次`)}</div>
          </div>
          {pluginSwitch(it, { marginTop: 2 })}
        </div>
        {it.open && (
          <div className="psk-mlist">
            {it.kids.map((k) => (
              <button
                key={k.name}
                className="psk-mitem"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setSel(k);
                }}
              >
                <span className="psk-fq mono"><span className="psk-sn">{shortName(k)}</span></span>
                <span className={`usage-n${countOf(k, win) === 0 ? ' zero' : ''}`}>{countOf(k, win)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="view-head">
        <h1>技能</h1>
        <span className="sub">{skills.filter((s) => s.enabled).length} 个已启用 / 共 {skills.length} 个</span>
        <span className="spacer" />
        {/* 排序与「触发」列头共用 byUsage 一个状态,双向同步:
            列头是就近入口,这组 tabs 是可发现的显式入口,不能各存一份状态 */}
        <div className="sort-group" role="group" aria-label="排序">
          <span className="sort-label">排序</span>
          <div className="filter-tabs">
            <button className={byUsage ? '' : 'active'} onClick={() => setByUsage(false)}>
              默认
            </button>
            <button className={byUsage ? 'active' : ''} onClick={() => setByUsage(true)}>
              触发 <span className="s-arrow">▼</span>
            </button>
          </div>
        </div>
        <div className="filter-tabs" role="group" aria-label="统计窗口">
          {WINDOWS.map((w) => (
            <button key={w} className={win === w ? 'active' : ''} onClick={() => setWin(w)}>
              {w} 天
            </button>
          ))}
        </div>
        <div className="filter-tabs">
          {(
            [['all', '全部'], ['on', '已启用'], ['off', '已禁用'], ['plugin', '插件']] as [Filter, string][]
          ).map(([f, label]) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => (setFilter(f), setPlug('all'))}>
              {label}
            </button>
          ))}
        </div>
        <Input ref={searchRef} type="search" placeholder="搜索技能…" style={{ width: 200 }} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {filter === 'plugin' && (
        <div className="psk-subbar" role="group" aria-label="按插件筛选">
          <span className="sort-label">插件</span>
          <div className="filter-tabs">
            <button className={plug === 'all' ? 'active' : ''} onClick={() => setPlug('all')} title="全部插件">
              全部<span className="n">{groups.size}</span>
            </button>
            {[...groups.values()].map(({ p, skills: ks }) => (
              <button key={p.id} className={plug === p.id ? 'active' : ''} onClick={() => setPlug(p.id)} title={p.id}>
                {p.name}<span className="n">{ks.length}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="notice">
        <span className="ok" />
        触发次数统计自全部项目的会话日志(只读扫描,不写 <span className="mono">~/.claude</span>);
        关闭开关 = 把技能目录移入 <span className="mono">~/.claude/skills-disabled/</span>,新会话不再加载(可逆,二次确认后执行)
      </div>
      {isMobile ? (
        <div className="mcard-list">
          {rows.map((it) => {
            if (it.kind === 'group') return mobileGroup(it);
            const s = it.s;
            return (
            <div key={s.name} className="mcard" onClick={() => setSel(s)} role="button" tabIndex={0}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="mono" style={{ fontSize: '0.8125rem', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                    <span className="mono" style={{ color: 'var(--faint)', fontSize: '0.6875rem', flex: 'none' }}>v{s.version ?? '—'}</span>
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: '0.8125rem', marginTop: 4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {s.description}
                  </div>
                  <div style={{ marginTop: 6 }}>{usageCell(s)}</div>
                </div>
                <span
                  className={`switch ${s.enabled ? 'on' : ''}`}
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={`启用 ${s.name}`}
                  style={{ marginTop: 2 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggle(s);
                  }}
                />
              </div>
            </div>
            );
          })}
          {rows.length === 0 && <Empty><p>没有匹配的技能。</p></Empty>}
        </div>
      ) : (
        <div className="panel">
          {/* 固定列宽(见 .table-skills):数字列不随窗口切换(3 位数 ↔ 1 位数)抖动,
              描述是唯一的弹性列,窄屏挤压只压它 */}
          <table className="table table-skills">
            <thead>
              <tr>
                <th>名称</th><th>描述</th>
                {/* 排序控件用真按钮而不是给 th 挂 onClick:键盘要能 Tab 到并回车触发 */}
                <th className={`usage-th${byUsage ? ' sorted' : ''}`} aria-sort={byUsage ? 'descending' : 'none'}>
                  <button
                    type="button"
                    onClick={() => setByUsage((v) => !v)}
                    title={byUsage ? '按触发次数降序,点击恢复默认排序' : '点击按触发次数排序'}
                  >
                    触发({win} 天)<span className="arrow">{byUsage ? '▼' : '↕'}</span>
                  </button>
                </th>
                <th>版本</th><th>可调用</th><th>来源</th><th>启用</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((it) => {
                if (it.kind === 'group') return desktopGroup(it);
                const s = it.s;
                return (
                <tr key={s.name} className="rowlink" onClick={() => setSel(s)}>
                  <td className="mono cell-name" style={{ fontSize: '0.8125rem', fontWeight: 600 }} title={s.name}>{s.name}</td>
                  <td><div className="skill-desc" title={s.description}>{s.description}</div></td>
                  <td>{usageCell(s)}</td>
                  <td className="mono" style={{ color: 'var(--muted)' }}>{s.version ?? '—'}</td>
                  <td>{s.userInvocable ? <span className="check">✓</span> : <span className="uncheck">—</span>}</td>
                  <td><Tag>{s.source}</Tag></td>
                  <td>
                    <span
                      className={`switch ${s.enabled ? 'on' : ''}`}
                      role="switch"
                      aria-checked={s.enabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggle(s);
                      }}
                    />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <Empty><p>没有匹配的技能。</p></Empty>}
        </div>
      )}

      <Drawer
        open={sel !== null}
        onClose={() => setSel(null)}
        title={sel?.name ?? ''}
        meta={
          sel &&
          (sel.plugin ? (
            <>
              <Tag>plugin</Tag>
              <span className="mono">{sel.plugin.id}</span>
              {sel.plugin.version && <span className="mono">v{sel.plugin.version}</span>}
              {sel.plugin.enabled ? <span>随插件启用</span> : <span className="psk-off-tag" style={{ margin: 0 }}>插件已停用</span>}
            </>
          ) : (
            <>
              <Tag>{sel.source}</Tag>
              {sel.version && <span className="mono">v{sel.version}</span>}
              {sel.allowedTools && <span className="mono">{sel.allowedTools}</span>}
            </>
          ))
        }
      >
        {sel && (
          <>
            <p style={{ fontSize: '0.8125rem', color: 'var(--muted)', marginBottom: 16, maxWidth: '68ch' }}>{sel.description}</p>
            <div className="drawer-sec">
              <h3>使用情况</h3>
              <dl className="usage-kv">
                {WINDOWS.map((w) => (
                  <div key={w} style={{ display: 'contents' }}>
                    <dt>近 {w} 天</dt>
                    <dd>{countOf(sel, w)} 次</dd>
                  </div>
                ))}
                <dt>最近触发</dt>
                <dd>{fmtDay(sel.usage?.lastUsedAt)}</dd>
              </dl>
              <UsageSpark days={daily} />
            </div>
            <div className="drawer-sec">
              <h3>SKILL.md</h3>
              <pre
                className="mono"
                style={{ fontSize: '0.75rem', whiteSpace: 'pre-wrap', color: 'var(--ink)', maxWidth: '78ch', lineHeight: 1.7 }}
              >
                {sel.body?.trim() || '(SKILL.md 无正文)'}
              </pre>
            </div>
          </>
        )}
      </Drawer>
    </>
  );
}

/** 近 30 天逐日触发迷你柱。加载中留出等高占位,避免抽屉内容跳动 */
function UsageSpark({ days }: { days: number[] | null }) {
  if (!days) return <div className="usage-spark" aria-hidden />;
  const max = Math.max(1, ...days);
  const total = days.reduce((a, b) => a + b, 0);
  if (total === 0) return <div className="usage-spark-empty">近 30 天没有触发记录</div>;
  return (
    <>
      <div className="usage-spark" role="img" aria-label={`近 ${days.length} 天逐日触发,峰值 ${max} 次`}>
        {days.map((d, i) => (
          <i
            key={i}
            className={d === 0 ? 'zero' : undefined}
            style={{ height: `${Math.max(2, Math.round((d / max) * 36))}px` }}
            title={`${d} 次`}
          />
        ))}
      </div>
      <div className="usage-spark-cap">
        <span>{days.length} 天前</span>
        <span>峰值 {max} 次/天</span>
        <span>今天</span>
      </div>
    </>
  );
}
