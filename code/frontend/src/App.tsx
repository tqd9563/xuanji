import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribeChanges } from '@/api/client';
import { useHashRoute, usePoll, VIEW_IDS, isTypingTarget, type ViewId } from '@/lib/hooks';
import { setPalette, cn } from '@/lib/utils';
import { ConfirmHost, ToastHost, toast } from '@/components/shared';
import { Settings } from '@/components/Settings';
import { useWallpaper, wallSrcUrl, wallStateLabel } from '@/lib/wallpaper';
import { applyLocalToDom, loadAccount, useLocalPrefs } from '@/lib/prefs';
import { formatCombo, matchKey } from '@/lib/keymap';
import { TabBar, mobileTabOf, type MobileTab } from '@/components/TabBar';
import { StatusBar } from '@/components/StatusBar';
import { MoreMenu } from '@/components/MoreMenu';
import { Dashboard } from '@/views/Dashboard';
import { Projects } from '@/views/Projects';
import { Sessions, type SessionsHandle } from '@/views/Sessions';
import { Dispatch } from '@/views/Dispatch';
import { Skills } from '@/views/Skills';
import { Memories } from '@/views/Memories';
import { Crons } from '@/views/Crons';
import { Review } from '@/views/Review';
import { Worklog } from '@/views/Worklog';
import { Todos, startTodo, notifyTodosChanged } from '@/views/Todos';
import { TodoPalette } from '@/components/TodoPalette';

