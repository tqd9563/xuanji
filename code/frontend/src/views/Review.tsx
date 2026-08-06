import { useMemo, useState } from 'react';
import { api } from '@/api/client';
import type { ReviewProject, WeeklyDraft, WorklogCard } from '@/api/types';
import { usePoll, useIsMobile } from '@/lib/hooks';
import { fmtCost, projColor } from '@/lib/utils';
import { Empty, Md, ProjChip, toast } from '@/components/shared';
import { WorklogStatusPill } from '@/views/Worklog';

const DAY = 86_400_000;

/** 本地日界:offset 周(0=最近 7 天含今天,1=上一周…)→ [start, end] ms */
function weekWindow(offset: number): { start: number; end: number } {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  const lastDay = t.getTime() - offset * 7 * DAY; // 窗口最后一天 00:00
  return { start: lastDay - 6 * DAY, end: lastDay + DAY - 1 };
}

function fmtDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 窗口逐日标签,[start..end] 每天 M/D */
function dayLabels(start: number, dayCount: number): string[] {
  const out: string[] = [];
  const d0 = new Date(start);
  d0.setHours(0, 0, 0, 0);
  for (let i = 0; i < dayCount; i++) out.push(fmtDay(d0.getTime() + i * DAY));
  return out;
}

export function Review() {
  const isMobile = useIsMobile();
  const [offset, setOffset] = useState(0);
  const { start, end } = useMemo(() => weekWindow(offset), [offset]);
  const { data } = usePoll(() => api.weeklyReview(start, end), 0, [start, end]);

  // 草稿:轮询列表,匹配当前窗口取最新一条;生成中时加速轮询
  const [draftId, setDraftId] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const draftsPoll = usePoll(api.weeklyDrafts, 4000);
  const draft = useMemo<WeeklyDraft | null>(() => {
    const list = (draftsPoll.data?.drafts ?? []).filter((d) => d.rangeStart === start && d.rangeEnd === end);
    if (draftId != null) {
      const byId = list.find((d) => d.id === draftId);
      if (byId) return byId;
    }
    return list.sort((a, b) => b.id - a.id)[0] ?? null;
  }, [draftsPoll.data, start, end, draftId]);
  const generating = starting || draft?.status === 'running';

  const genDraft = async () => {
    setStarting(true);
    try {
      const { id } = await api.startWeeklyDraft(start, end);
      setDraftId(id);
      toast('周报草稿生成中 · 已入会话看板可跟踪');
      draftsPoll.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : '生成失败');
    } finally {
      setStarting(false);
    }
  };

  const range = data ? `${fmtDay(data.range.start)} – ${fmtDay(data.range.end)}` : `${fmtDay(start)} – ${fmtDay(end)}`;
  const labels = data ? dayLabels(data.range.start, data.range.dayCount) : [];
  const maxHeat = data ? Math.max(1, ...data.projects.flatMap((p) => p.days)) : 1;

  return (
    <>
      <div className="view-head">
        <h1>回顾</h1>
        <div className="week-nav">
          <button className="wk-btn" onClick={() => setOffset((o) => o + 1)} title="上一周">‹</button>
          <span className="range">{range}</span>
          <button className="wk-btn" onClick={() => setOffset((o) => Math.max(0, o - 1))} disabled={offset === 0} title="下一周">›</button>
        </div>
        {offset === 0 && <span className="pill pill-run"><span className="dot" />本周</span>}
        <span className="spacer" />
        <button className="btn btn-primary" onClick={genDraft} disabled={generating || !data}>✦ 生成周报草稿</button>
      </div>

      {isMobile ? (
        // 移动端:原型 stat-grid 2×2 卡片(见 wiki/design/prototype-mobile.html #v-review),
        // 桌面版一行文字条信息密度更高、更适合宽屏,故不改
        <div className="stat-grid" title={data?.caliber.active}>
          <div className="cell"><div className="k">prompt</div><div className="v">{data?.totals.prompts ?? '—'} <small>条</small></div></div>
          <div className="cell"><div className="k">会话</div><div className="v">{data?.totals.sessions ?? '—'} <small>个 · {data?.totals.projects ?? '—'} 项目</small></div></div>
          <div className="cell" title={data?.caliber.cards}><div className="k">任务总结</div><div className="v">{data?.cards.length ?? '—'} <small>条</small></div></div>
          <div className="cell"><div className="k">成本</div><div className="v">{data ? fmtCost(data.totals.costUsd) : '—'}</div></div>
        </div>
      ) : (
        <div className="panel dash-strip" title={data?.caliber.active}>
          <span>prompt <b>{data?.totals.prompts ?? '—'}</b> 条</span>
          <span>会话 <b>{data?.totals.sessions ?? '—'}</b> 个</span>
          <span>项目 <b>{data?.totals.projects ?? '—'}</b> 个</span>
          <span>活跃 <b>{data?.totals.activeDays ?? '—'}</b> 天</span>
          <span title={data?.caliber.cards}>总结 <b>{data?.cards.length ?? '—'}</b> 条</span>
          <span>成本 <b>{data ? fmtCost(data.totals.costUsd) : '—'}</b></span>
        </div>
      )}

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h2>本周热力</h2>
          <span className="sub" title={data?.caliber.active}>按项目 × 日 · 我发出的 prompt 数(history.jsonl ∪ 璇玑派发流水)</span>
        </div>
        <div className="heat">
          {data && data.projects.length === 0 && <div className="empty" style={{ padding: 16 }}><p>本周还没有活动。</p></div>}
          {data?.projects.slice(0, 8).map((p) => (
            <div className="heat-row" key={p.path}>
              <span className="lbl" style={{ color: projColor(p.project) }}>{p.project}</span>
              {p.days.map((v, i) => (
                <div
                  key={i}
                  className="heat-cell"
                  title={`${labels[i] ?? ''} · ${v} 条`}
                  style={v ? { background: `oklch(0.72 0.11 115 / ${(0.15 + 0.85 * (v / maxHeat)).toFixed(3)})` } : undefined}
                />
              ))}
            </div>
          ))}
          {data && data.projects.length > 0 && (
            <div className="heat-days"><span />{labels.map((d, i) => <span key={i}>{d}</span>)}</div>
          )}
        </div>
      </div>

      <div className="rv-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <div className="panel">
          <div className="panel-head">
            <h2 style={{ whiteSpace: 'nowrap' }}>本周总结</h2>
            <span className="sub">周报的第一物料 · 点条目去「总结」模块</span>
          </div>
          {!data && <div className="empty" style={{ padding: 20 }}><p>加载中…</p></div>}
          {data && data.cards.length === 0 && (
            <Empty>
              <p>本周还没有任务总结。</p>
              <p style={{ color: 'var(--faint)' }}>任务验收后在派发页点「⚑ 任务总结」(⌘⏎)沉淀一条,周报会更准、更省。</p>
            </Empty>
          )}
          {data?.cards.map((c) => <ReviewCardRow key={c.name} c={c} />)}
        </div>
        <div className="panel">
          <div className="panel-head"><h2>活跃会话</h2><span className="sub">按项目分组 · 点会话展开 prompt 原文</span></div>
          {!data && <div className="empty" style={{ padding: 20 }}><p>加载中…</p></div>}
          {data && data.projects.length === 0 && <Empty><p>本周没有活跃会话。</p></Empty>}
          {data?.projects.map((p) => <ReviewProjectRow key={p.path} p={p} />)}
        </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2 style={{ whiteSpace: 'nowrap' }}>周报草稿</h2>
            <span className="sub">{draft?.model ?? 'sonnet'} 生成</span>
            <span className="spacer" />
            {draft?.status === 'done' && draft.content && (
              <span style={{ display: 'flex', gap: 6, flex: 'none' }}>
                <button className="btn btn-sm" onClick={() => { void navigator.clipboard?.writeText(draft.content ?? ''); toast('已复制 markdown'); }}>复制</button>
                <button className="btn btn-sm" onClick={() => { location.hash = 'sessions'; toast('草稿会话在看板中,可续接修改'); }}>在看板打开</button>
                <button className="btn btn-sm btn-quiet" onClick={genDraft} disabled={generating} title="重新生成">↻</button>
              </span>
            )}
          </div>
          <DraftPanel draft={draft} generating={!!generating} totals={data?.totals} cardCount={data?.cards.length} />
        </div>
      </div>
    </>
  );
}

