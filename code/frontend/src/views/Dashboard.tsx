import { useEffect, useState } from 'react';
import { api } from '@/api/client';
import type { ProjectUsage, SessionUsage } from '@/api/types';
import { usePoll } from '@/lib/hooks';
import { setDispatchIntent } from '@/lib/dispatch';
import { clock, fmtCost, fmtTokens, isUnread, modelColor, projColor, timeAgo } from '@/lib/utils';
import { Pill, ProjChip, Tag } from '@/components/shared';
import { isStale, startTodo, useTodosChanged } from '@/views/Todos';

const clockFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const dateFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="clock" title="北京时间(UTC+8)">
      <span className="date">{dateFmt.format(now).replace(/\//g, '-')}</span>
      <span id="dash-clock">{clockFmt.format(now)}</span>
    </span>
  );
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 热力图横轴:近 7 天 → 「周几 … 昨 今」,悬停见完整日期 */
function heatDayLabels(): { short: string; full: string }[] {
  const out: { short: string; full: string }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const wd = WEEKDAYS[d.getDay()]!;
    out.push({
      short: i === 0 ? '今' : i === 1 ? '昨' : wd,
      full: `${d.getMonth() + 1}/${d.getDate()} 周${wd}`,
    });
  }
  return out;
}

/** 仪表盘待办卡:只露前 N 条未完成的,整理与回顾去「待办」模块 */
const DASH_TODO_N = 5;

function DashTodos() {
  const { data, refresh } = usePoll(api.todos, 30_000);
  useTodosChanged(refresh);
  const all = data?.todos ?? [];
  const undone = all.filter((t) => t.status !== 'done');
  if (undone.length === 0) return null; // 没有待办时不占位:仪表盘只显示需要行动的东西

  const stale = undone.filter(isStale).length;
  return (
    <div className="panel dash-todos">
      <div className="panel-head">
        <h2>待办</h2>
        <span className="sub">
          {undone.length} 条未完成
          {stale > 0 && <span style={{ color: 'var(--amber)' }}> · {stale} 条超过 3 天</span>}
        </span>
        <span className="spacer" />
        <span className="sub mono" title="任意页面按 ⌘J 速记一条待办">⌘J 速记</span>
      </div>
      {undone.slice(0, DASH_TODO_N).map((t) => (
        <div key={t.id} className="dash-todo-item">
          <span className="t" title={t.title}>{t.title}</span>
          {t.project && <ProjChip name={t.project} path={t.cwd ?? undefined} />}
          <span className="age mono" title={new Date(t.createdAt).toLocaleString('zh-CN')}>{timeAgo(t.createdAt)}</span>
          <button className="td-go" onClick={() => startTodo(t)}>
            {t.status === 'doing' ? '继续 ▶' : '开工 ▶'}
          </button>
        </div>
      ))}
      <div className="dash-todo-foot">
        <button onClick={() => (location.hash = 'todo')}>
          在待办模块中查看全部 {undone.length} 条 →
        </button>
      </div>
    </div>
  );
}

