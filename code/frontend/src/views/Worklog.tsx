import { useMemo, useState } from 'react';
import { api } from '@/api/client';
import type { WorklogCard } from '@/api/types';
import { usePoll, useIsMobile } from '@/lib/hooks';
import { Drawer, Empty, Md, ProjChip, Tag } from '@/components/shared';
import { Input } from '@/components/ui/input';

type Filter = 'all' | 'merged' | 'pending-merge' | 'unresolved';

/** 状态语义(对齐 DESIGN.md):绿=彻底完事、蓝=事实标注、琥珀=需要你回来处理 */
const STATUS: Record<WorklogCard['status'], { cls: string; label: string; dot: boolean }> = {
  merged: { cls: 'pill-done', label: '已合并', dot: false },
  'pending-merge': { cls: 'pill-sched', label: '待合并', dot: false },
  unresolved: { cls: 'pill-blk', label: '未解决', dot: true },
  unknown: { cls: 'pill-idle', label: '未标注', dot: false },
};

/** 状态胶囊:回顾页的「本周总结」面板复用同一份,避免同一语义在两处长得不一样 */
export function WorklogStatusPill({ s }: { s: WorklogCard['status'] }) {
  const m = STATUS[s];
  return (
    <span className={`pill ${m.cls}`} style={{ flex: 'none' }}>
      {m.dot && <span className="dot" />}
      {m.label}
    </span>
  );
}

/** 「无」是卡片模板里的合法写法,不当作真实残留 */
function realResidue(c: WorklogCard): string[] {
  return c.sections.residue.filter((r) => r.trim() !== '无' && r.trim() !== '暂无');
}