/** 本周总结的紧凑行:与「总结」模块同一套词汇(项目芯片 + 状态胶囊),详情不在此展开——
 *  这里是周报物料的预览,下钻走「总结」模块,避免同一份详情在两处各维护一套。 */
function ReviewCardRow({ c }: { c: WorklogCard }) {
  return (
    <button className="rvwl-item" onClick={() => { location.hash = 'worklog'; }} title={c.sections.conclusion ?? c.task}>
      <span className="d">{c.date.slice(5).replace('-', '/')}</span>
      <ProjChip name={c.project} />
      <span className="t">{c.task}</span>
      <WorklogStatusPill s={c.status} />
    </button>
  );
}

function ReviewProjectRow({ p }: { p: ReviewProject }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  return (
    <div className="rv-proj">
      <div className="rv-proj-head">
        <ProjChip name={p.project} path={p.path} />
        <span className="m">{p.prompts} prompts · {p.sessions.length} 会话{p.commits.length ? ` · ${p.commits.length} commits` : ''}</span>
        <span className="cost">{fmtCost(p.costUsd)}</span>
      </div>
      {p.sessions.map((s, si) => {
        const k = `${si}`;
        const isOpen = open.has(k);
        return (
          <div className={`rv-item ${isOpen ? 'open' : ''}`} key={si}>
            <button className="rv-sess" onClick={() => toggle(k)} aria-expanded={isOpen}>
              <span className="chev">▶</span>
              <span className="t">{s.title}</span>
              {s.source === 'web' && <span className="tag">璇玑</span>}
              <span className="n">{s.prompts} 条</span>
              <span className="span">{fmtDay(s.firstAt)} – {fmtDay(s.lastAt)}</span>
            </button>
            <ul className="rv-prompts">
              {s.promptTexts.map((t, i) => <li key={i} title={t}>{t}</li>)}
              {s.prompts > s.promptTexts.length && (
                <li className="more">…其余 {s.prompts - s.promptTexts.length} 条(样本封顶)</li>
              )}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function DraftPanel({
  draft,
  generating,
  totals,
  cardCount,
}: {
  draft: WeeklyDraft | null;
  generating: boolean;
  totals?: { prompts: number; sessions: number };
  cardCount?: number;
}) {
  // 零卡:草稿会退回全量流水扫描,准确率与消耗都更差,提前把代价讲清楚而不是事后解释
  const noCards = cardCount === 0 && (
    <div className="notice-amber" style={{ margin: '12px 18px 0' }}>
      本周暂无任务总结,草稿将退回原始流水扫描生成——准确率与 token 消耗都较差,建议先在派发页收几条总结再生成。
    </div>
  );
  if (generating && draft?.status !== 'done') {
    return (
      <div className="draft-run">
        <span className="typing"><i /><i /><i /></span>
        正在从 {cardCount ? `${cardCount} 条任务总结 + ` : ''}{totals?.prompts ?? '—'} 条 prompt、{totals?.sessions ?? '—'} 个会话的素材生成草稿…会话已入看板可跟踪
      </div>
    );
  }
  if (draft?.status === 'error') {
    return <div className="empty" style={{ padding: 24 }}><div className="glyph">⚠</div><p>生成失败:{draft.error}</p></div>;
  }
  if (!draft || !draft.content) {
    return (
      <>
        {noCards}
        <Empty>
          <p>
            本周还没有草稿。点右上「生成周报草稿」,由 AI 写一份按项目分组的周报——
            {cardCount ? `以本周 ${cardCount} 条任务总结为主体` : '以活动流水为素材'},未被总结覆盖的项目再用 prompt 流水与 commits 补齐。
          </p>
          <p style={{ color: 'var(--faint)' }}>不读会话全文;生成会话入看板,完成后待验收提醒。</p>
        </Empty>
      </>
    );
  }
  return (
    <>
      {noCards}
      <div className="draft-body md">
        <Md>{draft.content}</Md>
      </div>
      <div className="draft-meta">
        <span>模型 {draft.model}</span>
        {draft.finishedAt && <span>生成于 {new Date(draft.finishedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
        {draft.sessionId && <span>会话 <span className="mono">{draft.sessionId.slice(0, 8)}</span></span>}
        <span>素材口径:prompt 流 ∪ 璇玑派发流水 + git 题目</span>
      </div>
    </>
  );
}
