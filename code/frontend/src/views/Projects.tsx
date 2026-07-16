import { useState } from 'react';
import { api } from '@/api/client';
import { usePoll, useIsMobile } from '@/lib/hooks';
import { timeAgo } from '@/lib/utils';
import { Empty } from '@/components/shared';
import { Input } from '@/components/ui/input';
import type { Project } from '@/api/types';

/** 移动端单列卡片:多列网格挤压的表格在窄屏重排为一张卡一个项目,而非等比缩小(DESIGN.md 移动端章节) */
function ProjectCard({ p }: { p: Project }) {
  return (
    <div className="mcard proj-card">
      <div className="top" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="title" style={{ fontWeight: 600, fontSize: '0.9375rem', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
        {p.git && <span className="mono" style={{ color: 'var(--muted)', fontSize: '0.75rem', flex: 'none' }}>⎇ {p.git.branch}</span>}
      </div>
      <div className="mono" style={{ color: 'var(--faint)', fontSize: '0.6875rem', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.path}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, fontSize: '0.75rem', color: 'var(--muted)', flexWrap: 'wrap' }}>
        <span>会话 <b className="mono" style={{ color: 'var(--ink)' }}>{p.sessionCount}</b></span>
        <span>经验 <b className="mono" style={{ color: 'var(--ink)' }}>{p.memoryCount || '—'}</b></span>
        {p.git && (p.git.modified > 0 || p.git.untracked > 0) && (
          <span className="dirty">
            {p.git.modified > 0 && `!${p.git.modified} `}
            {p.git.untracked > 0 && `?${p.git.untracked}`}
          </span>
        )}
        {p.git && (p.git.ahead ?? 0) > 0 && <span style={{ color: 'var(--blue)' }}>↑{p.git.ahead}</span>}
        <span style={{ color: 'var(--faint)' }}>{timeAgo(p.lastActiveAt)}</span>
        <span className="spark" style={{ marginLeft: 'auto' }}>
          {p.heat.map((v, i) => (
            <i key={i} style={{ height: v === 0 ? 2 : 4 + (Math.min(v, 12) / 12) * 16, opacity: v === 0 ? 0.25 : 1 }} />
          ))}
        </span>
      </div>
    </div>
  );
}

export function Projects() {
  const { data } = usePoll(api.projects, 60_000);
  const [q, setQ] = useState('');
  const isMobile = useIsMobile();

  const rows = (data?.projects ?? []).filter(
    (p) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.path.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <>
      <div className="view-head">
        <h1>项目</h1>
        <span className="sub">
          {data
            ? `${data.projects.length} 个有效项目 · 已按规则过滤 ${data.filteredNoise} 个临时目录与 ${data.filteredMissing} 个失效路径`
            : '加载中…'}
        </span>
        <span className="spacer" />
        <Input type="search" placeholder="搜索项目名或路径…" style={{ width: 220 }} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {isMobile ? (
        <div className="mcard-list">
          {rows.map((p) => <ProjectCard key={p.encodedDir} p={p} />)}
          {rows.length === 0 && data && <Empty><p>没有匹配「{q}」的项目。</p></Empty>}
        </div>
      ) : (
        <div className="panel">
          <table className="table">
            <thead>
              <tr>
                <th>项目</th><th>git</th><th>会话</th><th>经验</th><th>近 7 日</th><th>最近活动</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.encodedDir}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div className="mono" style={{ color: 'var(--faint)' }}>{p.path}</div>
                  </td>
                  <td>
                    {p.git ? (
                      <>
                        <span className="mono" style={{ color: 'var(--muted)' }}>{p.git.branch}</span>
                        <div style={{ fontSize: '0.6875rem' }}>
                          {p.git.modified > 0 && <span className="dirty">!{p.git.modified} </span>}
                          {p.git.untracked > 0 && <span className="dirty">?{p.git.untracked} </span>}
                          {(p.git.ahead ?? 0) > 0 && <span style={{ color: 'var(--blue)' }}>↑{p.git.ahead}</span>}
                        </div>
                      </>
                    ) : (
                      <span style={{ color: 'var(--faint)' }}>—</span>
                    )}
                  </td>
                  <td>{p.sessionCount}</td>
                  <td>{p.memoryCount || <span style={{ color: 'var(--faint)' }}>—</span>}</td>
                  <td>
                    <div className="spark">
                      {p.heat.map((v, i) => (
                        <i key={i} style={{ height: v === 0 ? 2 : 4 + Math.min(v, 12) / 12 * 16, opacity: v === 0 ? 0.25 : 1 }} />
                      ))}
                    </div>
                  </td>
                  <td style={{ color: 'var(--muted)', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>{timeAgo(p.lastActiveAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && data && (
            <Empty><p>没有匹配「{q}」的项目。</p></Empty>
          )}
        </div>
      )}
    </>
  );
}
