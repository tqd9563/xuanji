import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribeChanges } from '@/api/client';
import { useHashRoute, VIEW_IDS, isTypingTarget, type ViewId } from '@/lib/hooks';
import { ConfirmHost, ToastHost } from '@/components/shared';
import { Dashboard } from '@/views/Dashboard';
import { Projects } from '@/views/Projects';
import { Sessions, type SessionsHandle } from '@/views/Sessions';
import { Dispatch } from '@/views/Dispatch';
import { Skills } from '@/views/Skills';
import { Memories } from '@/views/Memories';
import { Crons } from '@/views/Crons';

const NAVS: { id: ViewId; label: string; icon: string }[] = [
  { id: 'dashboard', label: '仪表盘', icon: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z' },
  { id: 'projects', label: '项目', icon: 'M3 7l3-4h5l2 3h8v13H3z' },
  { id: 'sessions', label: '会话', icon: 'M4 5h16v11H8l-4 4z' },
  { id: 'dispatch', label: '派发', icon: 'M3 12l18-8-6 18-3-7z' },
  { id: 'skills', label: '技能', icon: 'M12 2l2.6 6.6L21 11l-6.4 2.4L12 20l-2.6-6.6L3 11l6.4-2.4z' },
  { id: 'memory', label: '经验', icon: 'M5 3h11l3 3v15H5zM9 8h7M9 12h7M9 16h4' },
  { id: 'cron', label: '定时', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v5l3 2' },
];

export default function App() {
  const [view, nav] = useHashRoute();
  const [health, setHealth] = useState<{ cli: string | null } | null>(null);
  const sessionsHandle = useRef<SessionsHandle | null>(null);

  useEffect(() => {
    api
      .dashboard()
      .then((d) => setHealth({ cli: d.health.cli }))
      .catch(() => setHealth({ cli: null }));
  }, []);

  // ws 变更订阅(M1 仅日志级消费:轮询已覆盖刷新;保留通道供 M2 扩展)
  useEffect(() => subscribeChanges(() => {}), []);

  // 数字键 1-7 直切视图(焦点在输入控件或含修饰键时失效)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const i = parseInt(e.key, 10);
      if (i >= 1 && i <= VIEW_IDS.length) nav(VIEW_IDS[i - 1]!);
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

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="zh">璇玑</span>
          <span className="en">xuanji</span>
        </div>
        <nav className="nav">
          {NAVS.map((n, i) => (
            <button
              key={n.id}
              className={view === n.id ? 'active' : ''}
              title={`快捷键 ${i + 1}`}
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
          <div className="row">
            <span className="ok" style={!health?.cli ? { background: 'var(--red)' } : undefined} />
            {health === null ? '连接后端…' : health.cli ? `${health.cli} · 就绪` : '后端可用 · CLI 不可达'}
          </div>
        </div>
      </aside>

      <main className="main">
        <section className={`view ${view === 'dashboard' ? 'active' : ''}`}>
          {view === 'dashboard' && <Dashboard onGoSession={goSession} />}
        </section>
        <section className={`view ${view === 'projects' ? 'active' : ''}`}>
          {view === 'projects' && <Projects />}
        </section>
        <section className={`view ${view === 'sessions' ? 'active' : ''}`}>
          <Sessions active={view === 'sessions'} registerHandle={(h) => (sessionsHandle.current = h)} />
        </section>
        <section className={`view ${view === 'dispatch' ? 'active' : ''}`}>
          <Dispatch active={view === 'dispatch'} />
        </section>
        <section className={`view ${view === 'skills' ? 'active' : ''}`}>
          {view === 'skills' && <Skills />}
        </section>
        <section className={`view ${view === 'memory' ? 'active' : ''}`}>
          {view === 'memory' && <Memories />}
        </section>
        <section className={`view ${view === 'cron' ? 'active' : ''}`}>
          {view === 'cron' && <Crons />}
        </section>
      </main>

      <ToastHost />
      <ConfirmHost />
    </div>
  );
}
