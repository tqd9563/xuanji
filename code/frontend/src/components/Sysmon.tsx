/**
 * 系统监控(DESIGN.md「系统监控」):状态栏内存/CPU 指示 + 两 tab 弹窗 + 会话卡片数字。
 * 1:1 还原获批原型 wiki/design/prototype-memory-monitor.html。
 *
 * 数据全部来自后端采样器(/ws/sysmon);判色、防抖、建议规则都在后端算好,这里只负责呈现。
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MonGroup, MonLevel, MonTip, SysmonSnapshot } from '@/api/types';
import { closeSession } from '@/lib/close-session';
import { useAccountPrefs, useLocalPrefs } from '@/lib/prefs';
import {
  closeMonitor,
  cpuChipLevel,
  cpuHigh,
  fmtCpu,
  fmtG,
  fmtMem,
  LEVEL_PILL,
  memChipLevel,
  openMonitor,
  rankValue,
  sessionLabel,
  sortGroups,
  sortProcs,
  setMonitorTab,
  showMetric,
  toggleMonitor,
  useMonitorUi,
  useSysmon,
  type MonTab,
} from '@/lib/sysmon';

function useMonitorEnabled() {
  const { prefs } = useAccountPrefs();
  return { mem: prefs.monitor.mem, cpu: prefs.monitor.cpu, prefs: prefs.monitor };
}

/* ============ 状态栏:两枚指示器 + 共用一个弹窗(锚在同一个容器上,右对齐) ============ */

export function SysmonWidgets() {
  const en = useMonitorEnabled();
  const snap = useSysmon(en.mem || en.cpu);
  const ui = useMonitorUi();
  const anchor = useRef<HTMLSpanElement>(null);

  // 点弹窗外关闭;Esc 关闭并把焦点还给对应指示器
  useEffect(() => {
    if (!ui.open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (anchor.current?.contains(t)) return;
      // 卡片数字负责打开弹窗,它自己的 click 不算「点外面」;确认框压在弹窗上时也不关
      if (t.closest('[data-mon-open], .confirm-mask')) return;
      closeMonitor();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.confirm-mask')) return;
      closeMonitor();
      anchor.current?.querySelector<HTMLButtonElement>(`[data-mon-ind="${ui.tab}"]`)?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ui.open, ui.tab]);

  if (!en.mem && !en.cpu) return null;
  const tab: MonTab = en[ui.tab] ? ui.tab : en.mem ? 'mem' : 'cpu';

  return (
    <span className="ram-anchor" ref={anchor}>
      {en.mem && <MemIndicator snap={snap} active={ui.open && tab === 'mem'} />}
      {en.mem && en.cpu && <span className="sb-sep" aria-hidden="true" />}
      {en.cpu && <CpuIndicator snap={snap} active={ui.open && tab === 'cpu'} />}
      {ui.open && <MonPopover snap={snap} tab={tab} memOn={en.mem} cpuOn={en.cpu} focus={ui.focus} />}
    </span>
  );
}

const lvCls = (lv: MonLevel) => (lv === 'warn' ? 'sb-item warn' : lv === 'crit' ? 'sb-item bad' : 'sb-item');

function MemIndicator({ snap, active }: { snap: SysmonSnapshot | null; active: boolean }) {
  const m = snap?.mem;
  const failed = !!snap && !snap.ok;
  if (!m) {
    return (
      <button className="sb-item" data-ram={failed ? 'stale' : undefined} data-mon-ind="mem" aria-haspopup="dialog" aria-expanded={active}
        title={failed ? '内存采样失败 · 点击看详情' : '正在采样内存…'} onClick={() => toggleMonitor('mem')}>
        <span className="dot" />
        内存 <span className="n">—</span>
        {failed && ' · 采样失败'}
      </button>
    );
  }
  return (
    <button className={lvCls(m.level)} data-mon-ind="mem" aria-haspopup="dialog" aria-expanded={active}
      title={`内存${LEVEL_PILL[m.level][1]}(内核压力等级 ${m.pressure})· 占用 ${m.usedPct}% = (应用 + 压缩器)÷ 物理内存 ${Math.round(m.total / 1024 ** 3)}G · 点击看是谁在占`}
      onClick={() => toggleMonitor('mem')}>
      <span className="dot" />
      内存{' '}
      <span className="n" data-lv={m.level}>
        {m.usedPct}%
      </span>
    </button>
  );
}

function CpuIndicator({ snap, active }: { snap: SysmonSnapshot | null; active: boolean }) {
  const c = snap?.cpu;
  const failed = !!snap && !snap.ok;
  if (!c) {
    return (
      <button className="sb-item" data-ram={failed ? 'stale' : undefined} data-mon-ind="cpu" aria-haspopup="dialog" aria-expanded={active}
        title={failed ? 'CPU 采样失败 · 点击看详情' : '正在采样 CPU…'} onClick={() => toggleMonitor('cpu')}>
        <span className="dot" />
        CPU <span className="n">—</span>
      </button>
    );
  }
  return (
    <button className={lvCls(c.level)} data-mon-ind="cpu" aria-haspopup="dialog" aria-expanded={active}
      title={`CPU ${LEVEL_PILL[c.level][1]} · 整体占用 ${c.used}%(用户 ${c.user}% + 系统 ${c.sys}%)· 负载 ${c.load[0]} / ${c.ncpu} 核 · 点击看是谁在占`}
      onClick={() => toggleMonitor('cpu')}>
      <span className="dot" />
      CPU{' '}
      <span className="n" data-lv={c.level}>
        {c.used}%
      </span>
    </button>
  );
}

/* ============ 弹窗 ============ */

function Tabs({ tab, memOn, cpuOn }: { tab: MonTab; memOn: boolean; cpuOn: boolean }) {
  const opts = ([['mem', '内存'], ['cpu', 'CPU']] as const).filter(([k]) => (k === 'mem' ? memOn : cpuOn));
  return (
    <span className="seg cpu-tabs" role="tablist">
      {opts.map(([k, l]) => (
        <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setMonitorTab(k)}>
          {l}
        </button>
      ))}
    </span>
  );
}

