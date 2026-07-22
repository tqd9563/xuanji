import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api/client';
import type { Memory } from '@/api/types';
import { usePoll } from '@/lib/hooks';
import { Drawer, Empty } from '@/components/shared';
import { Input } from '@/components/ui/input';

type TypeFilter = 'all' | 'user' | 'feedback' | 'project' | 'reference' | 'cross-project';
const TYPE_LABEL: Record<string, string> = {
  user: 'user',
  feedback: 'feedback',
  project: 'project',
  reference: 'reference',
  'cross-project': 'cross-project',
  unknown: '?',
};

export function Memories() {
  const { data } = usePoll(api.memories, 60_000);
  const [type, setType] = useState<TypeFilter>('all');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Memory[] | null>(null);
  const [sel, setSel] = useState<Memory | null>(null);

  // 搜索防抖:FTS5 服务端检索
  useEffect(() => {
    if (!q.trim()) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      api.searchMemories(q.trim()).then((r) => setResults(r.memories), () => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const all = results ?? data?.memories ?? [];
  const filtered = type === 'all' ? all : all.filter((m) => m.type === type);

  const groups = useMemo(() => {
    const map = new Map<string, Memory[]>();
    for (const m of filtered) {
      const arr = map.get(m.project) ?? [];
      arr.push(m);
      map.set(m.project, arr);
    }
    return [...map.entries()];
  }, [filtered]);

  const openByName = (name: string) => {
    const target = (data?.memories ?? []).find((m) => m.name === name);
    if (target) setSel(target);
  };

  return (
    <>
      <div className="view-head">
        <h1>经验</h1>
        <span className="sub">{data ? `${data.memories.length} 条,来自 ${new Set(data.memories.map((m) => m.project)).size} 个项目` : '加载中…'}</span>
      </div>
      <div className="mem-toolbar">
        <Input
          type="search"
          placeholder="全文搜索(FTS5):这个坑以前踩过没…"
          style={{ width: 320 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="filter-tabs">
          {(['all', 'user', 'feedback', 'project', 'reference', 'cross-project'] as TypeFilter[]).map((f) => (
            <button key={f} className={type === f ? 'active' : ''} onClick={() => setType(f)}>
              {f === 'all' ? '全部' : f}
            </button>
          ))}
        </div>
      </div>

      {groups.map(([project, mems]) => (
        <div className="mem-group" key={project}>
          <h2>
            {project} <span className="path">{mems[0]?.projectPath}</span>
          </h2>
          <div className="panel">
            {mems.map((m) => (
              <div className="mem-item" key={m.file} onClick={() => setSel(m)}>
                <span className={`type-${m.type}`}>{TYPE_LABEL[m.type]}</span>
                <span className="name">{m.name}</span>
                <span className="desc">{m.description}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      {filtered.length === 0 && (
        <Empty>
          <p>{q ? `没有匹配「${q}」的经验。` : '还没有经验沉淀。'}</p>
        </Empty>
      )}

      <Drawer
        open={sel !== null}
        onClose={() => setSel(null)}
        title={sel?.name ?? ''}
        meta={
          sel && (
            <>
              <span className={`type-${sel.type}`}>{TYPE_LABEL[sel.type]}</span>
              <span>{sel.project}</span>
              <span className="mono" style={{ fontSize: '0.6875rem' }}>{sel.file}</span>
            </>
          )
        }
        foot={
          sel && sel.links.length > 0 ? (
            <>
              <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>关联:</span>
              {sel.links.map((l) => (
                <button key={l} className="wikilink" onClick={() => openByName(l)}>
                  [[{l}]]
                </button>
              ))}
            </>
          ) : undefined
        }
      >
        {sel && (
          <div className="mem-body" style={{ whiteSpace: 'pre-wrap' }}>
            {sel.description && <p style={{ color: 'var(--muted)', marginBottom: 14 }}>{sel.description}</p>}
            {sel.body}
          </div>
        )}
      </Drawer>
    </>
  );
}