const NAVS: { id: ViewId; label: string; icon: string }[] = [
  { id: 'dashboard', label: '仪表盘', icon: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z' },
  { id: 'projects', label: '项目', icon: 'M3 7l3-4h5l2 3h8v13H3z' },
  { id: 'sessions', label: '会话', icon: 'M4 5h16v11H8l-4 4z' },
  { id: 'dispatch', label: '派发', icon: 'M3 12l18-8-6 18-3-7z' },
  { id: 'skills', label: '技能', icon: 'M12 2l2.6 6.6L21 11l-6.4 2.4L12 20l-2.6-6.6L3 11l6.4-2.4z' },
  { id: 'memory', label: '经验', icon: 'M5 3h11l3 3v15H5zM9 8h7M9 12h7M9 16h4' },
  { id: 'cron', label: '定时', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v5l3 2' },
  { id: 'review', label: '回顾', icon: 'M4 5h16v16H4zM4 9.5h16M8.5 3v4M15.5 3v4M8 14l2.5 2.5L16 12' },
  { id: 'worklog', label: '总结', icon: 'M4 4h16v16H4zM8 9h8M8 13h8M8 17h5' },
  { id: 'todo', label: '待办', icon: 'M4 6h16M4 12h16M4 18h10M2.5 6l1 1 2-2' },
];

/** 移动端(≤430px)导航是 5-tab + 更多 二级菜单;这四个视图归入更多,详见 TabBar.mobileTabOf */
const MOBILE_SECONDARY: ViewId[] = ['projects', 'skills', 'memory', 'review', 'worklog', 'todo'];
const MOBILE_TITLE: Record<ViewId, string> = {
  dashboard: '首页', sessions: '会话', dispatch: '派发', cron: '定时任务',
  projects: '项目', skills: '技能', memory: '经验', review: '回顾', worklog: '总结', todo: '待办',
};

export default function App() {
  const [view, nav] = useHashRoute();
  const [health, setHealth] = useState<{ cli: string | null } | null>(null);
  const [, setPaletteReady] = useState(false);
  const sessionsHandle = useRef<SessionsHandle | null>(null);
  const [wall, patchWall] = useWallpaper();
  const { data: projectsData } = usePoll(api.projects, 60_000);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const localPrefs = useLocalPrefs();
  const wallUrl = wallSrcUrl(wall);

  // 移动端「更多」二级菜单开关:项目/技能/经验/回顾在窄屏归入此菜单(见 MOBILE_SECONDARY)。
  // 任何真实导航(hash 变化,无论来自 tab 点击、更多菜单选择、深链或浏览器前进后退)都应该
  // 让位给目标视图本身,菜单开合只由「更多」tab 或次要视图的返回按钮显式触发(两者都不改 hash)。
  const [mobileMore, setMobileMore] = useState(false);
  // ⌘J 速记浮层:挂在 App 层,任意视图之上都能呼出(见下方键盘监听)
  const [todoPalette, setTodoPalette] = useState(false);
  useEffect(() => setMobileMore(false), [view]);
  // 会话 tab 徽章:与 Sessions.tsx 共享同一 fetcher 引用,命中 pollCache,不重复拉取
  const { data: sessData } = usePoll(api.sessions, 5_000);
  const blockedCount = sessData?.columns.blocked.length ?? 0;
  const reviewCount = sessData?.columns.review.length ?? 0;

  // 项目分类色调色板(后端 SQLite 首次出现顺序):加载后重渲染;旧后端无此端点时静默用哈希兜底
  useEffect(() => {
    api
      .palette()
      .then((p) => {
        setPalette(p.idx);
        setPaletteReady(true);
      })
      .catch(() => {});
  }, []);

  // 移动端派发页用 --vh 而非 100dvh/100vh 计算高度:部分 Android 内嵌 WebView(超级 App 内置
  // 浏览器等,非 Safari/Chrome 独立浏览器)对 dvh 支持缺失或失真,会导致派发页内容撑爆容器、
  // 发送按钮被推到底部导航条后面看不清(2026-07-23 真机反馈)。window.innerHeight 是比 CSS
  // 视口单位更古老、跨内核一致性更好的度量,JS 测量后写成 CSS 变量是这类问题的标准解法。
  useEffect(() => {
    const setVh = () => document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
    setVh();
    window.addEventListener('resize', setVh);
    window.addEventListener('orientationchange', setVh);
    return () => {
      window.removeEventListener('resize', setVh);
      window.removeEventListener('orientationchange', setVh);
    };
  }, []);

  useEffect(() => {
    api
      .dashboard()
      .then((d) => setHealth({ cli: d.health.cli }))
      .catch(() => setHealth({ cli: null }));
  }, []);

  // ws 变更订阅(M1 仅日志级消费:轮询已覆盖刷新;保留通道供 M2 扩展)
  useEffect(() => subscribeChanges(() => {}), []);

  // 本机偏好(字号/动效/吸顶轮次头)落到 <html> 上由 CSS 接管;账户偏好拉一次给派发页用
  useEffect(() => {
    void loadAccount();
  }, []);
  useEffect(() => {
    applyLocalToDom(localPrefs);
  }, [localPrefs]);

  // 视图切走后把藏在 display:none 里的焦点收走:WebKit(Pake 壳)不像 Chrome 会自动 blur
  // 被隐藏的元素,残留焦点会让后续按键打进看不见的输入框(isTypingTarget 的可见性校验
  // 挡住了快捷键被吞,这里进一步防止字符键悄悄写进隐藏的派发草稿)。
  useEffect(() => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el.getClientRects().length === 0 && el !== document.body) el.blur();
  }, [view]);

  // 视图切换双通道:⌘+数字任何时候可用(含输入框聚焦,Pake 壳主用);
  // 裸数字在非输入状态保留(普通浏览器里 ⌘+数字被标签页快捷键占用时的兜底)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘J 速记待办:任意视图可呼出(Chrome/Safari 上 ⌘J 空闲;Firefox 的「下载」会截走,
      // 那种情况从侧栏「待办」页顶部的速记行记录,或用 Raycast 全局热键)。
      // 注意这是页内快捷键:璇玑窗口没有焦点时不触发,真·全局捕获走 Raycast → POST /api/todos。
      // 设置面板自己处理面板内按键(含改键录入),开着时全局键位一律让位
      if (settingsOpen) return;
      const km = localPrefs.keymap;
      if (matchKey(e, km['global.settings'])) {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (matchKey(e, km['global.todoCapture'])) {
        e.preventDefault();
        setTodoPalette(true);
        return;
      }
      // ⌘N 新建会话:跳派发页并放下当前会话(浏览器里 ⌘N 被"新建窗口"占用,Pake 壳可用)
      if (matchKey(e, km['global.newSession'])) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('xuanji:new-session'));
        nav('dispatch');
        return;
      }
      // ⌥⌘←/→ 在侧栏顺序里前后挪一格(首尾相接)。长按连跳靠浏览器自身的按键重复,
      // 不拦 e.repeat 即可;输入框里也放行,这个组合键不产生字符。
      // ⌃⌥←/→ 是浏览器里的等价别名:Chrome/Safari 把 ⌥⌘←/→ 占作「切换标签页」,
      // 那是浏览器层的加速键,preventDefault 拦不住(桌面壳无标签页,主组合键照常可用)。
      // ⌃⌥←/→ 是浏览器里的等价别名(见上),不走 keymap:它是同一动作的平台兜底,
      // 不是第二个可改键位,列进设置只会让人以为有两个可独立配置的组合。
      const altAlias =
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        e.altKey &&
        !e.shiftKey &&
        e.ctrlKey &&
        !e.metaKey;
      const prev = matchKey(e, km['global.prevView']) || (altAlias && e.key === 'ArrowLeft');
      const next = matchKey(e, km['global.nextView']) || (altAlias && e.key === 'ArrowRight');
      if (prev || next) {
        e.preventDefault();
        const cur = VIEW_IDS.indexOf(view);
        nav(VIEW_IDS[(cur + (next ? 1 : -1) + VIEW_IDS.length) % VIEW_IDS.length]!);
        return;
      }
      const i = parseInt(e.key, 10);
      if (!(i >= 1 && i <= VIEW_IDS.length)) return;
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        nav(VIEW_IDS[i - 1]!);
        return;
      }
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      nav(VIEW_IDS[i - 1]!);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [nav, view, settingsOpen, localPrefs.keymap]);

  const goSession = useCallback(
    (sessionId: string) => {
      nav('sessions');
      // 等 Sessions 挂载注册 handle 后打开回放
      setTimeout(() => sessionsHandle.current?.openReplay(sessionId), 50);
    },
    [nav],
  );

  // 移动端顶栏文案与「更多」菜单开合(见上方 mobileMore 注释);桌面完全不读这三个值。
  const mobileTitle = mobileMore ? '更多' : MOBILE_TITLE[view];
  const mobileBack = !mobileMore && MOBILE_SECONDARY.includes(view);
  const pickMobileTab = (tab: MobileTab) => {
    if (tab === 'more') { setMobileMore(true); return; }
    setMobileMore(false);
    nav(tab);
  };
  // 各视图内容是否应显示:桌面恒为 `view === id`;移动端「更多」菜单打开时,一律让位给菜单
  const isShown = (id: ViewId) => view === id && !mobileMore;

  return (
    <div className="app">
      <div id="wall" aria-hidden="true" style={wallUrl ? { backgroundImage: `url("${wallUrl}")` } : undefined} />
      <aside className="sidebar">
        <div className="brand">
          {/* 璇玑玉璧剪影,1:1 还原获批原型 wiki/design/prototype.html(feat(design) 48d1935);
              favicon 复用同一剪影(见 index.html),两者此前只落进了原型与 DESIGN.md token,
              从未真正接入这个组件,侧栏一直是纯文字品牌区。 */}
          <svg className="brand-mark" viewBox="-66.9 -53.29 1438.85 1438.85" aria-hidden="true" focusable="false">
            <g transform="translate(129.962149,1193.807683) scale(0.100000,-0.100000)" fill="currentColor" stroke="none">
              <path d="M4950 8329 c-153 -11 -376 -50 -531 -93 -344 -95 -676 -262 -946 -476 -730 -579 -1116 -1564 -957 -2443 14 -74 19 -87 33 -82 9 4 49 15 90 26 207 53 421 -8 576 -165 81 -82 123 -149 159 -256 80 -240 9 -478 -169 -565 -180 -89 -415 16 -415 185 0 124 117 201 236 155 25 -9 48 -14 52 -10 4 3 6 33 6 65 -2 111 -86 228 -191 264 -61 21 -186 21 -249 -1 -157 -53 -283 -199 -328 -384 -21 -84 -21 -261 -1 -368 94 -492 577 -1127 1150 -1511 347 -232 711 -373 1132 -437 156 -24 537 -24 698 0 399 59 803 210 1130 424 138 91 356 265 345 276 -3 3 -30 17 -60 32 -160 80 -306 216 -366 341 -89 185 -82 424 18 604 100 179 244 290 424 327 222 45 425 -89 441 -291 6 -66 -16 -136 -55 -180 -41 -46 -138 -69 -199 -45 -57 21 -113 93 -113 144 0 14 -6 25 -13 25 -22 0 -100 -55 -136 -95 -58 -67 -76 -118 -76 -220 0 -80 3 -97 31 -155 53 -113 168 -204 309 -246 79 -24 236 -23 324 0 83 22 201 83 273 140 277 221 504 788 568 1420 27 259 2 625 -60 906 -209 942 -807 1756 -1567 2134 -72 37 -138 66 -146 66 -12 0 -13 -7 -6 -37 24 -103 2 -240 -54 -348 -38 -73 -143 -180 -217 -222 -81 -46 -188 -73 -291 -73 -389 0 -662 327 -476 571 41 54 124 99 182 99 56 0 123 -36 146 -80 32 -58 19 -153 -24 -189 -25 -20 -21 -29 21 -47 24 -11 65 -17 117 -18 70 0 86 3 134 29 89 49 131 118 147 241 7 61 -15 155 -53 226 -15 28 -60 80 -99 117 -142 133 -320 197 -609 221 -141 11 -167 11 -335 -1z m371 -2228 c270 -69 498 -296 570 -567 28 -105 30 -289 5 -389 -76 -292 -306 -522 -593 -592 -96 -23 -267 -23 -363 1 -294 73 -525 302 -597 593 -24 99 -22 285 5 384 79 295 329 527 629 584 98 18 241 13 344 -14z" />
            </g>
          </svg>
          <div className="brand-text">
            <span className="zh">璇玑</span>
            <span className="brand-meta"><span className="version">v{__APP_VERSION__}</span></span>
          </div>
        </div>
        <nav className="nav">
          {NAVS.map((n, i) => (
            <button
              key={n.id}
              className={view === n.id ? 'active' : ''}
              title={`快捷键 ⌘${i + 1}(非输入状态也可直接按 ${i + 1});⌥⌘←/→ 在侧栏前后切换`}
              onClick={() => nav(n.id)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round">
                <path d={n.icon} />
              </svg>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <button
            className="stg-entry"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            title={`设置 ${formatCombo(localPrefs.keymap['global.settings'])}`}
            onClick={() => setSettingsOpen(true)}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z" />
              <path d="M6.7 1.8h2.6l.4 1.6 1.4.8 1.6-.5 1.3 2.2-1.2 1.1v1.6l1.2 1.1-1.3 2.2-1.6-.5-1.4.8-.4 1.6H6.7l-.4-1.6-1.4-.8-1.6.5L2 11.6l1.2-1.1V8.9L2 7.8l1.3-2.2 1.6.5 1.4-.8z" />
            </svg>
            <span className="stg-entry-label">设置</span>
            <span className="stg-entry-state" title={wallStateLabel(wall)}>
              {wallStateLabel(wall)}
            </span>
          </button>
          <div className="row">
            <span className="ok" style={!health?.cli ? { background: 'var(--red)' } : undefined} />
            {health === null ? '连接后端…' : health.cli ? `${health.cli} · 就绪` : '后端可用 · CLI 不可达'}
          </div>
        </div>
      </aside>

      {/* 移动端专属外壳:桌面 CSS 隐藏(见 index.css)。顶栏承接标题/返回,内容仍是下面同一套 <section> */}
      <header className="mobile-topbar">
        {mobileBack ? (
          <button className="back" onClick={() => setMobileMore(true)}>
            ‹ <b>更多</b>
          </button>
        ) : (
          <h1>{mobileTitle}</h1>
        )}
        <span className="daemon">
          <span className="ok" style={!health?.cli ? { background: 'var(--red)' } : undefined} />
          daemon
        </span>
      </header>

      <main className="main">
        {/* 外壳家具:挂在所有 <section class="view"> 之外,切视图时不重挂载(见 DESIGN.md §5) */}
        <StatusBar health={health} reviewCount={reviewCount} onGoReview={() => nav('dashboard')} />

        <section className={cn('view', isShown('dashboard') && 'active')}>
          {isShown('dashboard') && <Dashboard onGoSession={goSession} />}
        </section>
        <section className={cn('view', isShown('projects') && 'active')}>
          {isShown('projects') && <Projects />}
        </section>
        <section className={cn('view', isShown('sessions') && 'active')}>
          <Sessions active={isShown('sessions')} registerHandle={(h) => (sessionsHandle.current = h)} />
        </section>
        <section className={cn('view', isShown('dispatch') && 'active')}>
          <Dispatch active={isShown('dispatch')} />
        </section>
        <section className={cn('view', isShown('skills') && 'active')}>
          {isShown('skills') && <Skills />}
        </section>
        <section className={cn('view', isShown('memory') && 'active')}>
          {isShown('memory') && <Memories />}
        </section>
        <section className={cn('view', isShown('cron') && 'active')}>
          {isShown('cron') && <Crons />}
        </section>
        <section className={cn('view', isShown('review') && 'active')}>
          {isShown('review') && <Review />}
        </section>
        <section className={cn('view', isShown('worklog') && 'active')}>
          {isShown('worklog') && <Worklog onGoSession={goSession} />}
        </section>
        <section className={cn('view', isShown('todo') && 'active')}>
          {isShown('todo') && <Todos />}
        </section>
        {/* 移动端「更多」菜单:桌面 mobileMore 恒为 false,这个 section 永远不 active */}
        <section className={cn('view', mobileMore && 'active')}>
          {mobileMore && <MoreMenu onNav={(v) => { setMobileMore(false); nav(v); }} health={health} wall={wall} onOpenSettings={() => setSettingsOpen(true)} />}
        </section>
      </main>

      <TabBar active={mobileTabOf(view, mobileMore)} blockedCount={blockedCount} onPick={pickMobileTab} />

      {todoPalette && (
        <TodoPalette
          onClose={() => setTodoPalette(false)}
          onCreated={(todo, andStart) => {
            notifyTodosChanged(); // 待办页/仪表盘卡立刻显示刚记的这条,不等下一次轮询
            // ⌘↩ = 存下来顺手就开工;普通 ↩ 只落库,吐一条 toast 说明去哪找它
            if (andStart) void startTodo(todo);
            else toast(`已记入待办${todo.project ? `(${todo.project})` : ''}`);
          }}
        />
      )}

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        cwdOptions={projectsData?.projects.map((p) => p.path) ?? []}
        wall={wall}
        patchWall={patchWall}
      />

      <ToastHost />
      <ConfirmHost />
    </div>
  );
}
