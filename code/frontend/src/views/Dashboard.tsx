import { useEffect, useState } from 'react';
import { api } from '@/api/client';
import type { ModelUsage, ProjectUsage, SessionUsage, TokenTotals, UsageRange, UsageReport } from '@/api/types';
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

/**
 * 最近活动条数:后端一次给 40 条,这里全量渲染。
 * 左栏高度由 grid 拉伸跟随右侧用量模块(近一周下有十几个项目条,比固定 25 条高得多),
 * 写死条数会在项目多时留下大片空白;给满 40 条 + 内部滚动才是两种口径下都填得满的做法。
 */
const TIMELINE_N = 40;

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
          <button className="td-go" onClick={() => void startTodo(t)}>
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
      setDispatchIntent({ attach: { dispatchId: s.dispatchId, sessionId: s.sessionId, cwd: s.cwd, name: s.name, project: s.project } });
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

      {/* 左「最近活动」拉通整栏,右「Token 用量」把成本条形图与 7 日热力图合成一个模块——
          两者是同一个问题的两个视角(谁在烧 / 什么时候烧),分开放要来回扫视 */}
      <div className="dash-grid">
        <div className="panel">
          <div className="panel-head"><h2>最近活动</h2><span className="sub">来自 history.jsonl</span></div>
          <ul className="tl tl-tall">
            {data.timeline.slice(0, TIMELINE_N).map((t, i) => (
              <li key={i}>
                <span className="t">{clock(t.time)}</span>
                <span className="proj" style={{ color: projColor(t.project) }}>{t.project}</span>
                <span className="msg">{t.message}</span>
              </li>
            ))}
          </ul>
        </div>
        <UsagePanel today={data.usage} heat={data.heat} maxHeat={maxHeat} dayLabels={dayLabels} />
      </div>
    </>
  );
}

/** 计量口径:成本(美元)或 token 量。条长、数值、对比条统一跟随 */
type Unit = 'cost' | 'tok';

/** 取所选口径下的量。token 量用 inOut(不含 cacheRead,与统计条同口径) */
const valueOf = (x: { totalCostUsd: number; totalTokens: TokenTotals }, unit: Unit) =>
  unit === 'cost' ? x.totalCostUsd : x.totalTokens.inOut;
const fmtValue = (v: number, unit: Unit) => (unit === 'cost' ? fmtCost(v) : fmtTokens(v));
/** 悬停一律两个口径都给:切到 token 量时也能看到它值多少钱 */
const bothTip = (cost: number, tokens: TokenTotals) =>
  `${fmtCost(cost)} · ${fmtTokens(tokens.inOut)} tok(另有 ${fmtTokens(tokens.cacheRead)} cache read)`;

