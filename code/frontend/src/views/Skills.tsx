import { useState } from 'react';
import { api } from '@/api/client';
import type { Skill } from '@/api/types';
import { usePoll } from '@/lib/hooks';
import { Drawer, Empty, Tag } from '@/components/shared';
import { Input } from '@/components/ui/input';

type Filter = 'all' | 'on' | 'off' | 'plugin';

export function Skills() {
  const { data } = usePoll(api.skills, 60_000);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Skill | null>(null);

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
        M1 只读:启停开关将在 M2 开放(移动技能目录,显式写操作 + 二次确认)
      </div>
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
                    aria-disabled="true"
                    title="M1 只读,启停在 M2 开放"
                    style={{ opacity: 0.55, cursor: 'not-allowed' }}
                    onClick={(e) => e.stopPropagation()}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <Empty><p>没有匹配的技能。</p></Empty>}
      </div>

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
