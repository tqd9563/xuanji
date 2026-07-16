import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribeChanges } from '@/api/client';
import { useHashRoute, usePoll, VIEW_IDS, isTypingTarget, type ViewId } from '@/lib/hooks';
import { setPalette, cn } from '@/lib/utils';
import { ConfirmHost, ToastHost } from '@/components/shared';
import { WallpaperSettings } from '@/components/WallpaperSettings';
import { useWallpaper, wallSrcUrl } from '@/lib/wallpaper';
import { TabBar, mobileTabOf, type MobileTab } from '@/components/TabBar';
import { MoreMenu } from '@/components/MoreMenu';
import { Dashboard } from '@/views/Dashboard';
import { Projects } from '@/views/Projects';
import { Sessions, type SessionsHandle } from '@/views/Sessions';
import { Dispatch } from '@/views/Dispatch';
import { Skills } from '@/views/Skills';
import { Memories } from '@/views/Memories';
import { Crons } from '@/views/Crons';
import { Review } from '@/views/Review';

const NAVS: { id: ViewId; label: string; icon: string }[] = [
  { id: 'dashboard', label: '仪表盘', icon: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z' },
  { id: 'projects', label: '项目', icon: 'M3 7l3-4h5l2 3h8v13H3z' },
  { id: 'sessions', label: '会话', icon: 'M4 5h16v11H8l-4 4z' },
  { id: 'dispatch', label: '派发', icon: 'M3 12l18-8-6 18-3-7z' },
  { id: 'skills', label: '技能', icon: 'M12 2l2.6 6.6L21 11l-6.4 2.4L12 20l-2.6-6.6L3 11l6.4-2.4z' },
  { id: 'memory', label: '经验', icon: 'M5 3h11l3 3v15H5zM9 8h7M9 12h7M9 16h4' },
  { id: 'cron', label: '定时', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v5l3 2' },
  { id: 'review', label: '回顾', icon: 'M4 5h16v16H4zM4 9.5h16M8.5 3v4M15.5 3v4M8 14l2.5 2.5L16 12' },
];

/** 移动端(≤430px)导航是 5-tab + 更多 二级菜单;这四个视图归入更多,详见 TabBar.mobileTabOf */
const MOBILE_SECONDARY: ViewId[] = ['projects', 'skills', 'memory', 'review'];
const MOBILE_TITLE: Record<ViewId, string> = {
  dashboard: '首页', sessions: '会话', dispatch: '派发', cron: '定时任务',
  projects: '项目', skills: '技能', memory: '经验', review: '回顾',
};

export default function App() {
  const [view, nav] = useHashRoute();
  const [health, setHealth] = useState<{ cli: string | null } | null>(null);
  const [, setPaletteReady] = useState(false);
  const sessionsHandle = useRef<SessionsHandle | null>(null);
  const [wall, patchWall] = useWallpaper();
  const [wallOpen, setWallOpen] = useState(false);
  const wallUrl = wallSrcUrl(wall);

  // 移动端「更多」二级菜单开关:项目/技能/经验/回顾在窄屏归入此菜单(见 MOBILE_SECONDARY)。
  // 任何真实导航(hash 变化,无论来自 tab 点击、更多菜单选择、深链或浏览器前进后退)都应该
  // 让位给目标视图本身,菜单开合只由「更多」tab 或次要视图的返回按钮显式触发(两者都不改 hash)。
  const [mobileMore, setMobileMore] = useState(false);
  useEffect(() => setMobileMore(false), [view]);
  // 会话 tab 徽章:与 Sessions.tsx 共享同一 fetcher 引用,命中 pollCache,不重复拉取
  const { data: sessData } = usePoll(api.sessions, 5_000);
  const blockedCount = sessData?.columns.blocked.length ?? 0;

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

  // 视图切换双通道:⌘+数字任何时候可用(含输入框聚焦,Pake 壳主用);
  // 裸数字在非输入状态保留(普通浏览器里 ⌘+数字被标签页快捷键占用时的兜底)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘N 新建会话:跳派发页并放下当前会话(浏览器里 ⌘N 被"新建窗口"占用,Pake 壳可用)
      if ((e.key === 'n' || e.key === 'N') && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('xuanji:new-session'));
        nav('dispatch');
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
  }, [nav]);

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
          <span className="zh">璇玑</span>
          <span className="en">xuanji</span>
          <span className="version">v1.2.0</span>
        </div>
        <nav className="nav">
          {NAVS.map((n, i) => (
            <button
              key={n.id}
              className={view === n.id ? 'active' : ''}
              title={`快捷键 ⌘${i + 1}(非输入状态也可直接按 ${i + 1})`}
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
          <WallpaperSettings wall={wall} patch={patchWall} open={wallOpen} onToggle={setWallOpen} />
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
        {/* 移动端「更多」菜单:桌面 mobileMore 恒为 false,这个 section 永远不 active */}
        <section className={cn('view', mobileMore && 'active')}>
          {mobileMore && <MoreMenu onNav={(v) => { setMobileMore(false); nav(v); }} health={health} />}
        </section>
      </main>

      <TabBar active={mobileTabOf(view, mobileMore)} blockedCount={blockedCount} onPick={pickMobileTab} />

      <ToastHost />
      <ConfirmHost />
    </div>
  );
}
