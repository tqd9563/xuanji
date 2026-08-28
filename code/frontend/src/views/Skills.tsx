import { useEffect, useState } from 'react';
import { api } from '@/api/client';
import type { Skill, SkillUsage } from '@/api/types';
import { usePoll, useIsMobile } from '@/lib/hooks';
import { Drawer, Empty, Tag, confirmBox, toast } from '@/components/shared';
import { Input } from '@/components/ui/input';

type Filter = 'all' | 'on' | 'off' | 'plugin';
/** 统计窗口(天),与后端 USAGE_WINDOWS 对齐 */
type Win = 7 | 30 | 90;
const WINDOWS: Win[] = [7, 30, 90];

const countOf = (s: Skill, w: Win): number => s.usage?.[`d${w}` as keyof SkillUsage] as number ?? 0;

const fmtDay = (ms?: number) => (ms ? new Date(ms).toLocaleDateString('zh-CN') : '从未触发');

export function Skills() {
  const { data, refresh } = usePoll(api.skills, 60_000);
  const [filter, setFilter] = useState<Filter>('all');
  const [win, setWin] = useState<Win>(30);
  /** 默认按启用+名称排;点「触发」列头切到按次数降序 */
  const [byUsage, setByUsage] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Skill | null>(null);
  const [daily, setDaily] = useState<number[] | null>(null);
  const isMobile = useIsMobile();

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

  const skills = data?.skills ?? [];
  const rows = skills.filter((s) => {
    if (filter === 'on' && !s.enabled) return false;
    if (filter === 'off' && s.enabled) return false;
    if (filter === 'plugin' && s.source !== 'plugin') return false;
    if (q && !(s.name + s.description).toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  if (byUsage) {
    rows.sort((a, b) => countOf(b, win) - countOf(a, win) || a.name.localeCompare(b.name));
  }
  /** 条宽按当前窗口内的最大值归一:换窗口后长短对比仍然成立 */
  const max = Math.max(1, ...rows.map((s) => countOf(s, win)));

  const caliber = (s: Skill) =>
    `近 ${win} 天触发 ${countOf(s, win)} 次\n最近触发:${fmtDay(s.usage?.lastUsedAt)}\n口径:${data?.usageCaliber ?? ''}`;

  const usageCell = (s: Skill) => {
    const n = countOf(s, win);
    return (
      <span className="usage-cell" title={caliber(s)}>
        <span className={`usage-n${n === 0 ? ' zero' : ''}`}>{n}</span>
        {n > 0 && <span className="usage-bar" style={{ width: `${Math.max(2, Math.round((n / max) * 72))}px` }} />}
      </span>
    );
  };

  return (
    <>
      <div className="view-head">
        <h1>技能</h1>
        <span className="sub">{skills.filter((s) => s.enabled).length} 个已启用 / 共 {skills.length} 个</span>
        <span className="spacer" />
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
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
        <Input type="search" placeholder="搜索技能…" style={{ width: 200 }} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="notice">
        <span className="ok" />
        触发次数统计自全部项目的会话日志(只读扫描,不写 <span className="mono">~/.claude</span>);
        关闭开关 = 把技能目录移入 <span className="mono">~/.claude/skills-disabled/</span>,新会话不再加载(可逆,二次确认后执行;插件技能不支持)
      </div>
      {isMobile ? (
        <div className="mcard-list">
          {rows.map((s) => (
            <div key={s.name} className="mcard" onClick={() => setSel(s)} role="button" tabIndex={0}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="mono" style={{ fontSize: '0.8125rem', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                    <span className="mono" style={{ color: 'var(--faint)', fontSize: '0.6875rem', flex: 'none' }}>v{s.version ?? '—'}</span>
                    {s.source === 'plugin' && <Tag>插件</Tag>}
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
                  aria-disabled={s.source === 'plugin'}
                  aria-label={`启用 ${s.name}`}
                  title={s.source === 'plugin' ? '插件技能走 plugin 配置,不支持目录启停' : undefined}
                  style={{ marginTop: 2, ...(s.source === 'plugin' ? { opacity: 0.55, cursor: 'not-allowed' } : undefined) }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (s.source === 'plugin') return;
                    void toggle(s);
                  }}
                />
              </div>
            </div>
          ))}
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
              {rows.map((s) => (
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
                      aria-disabled={s.source === 'plugin'}
                      title={s.source === 'plugin' ? '插件技能走 plugin 配置,不支持目录启停' : undefined}
                      style={s.source === 'plugin' ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (s.source === 'plugin') return;
                        void toggle(s);
                      }}
                    />
                  </td>
                </tr>
              ))}
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
          sel && (
            <>
              <Tag>{sel.source}</Tag>
              {sel.version && <span className="mono">v{sel.version}</span>}
              {sel.allowedTools && <span className="mono">{sel.allowedTools}</span>}
            </>
          )
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