export function Worklog({ onGoSession }: { onGoSession: (sessionId: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<WorklogCard | null>(null);
  const isMobile = useIsMobile();
  // 过滤在前端做:卡片总量是几百量级,本地过滤比每次改条件都打一次后端更跟手
  const { data } = usePoll(api.worklog, 60_000);

  const cards = useMemo(() => data?.cards ?? [], [data]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cards.filter((c) => {
      if (filter !== 'all' && c.status !== filter) return false;
      if (!needle) return true;
      const hay = [
        c.task, c.project, c.branch ?? '',
        c.sections.problem ?? '', c.sections.conclusion ?? '',
        ...c.sections.excluded, ...c.sections.residue, ...c.sections.files,
      ].join('\n').toLowerCase();
      return hay.includes(needle);
    });
  }, [cards, filter, q]);

  /** 按日期分组(卡片已按日期倒序,这里保序聚合即可) */
  const groups = useMemo(() => {
    const m = new Map<string, WorklogCard[]>();
    for (const c of rows) {
      const k = c.date || '(无日期)';
      const arr = m.get(k);
      if (arr) arr.push(c);
      else m.set(k, [c]);
    }
    return [...m.entries()];
  }, [rows]);

  const unresolved = cards.filter((c) => c.status === 'unresolved').length;

  return (
    <>
      <div className="view-head">
        <h1>总结</h1>
        <span className="sub">
          {rows.length} 条{rows.length !== cards.length && ` / 共 ${cards.length} 条`}
          {unresolved > 0 && <span style={{ color: 'var(--amber)' }}> · {unresolved} 条未解决</span>}
        </span>
        <span className="spacer" />
        <div className="filter-tabs">
          {(
            [['all', '全部'], ['merged', '已合并'], ['pending-merge', '待合并'], ['unresolved', '未解决']] as [Filter, string][]
          ).map(([f, label]) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
        <Input
          type="search"
          placeholder="搜索结论 / 排除项 / 残留…"
          style={{ width: isMobile ? '100%' : 220 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="notice">
        <span className="ok" />
        只读扫描 <span className="mono">~/.claude/worklog/</span> · 由派发会话内的 wrapup skill 生成,璇玑不写入 ·
        在派发页输入 /wrapup 沉淀一条
      </div>

      {rows.length === 0 ? (
        <Empty>
          <p>{cards.length === 0 ? '还没有任何任务总结。' : '没有匹配的总结。'}</p>
          <p style={{ color: 'var(--faint)' }}>任务验收后在派发页输入 /wrapup 即可沉淀一条。</p>
        </Empty>
      ) : (
        <div className="panel">
          {groups.map(([date, list], gi) => (
            <div key={date} className="wl-group" style={gi > 0 ? { borderTop: '1px solid var(--line-soft)' } : undefined}>
              <h2>{date}</h2>
              {list.map((c) => (
                <button key={c.name} className="wl-item" onClick={() => setSel(c)}>
                  <ProjChip name={c.project} />
                  <span className="task">{c.task}</span>
                  {c.degraded && <Tag>格式异常</Tag>}
                  <span className="anchors">
                    {c.commits.length > 0 ? `${c.commits.length} commit` : '无 commit'}
                  </span>
                  <WorklogStatusPill s={c.status} />
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      <Drawer
        open={sel !== null}
        onClose={() => setSel(null)}
        title={sel?.task ?? ''}
        meta={
          sel && (
            <>
              <ProjChip name={sel.project} />
              <WorklogStatusPill s={sel.status} />
              <span className="mono">{sel.date}</span>
            </>
          )
        }
        foot={sel && <span className="mono" style={{ fontSize: '0.6875rem', color: 'var(--faint)' }}>{sel.file} · 只读</span>}
      >
        {sel && <CardDetail card={sel} onGoSession={onGoSession} />}
      </Drawer>
    </>
  );
}

function CardDetail({ card, onGoSession }: { card: WorklogCard; onGoSession: (sessionId: string) => void }) {
  const residue = realResidue(card);
  const s = card.sections;
  return (
    <>
      <dl className="kv">
        {card.branch && <><dt>分支</dt><dd className="mono">{card.branch}</dd></>}
        <dt>commits</dt>
        <dd className="mono">{card.commits.length > 0 ? card.commits.join(' · ') : '—(排障任务,结论全在本卡)'}</dd>
        {card.mr && <><dt>MR</dt><dd className="mono">{card.mr}</dd></>}
        {card.refs.length > 0 && <><dt>锚点</dt><dd className="mono">{card.refs.join(' · ')}</dd></>}
        {card.session && (
          <>
            <dt>会话</dt>
            <dd>
              {/* 真实转录恒在 session jsonl,只读回放是唯一入口(与定时任务「结果会话」同一词汇) */}
              <button className="sid-link" onClick={() => onGoSession(card.session!)} title="打开只读回放">
                {card.session}
              </button>
            </dd>
          </>
        )}
        {card.coversUntil && <><dt>覆盖至</dt><dd className="mono">{card.coversUntil}</dd></>}
      </dl>

      {/* 卡片正文是 markdown(粗体主题词、反引号里的路径与符号是 wrapup 模板的固定写法),
          一律走全站统一的 Md 渲染,不能当纯文本贴——否则满屏字面量 ** 和反引号。 */}
      {residue.length > 0 && (
        <div className="residue">
          <div className="r-head">已知残留 · {residue.length} 条</div>
          <div className="wl-body md">
            <ul>{residue.map((r, i) => <li key={i}><Md>{r}</Md></li>)}</ul>
          </div>
        </div>
      )}

      <div className="wl-body md">
        {s.problem && <><h3>问题</h3><Md>{s.problem}</Md></>}
        {s.conclusion && <><h3>结论</h3><Md>{s.conclusion}</Md></>}
        {s.excluded.length > 0 && (
          <><h3>排除项</h3><ul>{s.excluded.map((x, i) => <li key={i}><Md>{x}</Md></li>)}</ul></>
        )}
        {residue.length === 0 && <><h3>已知残留</h3><p>无</p></>}
        {s.decisions.length > 0 && (
          <><h3>关键决策</h3><ul>{s.decisions.map((x, i) => <li key={i}><Md>{x}</Md></li>)}</ul></>
        )}
        {s.files.length > 0 && (
          <><h3>涉及文件</h3><ul>{s.files.map((x, i) => <li key={i} className="file"><Md>{x}</Md></li>)}</ul></>
        )}
        {s.raw && <><h3>{card.degraded ? '原文' : '其它段落'}</h3><pre>{s.raw}</pre></>}
      </div>
    </>
  );
}