export function Dashboard({ onGoSession }: { onGoSession: (sessionId: string) => void }) {
  const { data } = usePoll(api.dashboard, 15_000);

  if (!data) return <div className="view-head"><h1>仪表盘</h1><span className="sub">加载中…</span></div>;

  const maxHeat = Math.max(1, ...data.heat.flatMap((h) => h.days));
  const dayLabels = heatDayLabels();
  /**
   * 待处置队列 = 验收中列全体。已看过但没做决定的卡必须留下——
   * 它们正是「看过一眼就忘」的堆积来源,只按未读过滤会把它们藏起来。
   */
  const reviewable = data.reviewCandidates ?? [];
  const goSession = (s: (typeof reviewable)[number]) => {
    if (s.dispatchId) {
      setDispatchIntent({ attach: { dispatchId: s.dispatchId, cwd: s.cwd, name: s.name, project: s.project } });
      location.hash = 'dispatch';
      return;
    }
    if (s.readonly) return onGoSession(s.sessionId);
    setDispatchIntent({ resume: { sessionId: s.sessionId, name: s.name, cwd: s.cwd, project: s.project } });
    location.hash = 'dispatch';
  };

  return (
    <>
      <div className="view-head">
        <h1>仪表盘</h1>
        <span className="spacer" />
        <Clock />
      </div>

      <div className="dash-now">
        <div className="panel">
          <div className="panel-head">
            <h2>需要你处理</h2>
            <Pill state="blocked" label={String(data.needsAttention.length + reviewable.length)} />
          </div>
          <div>
            {data.needsAttention.length === 0 && reviewable.length === 0 && (
              <div className="empty" style={{ padding: '20px' }}><p>没有等待你的会话。</p></div>
            )}
            {data.needsAttention.map((s) => (
              <div className="need-item" key={s.id}>
                <div className="what">
                  <div className="t">
                    {s.name} <ProjChip name={s.project} path={s.cwd} />{' '}
                    <span className="tag t-unread">等输入</span>{' '}
                    <Tag>{s.source === 'web' ? 'web' : s.kind === 'background' ? '后台' : '终端'}</Tag>
                  </div>
                  <div className="n">{s.needs ?? s.detail ?? '等待输入'}</div>
                </div>
                <button className="btn btn-sm btn-primary" onClick={() => goSession(s)}>
                  {s.readonly ? '查看' : '去回复'}
                </button>
              </div>
            ))}
            {reviewable.map((s) => (
              <div className="need-item" key={s.id}>
                <div className="what">
                  <div className="t">
                    {s.name} <ProjChip name={s.project} path={s.cwd} />{' '}
                    {/* 没看过的用琥珀实心催,看过没决定的用紫罗兰描边:轻重分明,但都不放过 */}
                    {isUnread(s) ? (
                      <span className="tag t-unread">待验收</span>
                    ) : (
                      <span className="tag t-susp">待处置</span>
                    )}{' '}
                    <Tag>{s.source === 'web' ? 'web' : s.kind === 'background' ? '后台' : '终端'}</Tag>
                  </div>
                  <div className="n plain">{s.detail ?? '回合结束,等你验收'}</div>
                </div>
                <button className="btn btn-sm btn-primary" onClick={() => goSession(s)}>
                  {isUnread(s) ? '去验收' : '去处置'}
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>运行中</h2>
            <Pill state="running" label={String(data.running.length)} />
          </div>
          <div>
            {data.running.length === 0 && (
              <div className="empty" style={{ padding: '20px' }}><p>机群静默。</p></div>
            )}
            {data.running.map((s) => (
              <div className="run-item" key={s.id}>
                <span className="pill pill-run"><span className="dot" /></span>
                <b style={{ fontSize: '0.8125rem' }}>{s.name}</b>
                <ProjChip name={s.project} path={s.cwd} />
                {s.readonly && <Tag>只读</Tag>}
                <span className="d">{s.detail ?? s.cwd}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 待办:紧随「需要你处理 / 运行中」之下、统计条之上。仪表盘的纵向顺序是一条紧急度梯度
          (会话在等你 → 机器在跑 → 你欠自己的事 → 统计 → 历史),待办正落在第三层。 */}
      <DashTodos />

      <div className="panel dash-strip" title={data.caliber.usage}>
        <span>今日 prompt <b>{data.strip.todayPrompts}</b> 条</span>
        <span>
          今日 token <b>{fmtTokens(data.strip.todayTokensInOut)}</b> · 成本 <b>{fmtCost(data.strip.todayCostUsd)}</b>
        </span>
        <span>活跃项目 <b>{data.strip.activeProjects}</b> 个</span>
        <span>
          定时任务 <b>{data.strip.scheduledJobs.normal}</b> 个正常
          {data.strip.scheduledJobs.fused > 0 && (
            <> · <b style={{ color: 'var(--red)' }}>{data.strip.scheduledJobs.fused}</b> 个熔断</>
          )}
          {data.strip.scheduledJobs.missed > 0 && (
            <> · <b style={{ color: 'var(--amber)' }}>{data.strip.scheduledJobs.missed}</b> 个错过</>
          )}
        </span>
        <span>系统定时 <b>{data.strip.systemCrons}</b> 条(只读)</span>
        <span className="spacer" />
        <span style={{ color: data.health.agentsOk ? 'var(--muted)' : 'var(--red)' }}>
          {data.health.cli ?? 'CLI 不可用'}
        </span>
      </div>

      <div className="dash-grid">
        <div className="panel">
          <div className="panel-head"><h2>最近活动</h2><span className="sub">来自 history.jsonl</span></div>
          <ul className="tl">
            {data.timeline.slice(0, 12).map((t, i) => (
              <li key={i}>
                <span className="t">{clock(t.time)}</span>
                <span className="proj" style={{ color: projColor(t.project) }}>{t.project}</span>
                <span className="msg">{t.message}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>7 日活动</h2><span className="sub">按项目 · 每日 prompt 数</span></div>
          <div className="heat">
            {data.heat.map((row) => (
              <div className="heat-row" key={row.project}>
                <span className="lbl">{row.project}</span>
                {row.days.map((v, i) => (
                  <div
                    key={i}
                    className="heat-cell"
                    title={`${dayLabels[i]!.full} · ${v} 条 prompt`}
                    style={v ? { background: `color-mix(in oklab, var(--jade) ${18 + Math.round((v / maxHeat) * 72)}%, var(--surface-2))` } : undefined}
                  />
                ))}
              </div>
            ))}
            <div className="heat-days">
              <span />
              {dayLabels.map((d, i) => <span key={i} title={d.full}>{d.short}</span>)}
            </div>
          </div>
        </div>
      </div>

      <CostPanel usage={data.usage} />
    </>
  );
}

function CostPanel({ usage }: { usage: import('@/api/types').UsageReport }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const max = Math.max(1e-9, ...usage.projects.map((p) => p.totalCostUsd));
  const toggle = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <h2>Token 成本</h2>
        <span className="sub" title={usage.caliber}>
          今日 · 按项目聚合,条长 = 实际成本 · 点击展开会话明细
        </span>
        <span className="spacer" />
        <span className="tok-legend">
          {['fable', 'opus', 'sonnet'].map((m) => (
            <span key={m}><i style={{ background: modelColor(m) }} />{m}</span>
          ))}
        </span>
      </div>
      <div className="tok">
        {usage.projects.length === 0 && <Empty0 />}
        {usage.projects.map((p) => (
          <div className={`tok-proj ${open.has(p.project) ? 'open' : ''}`} key={p.project}>
            <button className="tok-row" onClick={() => toggle(p.project)} aria-expanded={open.has(p.project)}>
              <span className="lbl"><span className="chev">▸</span>{p.project}</span>
              <CostBar usage={p} max={max} />
              <span className="val">{fmtCost(p.totalCostUsd)}</span>
            </button>
            <div className="tok-subs">
              {p.sessions.map((s) => (
                <div className="tok-row sub" key={s.sessionId} title={`session ${s.sessionId}`}>
                  <span className="lbl">
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.title}
                    </span>
                    {s.title !== s.sessionId.slice(0, 8) && (
                      <span className="mono" style={{ color: 'var(--faint)', flex: 'none' }}>
                        ({s.sessionId.slice(0, 8)})
                      </span>
                    )}
                  </span>
                  <CostBar usage={s} max={max} />
                  <span className="val">{fmtCost(s.totalCostUsd)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Empty0() {
  return <div className="empty" style={{ padding: 16 }}><p>今日暂无用量。</p></div>;
}

function CostBar({ usage, max }: { usage: ProjectUsage | SessionUsage; max: number }) {
  const total = usage.totalCostUsd;
  const tip = usage.byModel.map((m) => `${m.model} ${fmtCost(m.costUsd)}`).join(' · ');
  return (
    <div className="track" title={tip}>
      <div className="bar" style={{ width: `${((total / max) * 100).toFixed(2)}%` }}>
        {usage.byModel.map((m) => (
          <i
            key={m.model}
            style={{ width: `${((m.costUsd / total) * 100).toFixed(2)}%`, background: modelColor(m.model) }}
          />
        ))}
      </div>
    </div>
  );
}

export function lastActive(ts: number | null) {
  return timeAgo(ts);
}
