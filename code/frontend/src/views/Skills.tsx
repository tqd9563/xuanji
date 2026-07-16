import { useState } from 'react';
import { api } from '@/api/client';
import type { Skill } from '@/api/types';
import { usePoll, useIsMobile } from '@/lib/hooks';
import { Drawer, Empty, Tag, confirmBox, toast } from '@/components/shared';
import { Input } from '@/components/ui/input';

type Filter = 'all' | 'on' | 'off' | 'plugin';

export function Skills() {
  const { data, refresh } = usePoll(api.skills, 60_000);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Skill | null>(null);
  const isMobile = useIsMobile();

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

  return (
    <>
      <div className="view-head">
        <h1>技能</h1>
        <span className="sub">{skills.filter((s) => s.enabled).length} 个已启用 / 共 {skills.length} 个</span>
        <span className="spacer" />
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
          <table className="table">
            <thead>
              <tr>
                <th>名称</th><th>描述</th><th>版本</th><th>可调用</th><th>来源</th><th>启用</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.name} className="rowlink" onClick={() => setSel(s)}>
                  <td className="mono" style={{ fontSize: '0.8125rem', fontWeight: 600 }}>{s.name}</td>
                  <td><div className="skill-desc">{s.description}</div></td>
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
            <pre
              className="mono"
              style={{ fontSize: '0.75rem', whiteSpace: 'pre-wrap', color: 'var(--ink)', maxWidth: '78ch', lineHeight: 1.7 }}
            >
              {sel.body?.trim() || '(SKILL.md 无正文)'}
            </pre>
          </>
        )}
      </Drawer>
    </>
  );
}