/** 「N 秒前采样 · 每 Ns」:每秒走一格 */
function SampleAge({ snap }: { snap: SysmonSnapshot }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ago = Math.max(0, Math.floor((now - snap.at) / 1000));
  return (
    <span className="ram-ts" title={`变色需连续 ${snap.debounce} 次超阈值 ≈ ${snap.debounce * snap.interval} 秒`}>
      {ago} 秒前采样 · 每 {snap.interval}s
    </span>
  );
}

function hhmm(t?: number) {
  if (!t) return '—';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function MonPopover({
  snap,
  tab,
  memOn,
  cpuOn,
  focus,
}: {
  snap: SysmonSnapshot | null;
  tab: MonTab;
  memOn: boolean;
  cpuOn: boolean;
  focus: { sessionId: string; nonce: number } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="ram-pop" role="dialog" aria-label="内存与 CPU" ref={ref}>
      {!snap ? (
        <>
          <div className="ram-head">
            <Tabs tab={tab} memOn={memOn} cpuOn={cpuOn} />
          </div>
          <div className="ram-foot">正在采样…</div>
        </>
      ) : !snap.ok ? (
        <>
          <div className="ram-head">
            <Tabs tab={tab} memOn={memOn} cpuOn={cpuOn} />
            <span className="pill pill-idle">
              <span className="dot" />
              采样失败
            </span>
            <span className="ram-ts">上次成功 {hhmm(snap.lastOkAt)}</span>
          </div>
          <div className="ram-err">
            最近一次采样失败:<code>{snap.error}</code>
            <br />
            不展示过期的排行,避免按旧数据做决定。
          </div>
          <div className="ram-foot">后端每 {snap.interval} 秒自动重试,恢复后状态栏自动刷新。</div>
        </>
      ) : tab === 'mem' && snap.mem ? (
        <MemTab snap={snap} tabs={<Tabs tab={tab} memOn={memOn} cpuOn={cpuOn} />} focus={focus} pop={ref} />
      ) : snap.cpu ? (
        <CpuTab snap={snap} tabs={<Tabs tab={tab} memOn={memOn} cpuOn={cpuOn} />} focus={focus} pop={ref} />
      ) : (
        <div className="ram-foot">正在按新设置采样…</div>
      )}
    </div>
  );
}

function TipBox({ tips, empty }: { tips: MonTip[]; empty: string }) {
  if (!tips.length) return <div className="ram-foot" style={{ color: 'var(--muted)' }}>{empty}</div>;
  return (
    <div className="ram-tip">
      {tips.map((t) => (
        <div className="ram-tip-line" key={t.rule}>
          {t.parts.map((p, i) =>
            typeof p === 'string' ? <Fragment key={i}>{p}</Fragment> : 'code' in p ? <code key={i}>{p.code}</code> : <b key={i}>{p.b}</b>,
          )}
          {t.jump === 'mem' && (
            <button className="cpu-jump" onClick={() => setMonitorTab('mem')}>
              看内存 →
            </button>
          )}
          <span className="ram-rule">规则 · {t.rule}</span>
        </div>
      ))}
    </div>
  );
}

type Metric = 'mem' | 'cpu';
const PROC_LIMIT = 6;

/**
 * 排行:应用一行可展开到进程;派发会话的进程行下挂「关闭会话以释放」,终端会话只读。
 * 从卡片数字进来(focus)时:展开该会话所在应用、高亮其进程行并滚到可见。
 */
function RankList({
  snap,
  groups,
  metric,
  focus,
  pop,
}: {
  snap: SysmonSnapshot;
  groups: MonGroup[];
  metric: Metric;
  focus: { sessionId: string; nonce: number } | null;
  pop: React.RefObject<HTMLDivElement>;
}) {
  const full = (snap.cpu?.ncpu ?? 1) * 100;
  const focusKey = focus ? groups.find((g) => g.procs.some((p) => p.sessionId === focus.sessionId))?.key : undefined;
  const [open, setOpen] = useState<Set<string>>(() => new Set(focusKey ? [focusKey] : groups[0] ? [groups[0].key] : []));
  const [hl, setHl] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!focus) return;
    if (focusKey) setOpen((o) => new Set(o).add(focusKey));
    setHl(focus.sessionId);
  }, [focus?.nonce]);
  useEffect(() => {
    if (!hl) return;
    // 只滚弹窗自身:scrollIntoView 会连带把整页也滚走(状态栏跟着上移)
    const box = pop.current;
    const row = box?.querySelector<HTMLElement>(`.ram-procs .ram-row[data-sid="${hl}"]`);
    if (!box || !row) return;
    const top = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    if (top < box.scrollTop || top + row.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = Math.max(0, top - box.clientHeight / 3);
    }
  }, [hl, pop]);

  const vals = (x: { mem: number; cmprs: number; cpu: number }) =>
    metric === 'mem' ? [fmtMem(x.mem), fmtMem(x.cmprs)] : [fmtCpu(x.cpu), `${((x.cpu / full) * 100).toFixed(1)}%`];

  // 一个应用可能有几十个进程(Chrome 50+):组内按当前指标排序,只展开前 PROC_LIMIT 个,会话进程恒在
  const metricOf = (p: { mem: number; cpu: number }) => rankValue(metric, p);
  const shownProcs = (g: MonGroup) => {
    const sorted = sortProcs(g.procs, metric);
    return sorted.filter((p, i) => i < PROC_LIMIT || !!p.sessionId);
  };
  const restOf = (g: MonGroup) => {
    const shown = new Set(shownProcs(g).map((p) => p.pid));
    const v = g.procs.filter((p) => !shown.has(p.pid)).reduce((s, p) => s + metricOf(p), 0);
    return metric === 'mem' ? fmtMem(v) : fmtCpu(v);
  };

  const listedCount = groups.reduce((s, g) => s + g.procs.length, 0);
  const listedVal = groups.reduce((s, g) => s + rankValue(metric, g), 0);
  const restVal = Math.max(0, (metric === 'mem' ? snap.totals.mem : snap.totals.cpu) - listedVal);

  return (
    <div className="ram-list">
      <div className="ram-row ram-colhead">
        <span />
        <span>{metric === 'mem' ? '应用' : '应用(按进程树聚合)'}</span>
        {metric === 'mem' ? (
          <>
            <span className="v" title="进程占用内存总量(top 的 MEM 列,含压缩部分);排行按此降序">总占用</span>
            <span className="v" title="被压缩 + 换出到 swap 的内存(top 的 CMPRS 列)">压缩+换出</span>
          </>
        ) : (
          <>
            <span className="v" title={`top 的 %CPU:单核跑满 = 100%,${snap.cpu?.ncpu ?? 1} 核满载 = ${full}%`}>%CPU</span>
            <span className="v" title={`占整机算力:%CPU ÷ ${full}%`}>占整机</span>
          </>
        )}
      </div>
      {groups.map((g) => {
        const isOpen = open.has(g.key);
        const [a, b] = vals(g);
        return (
          <div className={isOpen ? 'ram-app open' : 'ram-app'} key={g.key}>
            <button
              className="ram-row"
              aria-expanded={isOpen}
              onClick={() =>
                setOpen((o) => {
                  const n = new Set(o);
                  if (n.has(g.key)) n.delete(g.key);
                  else n.add(g.key);
                  return n;
                })
              }
            >
              <span className="chev">▶</span>
              <span className="nm">
                <span>{g.name}</span>
                {g.procs.length > 1 && <span className="pid">{g.procs.length} 进程</span>}
                {g.kind === 'dispatch' && <span className="tag t-susp ram-own">璇玑</span>}
                {g.kind === 'terminal' && <span className="tag ram-own">终端</span>}
              </span>
              <span className="v">{a}</span>
              <span className="v sub">{b}</span>
            </button>
            <div className="ram-procs">
              {shownProcs(g).map((p) => {
                const [pa, pb] = vals(p);
                const label = p.sessionId && /^claude$/.test(p.cmd) ? `claude · ${sessionLabel(snap, p.sessionId)}` : p.cmd;
                return (
                  <Fragment key={p.pid}>
                    <div className={p.sessionId && p.sessionId === hl ? 'ram-row ram-hl' : 'ram-row'} data-sid={p.sessionId}>
                      <span />
                      <span className="nm">
                        <span title={label}>{label}</span>
                        <span className="pid">{p.pid}</span>
                      </span>
                      <span className="v">{pa}</span>
                      <span className="v sub">{pb}</span>
                    </div>
                    {g.kind === 'dispatch' && p.sessionId && (
                      <div className="ram-row ram-close-row">
                        <span />
                        <span className="nm">
                          <button
                            className="btn btn-sm ram-close"
                            title="结束该派发会话,进程随之退出"
                            onClick={() =>
                              void closeSession({ sessionId: p.sessionId!, name: sessionLabel(snap, p.sessionId!), dispatch: true })
                            }
                          >
                            关闭会话以释放 ≈{metric === 'mem' ? fmtMem(p.mem) : fmtCpu(p.cpu)}
                          </button>
                        </span>
                        <span />
                        <span />
                      </div>
                    )}
                  </Fragment>
                );
              })}
              {g.procs.length > shownProcs(g).length && (
                <div className="ram-row">
                  <span />
                  <span className="nm ram-own-note">其余 {g.procs.length - shownProcs(g).length} 个进程</span>
                  <span className="v">{restOf(g)}</span>
                  <span />
                </div>
              )}
              {g.kind === 'terminal' && (
                <div className="ram-row">
                  <span />
                  <span className="nm ram-own-note">只读 · 终端里开的会话请在终端结束</span>
                  <span />
                  <span />
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div className="ram-rest">
        <span>其余 {Math.max(0, snap.totals.procs - listedCount)} 个进程</span>
        <span className="v">{metric === 'mem' ? fmtMem(restVal) : fmtCpu(restVal)}</span>
      </div>
    </div>
  );
}

const Bar = ({ parts, total }: { parts: [string, number][]; total: number }) => (
  <div className="cmp-track">
    {parts.map(([k, v]) => (
      <div key={k} className="ram-seg" data-k={k} style={{ width: `${total > 0 ? ((v / total) * 100).toFixed(2) : 0}%` }} />
    ))}
  </div>
);

interface TabProps {
  snap: SysmonSnapshot;
  tabs: React.ReactNode;
  focus: { sessionId: string; nonce: number } | null;
  pop: React.RefObject<HTMLDivElement>;
}

function MemTab({ snap, tabs, focus, pop }: TabProps) {
  const m = snap.mem!;
  const [cls, label] = LEVEL_PILL[m.level];
  const sum = m.app + m.compressor + m.cache + m.free;
  const G = (b: number) => (b / 1024 ** 3 < 0.1 ? (b / 1024 ** 3).toFixed(2) : fmtG(b));
  const groups = sortGroups(snap.groups, 'mem');
  return (
    <>
      <div className="ram-head">
        {tabs}
        <span className={`pill ${cls}`}>
          <span className="dot" />
          {label}
        </span>
        <SampleAge snap={snap} />
      </div>
      <div className="ram-bars">
        <div>
          <div className="ram-bar-lab">
            <span>物理内存 {Math.round(m.total / 1024 ** 3)}G</span>
            <span title="(active + wired + 压缩器)÷ 物理内存,与状态栏同一个数">
              占用 <span className="n">{m.usedPct}%</span>
            </span>
          </div>
          <Bar parts={[['used', m.app], ['cmp', m.compressor], ['cache', m.cache]]} total={sum} />
          <div className="cmp-legend">
            <span title="active + wired"><i style={{ background: 'var(--chart-1)' }} />应用占用 {fmtG(m.app)}G</span>
            <span><i style={{ background: 'var(--chart-2)' }} />压缩器 {fmtG(m.compressor)}G</span>
            <span title="inactive + purgeable + speculative,系统需要时可直接收回"><i style={{ background: 'var(--chart-3)' }} />可回收缓存 {fmtG(m.cache)}G</span>
            <span title="free"><i className="i-rail" />真空闲 {G(m.free)}G</span>
          </div>
        </div>
        {/* swap 总量由系统按需扩缩(实测 17.4G → 16.0G),占比没有意义:只给已用绝对值,不画比例条 */}
        <div className="ram-bar-lab" title="swap 总量由 macOS 按需扩缩,只看已用量">
          <span>Swap(磁盘)</span>
          <span className="ram-swapn" data-lv={m.level}>
            已用 <span className="n">{fmtG(m.swapUsed)}G</span>
          </span>
        </div>
      </div>
      <RankList snap={snap} groups={groups} metric="mem" focus={focus} pop={pop} />
      <TipBox tips={m.tips} empty="压力正常、swap 用量低,无需处理。" />
    </>
  );
}

function CpuTab({ snap, tabs, focus, pop }: TabProps) {
  const c = snap.cpu!;
  const [cls, label] = LEVEL_PILL[c.level];
  const groups = sortGroups(snap.groups, 'cpu');
  return (
    <>
      <div className="ram-head">
        {tabs}
        <span className={`pill ${cls}`}>
          <span className="dot" />
          {label}
        </span>
        <SampleAge snap={snap} />
      </div>
      <div className="ram-bars">
        <div>
          <div className="ram-bar-lab">
            <span>整体占用</span>
            <span className="ram-swapn" data-lv={c.level}>
              <span className="n">{c.used}%</span>
            </span>
          </div>
          <Bar parts={[['used', c.user], ['sys', c.sys]]} total={100} />
          <div className="cmp-legend">
            <span><i style={{ background: 'var(--chart-1)' }} />用户 {c.user}%</span>
            <span><i style={{ background: 'var(--chart-2)' }} />系统 {c.sys}%</span>
            <span><i className="i-rail" />空闲 {c.idle}%</span>
          </div>
          <div className="cpu-load">
            <span title="1 / 5 / 15 分钟平均负载;持续高于核心数说明任务在排队">
              负载 <span className="n">{c.load.map((x) => x.toFixed(2)).join(' / ')}</span>
            </span>
            <span>
              {c.ncpu} 核{' '}
              {c.pcores !== null && c.ecores !== null && (
                <span className="n">
                  ({c.pcores} 性能 + {c.ecores} 能效)
                </span>
              )}
            </span>
          </div>
        </div>
      </div>
      <RankList snap={snap} groups={groups} metric="cpu" focus={focus} pop={pop} />
      <TipBox tips={c.tips} empty="压力正常,无需处理。" />
    </>
  );
}

/* ============ 会话卡片数字 ============ */

/** 卡片 .top 行尾的内存/CPU 数字;点击打开弹窗对应 tab 并定位到该会话 */
export function SessionMetrics({ sessionId }: { sessionId: string }) {
  const en = useMonitorEnabled();
  const local = useLocalPrefs();
  const snap = useSysmon(en.mem || en.cpu);
  const u = snap?.sessions[sessionId];
  if (!u) return null;
  const memLv = memChipLevel(u.mem);
  const showMem = en.mem && showMetric(local.cardMem, memLv !== 'ok');
  const showCpu = en.cpu && showMetric(local.cardCpu, cpuHigh(u.cpu, snap?.cpu?.ncpu ?? 1, en.prefs.cpuWarn));
  const click = (tab: MonTab) => (e: React.MouseEvent) => {
    e.stopPropagation();
    openMonitor(tab, sessionId);
  };
  return (
    <>
      {showCpu && (
        <button
          className={showMem ? 'ram-chip cpu-chip' : 'ram-chip'}
          data-lv={cpuChipLevel(u.cpu)}
          data-mon-open=""
          title={`进程树 CPU ${fmtCpu(u.cpu)}(单核 100%,满载 ${(snap?.cpu?.ncpu ?? 1) * 100}%)· 点击在 CPU 排行里定位`}
          aria-label={`CPU ${fmtCpu(u.cpu)},在 CPU 排行里定位`}
          onClick={click('cpu')}
        >
          {Math.round(u.cpu)}%
        </button>
      )}
      {showMem && (
        <button
          className="ram-chip"
          data-lv={memLv}
          data-mon-open=""
          title={`进程树总占用 ${fmtMem(u.mem)}(top MEM,含压缩+换出 ${fmtMem(u.cmprs)})· 点击在内存排行里定位`}
          aria-label={`内存 ${fmtMem(u.mem)},在内存排行里定位`}
          onClick={click('mem')}
        >
          {fmtMem(u.mem)}
        </button>
      )}
    </>
  );
}

/** 卡片左侧等级立柱:内存 ≥1G 琥珀、≥3G 红(与卡片数字同一判定;内存数字不显示时不挂) */
export function useCardRamLv(sessionId: string): { 'data-ram-lv'?: string } {
  const en = useMonitorEnabled();
  const local = useLocalPrefs();
  const snap = useSysmon(en.mem || en.cpu);
  const u = snap?.sessions[sessionId];
  if (!u || !en.mem || local.cardMem === 'off') return {};
  const lv = memChipLevel(u.mem);
  return lv === 'ok' ? {} : { 'data-ram-lv': lv };
}
