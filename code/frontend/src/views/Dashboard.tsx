import { useEffect, useState } from 'react';
import { api } from '@/api/client';
import type { ProjectUsage, SessionUsage } from '@/api/types';
import { usePoll } from '@/lib/hooks';
import { setDispatchIntent } from '@/lib/dispatch';
import { clock, fmtCost, fmtTokens, modelColor, projColor, timeAgo } from '@/lib/utils';
import { Pill, ProjChip, Tag } from '@/components/shared';

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

const DAY_LABELS = ['六天前', '五天前', '四天前', '三天前', '前天', '昨', '今'];

export function Dashboard({ onGoSession }: { onGoSession: (sessionId: string) => void }) {
  const { data } = usePoll(api.dashboard, 15_000);

  if (!data) return <div className="view-head"><h1>仪表盘</h1><span className="sub">加载中…</span></div>;

  const maxHeat = Math.max(1, ...data.heat.flatMap((h) => h.days));

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
            <Pill state="blocked" label={String(data.needsAttention.length)} />
          </div>
          <div>
            {data.needsAttention.length === 0 && (
              <div className="empty" style={{ padding: '20px' }}><p>没有等待你的会话。</p></div>
            )}
            {data.needsAttention.map((s) => (
              <div className="need-item" key={s.id}>
                <div className="what">
                  <div className="t">
                    {s.name} <ProjChip name={s.project} path={s.cwd} />{' '}
                    <Tag>{s.source === 'web' ? 'web' : s.kind === 'background' ? '后台' : '终端'}</Tag>
                  </div>
                  <div className="n">{s.needs ?? s.detail ?? '等待输入'}</div>
                </div>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    if (s.dispatchId) {
                      setDispatchIntent({ attach: { dispatchId: s.dispatchId, cwd: s.cwd } });
                      location.hash = 'dispatch';
                      return;
                    }
                    if (s.readonly) return onGoSession(s.sessionId);
                    setDispatchIntent({ resume: { sessionId: s.sessionId, name: s.name, cwd: s.cwd } });
                    location.hash = 'dispatch';
                  }}
                >
                  {s.readonly ? '查看' : '去回复'}
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

      <div className="panel dash-strip" title={data.caliber.usage}>
        <span>今日 prompt <b>{data.strip.todayPrompts}</b> 条</span>
        <span>
          今日 token <b>{fmtTokens(data.strip.todayTokensInOut)}</b> · 成本 <b>{fmtCost(data.strip.todayCostUsd)}</b>
        </span>
        <span>活跃项目 <b>{data.strip.activeProjects}</b> 个</span>
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
                    title={`${DAY_LABELS[i]} · ${v} 条 prompt`}
                    style={v ? { background: `color-mix(in oklab, var(--jade) ${18 + Math.round((v / maxHeat) * 72)}%, var(--surface-2))` } : undefined}
                  />
                ))}
              </div>
            ))}
            <div className="heat-days">
              <span />
              {DAY_LABELS.map((d) => <span key={d}>{d.length > 1 && d.includes('天') ? d[0] : d}</span>)}
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
                  <span className="lbl">{s.title}</span>
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