function UsagePanel({
  today,
  heat,
  maxHeat,
  dayLabels,
}: {
  today: UsageReport;
  heat: { project: string; days: number[] }[];
  maxHeat: number;
  dayLabels: { short: string; full: string }[];
}) {
  const [range, setRange] = useState<UsageRange>('today');
  const [unit, setUnit] = useState<Unit>('cost');
  const [open, setOpen] = useState<Set<string>>(new Set());
  // 近一周按需拉取:首屏只算今日,避免每次仪表盘轮询都全量扫 7 天的 jsonl
  const [week, setWeek] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (range !== '7d' || week || loading) return;
    setLoading(true);
    api
      .usage('7d')
      .then(setWeek)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [range, week, loading]);

  // 近一周还在路上时先拿今日垫着(条长比例仍成立),避免模块整块闪空
  const usage = range === '7d' ? (week ?? today) : today;
  const pending = range === '7d' && !week;
  const max = Math.max(1e-9, ...usage.projects.map((p) => valueOf(p, unit)));

  const dev = { totalCostUsd: usage.totalCostUsd, totalTokens: usage.totalTokens };
  const noise = { totalCostUsd: usage.noise.costUsd, totalTokens: usage.noise.tokens };
  const devV = valueOf(dev, unit);
  const noiseV = valueOf(noise, unit);
  const totalV = devV + noiseV;
  const devPct = totalV > 0 ? Math.round((devV / totalV) * 100) : 0;

  const toggle = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const rangeLabel = range === 'today' ? '今天' : '近一周';

  return (
    <div className="panel">
      <div className="panel-head usage-head">
        <h2>Token 用量</h2>
        {/* 近一周首次要全量扫 7 天 jsonl(实测 ~5s),必须给出文字反馈——只压暗会被当成卡死 */}
        <span className="sub" title={usage.caliber}>
          {pending ? (
            <span className="usage-loading">近一周 · 统计中…</span>
          ) : (
            <>{rangeLabel} · 按项目聚合 · 条长 = {unit === 'cost' ? '实际成本' : 'token 量'}</>
          )}
        </span>
        <span className="spacer" />
        <span className="seg" role="group" aria-label="时间范围">
          <Seg on={range === 'today'} onClick={() => setRange('today')}>今天</Seg>
          <Seg on={range === '7d'} onClick={() => setRange('7d')}>近一周</Seg>
        </span>
        <span className="seg" role="group" aria-label="计量单位">
          <Seg on={unit === 'cost'} onClick={() => setUnit('cost')}>成本 $</Seg>
          <Seg on={unit === 'tok'} onClick={() => setUnit('tok')}>Token</Seg>
        </span>
      </div>

      {/* 开发 vs multica 对比:multica 只在这条总览里出现,进项目条形图会碾压真实开发项目的分辨率 */}
      <div className={`cmp ${pending ? 'pending' : ''}`}>
        <div className="cmp-head">
          开发 <b>{fmtValue(devV, unit)}</b> vs multica <b>{fmtValue(noiseV, unit)}</b>
          <span className="pct">开发占 {devPct}%</span>
        </div>
        <div
          className="cmp-track"
          title={`${rangeLabel} · 开发 ${bothTip(dev.totalCostUsd, dev.totalTokens)} · multica ${bothTip(noise.totalCostUsd, noise.totalTokens)}`}
        >
          <div className="dev" style={{ width: `${totalV > 0 ? (devV / totalV) * 100 : 0}%` }} />
          <div className="noise" style={{ width: `${totalV > 0 ? (noiseV / totalV) * 100 : 0}%` }} />
        </div>
        <div className="cmp-legend">
          <span><i className="i-dev" />开发项目</span>
          <span><i className="i-noise" />multica workspaces</span>
        </div>
      </div>

      <div className={`tok ${pending ? 'pending' : ''}`}>
        {usage.projects.length === 0 && (
          <div className="empty" style={{ padding: 16 }}><p>{rangeLabel}暂无用量。</p></div>
        )}
        {/* key 与展开态都用 dir:展示名末段可能撞名(近一周窗口里 skills/baize 各有两个项目) */}
        {usage.projects.map((p) => (
          <div className={`tok-proj ${open.has(p.dir) ? 'open' : ''}`} key={p.dir}>
            <button className="tok-row" onClick={() => toggle(p.dir)} aria-expanded={open.has(p.dir)}>
              <span className="lbl"><span className="chev">▸</span>{p.project}</span>
              <UsageBar usage={p} max={max} unit={unit} />
              <span className="val">{fmtValue(valueOf(p, unit), unit)}</span>
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
                  <UsageBar usage={s} max={max} unit={unit} />
                  <span className="val">{fmtValue(valueOf(s, unit), unit)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* 7 日活动:与上方条形图同属「用量」视角,故并入同一模块;它天然是 7 日口径,不随时间切换变化 */}
      <div className="usage-divide">
        <div className="cap"><h3>7 日活动</h3><span>按项目 · 每日 prompt 数</span></div>
        <div className="heat">
          {heat.map((row) => (
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

      <div className="usage-divide usage-foot">
        <span className="tok-legend">
          {['fable', 'opus', 'sonnet'].map((m) => (
            <span key={m}><i style={{ background: modelColor(m) }} />{m}</span>
          ))}
        </span>
      </div>
    </div>
  );
}

function Seg({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={on ? 'active' : ''} onClick={onClick} aria-pressed={on}>
      {children}
    </button>
  );
}

function UsageBar({ usage, max, unit }: { usage: ProjectUsage | SessionUsage; max: number; unit: Unit }) {
  const total = valueOf(usage, unit);
  // 分段按所选口径切:成本口径下 output 段最粗,token 口径下 cacheWrite 段最粗,两者本就不同
  const seg = (m: ModelUsage) =>
    unit === 'cost' ? m.costUsd : m.inputTokens + m.outputTokens + m.cacheCreationTokens;
  const tip = usage.byModel.map((m) => `${m.model} ${fmtValue(seg(m), unit)}`).join(' · ');
  return (
    <div className="track" title={`${bothTip(usage.totalCostUsd, usage.totalTokens)}${tip ? ` · ${tip}` : ''}`}>
      <div className="bar" style={{ width: `${((total / max) * 100).toFixed(2)}%` }}>
        {usage.byModel.map((m) => (
          <i
            key={m.model}
            style={{ width: `${total > 0 ? ((seg(m) / total) * 100).toFixed(2) : 0}%`, background: modelColor(m.model) }}
          />
        ))}
      </div>
    </div>
  );
}

export function lastActive(ts: number | null) {
  return timeAgo(ts);
}
