/**
 * 全局终端浮层 + 状态栏指示器(DESIGN.md「全局终端」)。
 *
 * - 单实例、挂在 App 最外层:任意视图 ⌘` 呼出/收起,切视图不卸载,xterm 实例与 WebSocket 常驻。
 * - 收起时用 visibility 隐藏(不 display:none):xterm 需要真实尺寸才能 fit,且重新呼出不必重排。
 * - 后端会话跟后端进程走:页面刷新后拉 /api/terminal/info 把还活着的 shell 重新接上并回放输出。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Terminal as XTerm } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { api } from '@/api/client';
import { toast } from '@/components/shared';
import { getAccount, useAccountPrefs } from '@/lib/prefs';
import {
  baseName,
  contextCwd,
  fontStack,
  getTerm,
  loadTermImage,
  resolveLook,
  setLook,
  setTerm,
  shortPath,
  toXtermTheme,
  useTerm,
  type TermTab,
} from '@/lib/terminal';
import { cn } from '@/lib/utils';

interface Live {
  term: XTerm;
  fit: FitAddon;
  el: HTMLDivElement;
  ws: WebSocket | null;
  /** 连接断了之后的重连计时 */
  retry: number;
}

/** 浮层是否打开(给 App 的快捷键与视图切换用) */
export function toggleTerminal(show?: boolean) {
  const s = getTerm();
  const next = show ?? !s.open;
  if (next === s.open) return;
  setTerm({ open: next });
}

/* ---------------- 状态栏指示器 ---------------- */

export function TerminalIndicator({ shortcut }: { shortcut: string }) {
  const s = useTerm();
  if (!s.info?.local) return null;
  const run = s.tabs.filter((t) => t.busy).length;
  const label = run ? `${run} 在跑` : s.tabs.length ? `${s.tabs.length} 个` : '未开';
  return (
    <button
      className={cn('sb-item', 'tty-sb', s.tabs.length > 0 && 'on', run > 0 && 'run')}
      aria-controls="tty-c"
      aria-expanded={s.open}
      title={`终端 · ${shortcut} 呼出/收起`}
      onClick={() => toggleTerminal()}
    >
      <span className="dot" />
      终端 <span className="n">{label}</span>
    </button>
  );
}

/* ---------------- 浮层 ---------------- */

export function TerminalSheet({
  viewKey,
  cwdOptions,
  onOpenSettings,
}: {
  /** 当前视图 id:切视图时按「切换视图时」设置决定是否收起 */
  viewKey: string;
  cwdOptions: string[];
  onOpenSettings: () => void;
}) {
  const s = useTerm();
  const { prefs } = useAccountPrefs();
  const look = useMemo(() => resolveLook(s.look, s.info?.ghostty ?? null), [s.look, s.info]);
  const lives = useRef(new Map<string, Live>());
  const hostRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const cwdBtnRef = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState(false);
  /** xterm 懒加载(见 lib/xterm-kit.ts):有标签要渲染时才拉 */
  const kit = useRef<typeof import('@/lib/xterm-kit') | null>(null);
  const [kitReady, setKitReady] = useState(false);

  /* ---- 首次:拉环境信息 + 接回还活着的会话 ---- */
  useEffect(() => {
    let dead = false;
    api
      .termInfo()
      .then((info) => {
        if (dead) return;
        setTerm((st) => ({
          info,
          tabs: info.sessions.map((x) => ({ ...x })),
          activeId: st.activeId ?? info.sessions[0]?.id ?? null,
        }));
      })
      .catch(() => setTerm({ info: { local: false, ghostty: null, systemHotkeys: [], sessions: [] } }));
    void loadTermImage();
    return () => {
      dead = true;
    };
  }, []);

  /* ---- 标签操作 ---- */
  const openTab = useCallback(async (cwd?: string) => {
    const st = getTerm();
    const target = cwd ?? contextCwd(getAccount().terminal.cwdMode, st.dispatchCwd, st.lastCwd);
    const cur = st.activeId ? lives.current.get(st.activeId) : null;
    try {
      const { session } = await api.termCreate({ cwd: target, cols: cur?.term.cols, rows: cur?.term.rows });
      setTerm((x) => ({ tabs: [...x.tabs, session], activeId: session.id, lastCwd: session.cwd, open: true }));
    } catch (e) {
      toast(`终端开不起来:${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const removeTab = useCallback((id: string, kill: boolean) => {
    if (kill) void api.termKill(id).catch(() => {});
    setTerm((x) => {
      const i = x.tabs.findIndex((t) => t.id === id);
      if (i < 0) return {};
      const tabs = x.tabs.filter((t) => t.id !== id);
      const activeId = x.activeId === id ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : x.activeId;
      return { tabs, activeId, open: tabs.length ? x.open : false };
    });
  }, []);

  const fitActive = useCallback(() => {
    const id = getTerm().activeId;
    const l = id ? lives.current.get(id) : null;
    if (!l || !getTerm().open) return;
    try {
      l.fit.fit();
    } catch {
      /* 容器尚未有尺寸 */
    }
  }, []);

  /* ---- 标签 ↔ xterm 实例:多出来的建,消失的拆 ---- */
  const connect = useCallback((id: string, l: Live) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/terminal?id=${encodeURIComponent(id)}`);
    l.ws = ws;
    let replayed = false;
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as
        | { t: 'replay' | 'out'; d: string }
        | { t: 'status'; proc: string; busy: boolean }
        | { t: 'exit'; code: number };
      if (m.t === 'replay') {
        // 重连回放前清屏,免得同一段输出出现两遍
        if (!replayed) l.term.reset();
        replayed = true;
        l.term.write(m.d);
      } else if (m.t === 'out') l.term.write(m.d);
      else if (m.t === 'status')
        setTerm((st) => ({ tabs: st.tabs.map((t) => (t.id === id ? { ...t, proc: m.proc, busy: m.busy } : t)) }));
      else if (m.t === 'exit') removeTab(id, false);
    };
    ws.onopen = () => {
      l.retry = 0;
      ws.send(JSON.stringify({ t: 'resize', cols: l.term.cols, rows: l.term.rows }));
    };
    ws.onclose = () => {
      if (!lives.current.has(id)) return;
      // 后端重启:会话已随之结束,摘掉标签;网络抖动:退避重连
      if (l.retry >= 3) {
        removeTab(id, false);
        return;
      }
      l.retry++;
      setTimeout(() => lives.current.get(id) === l && connect(id, l), 800 * l.retry);
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!kit.current) {
      if (s.tabs.length)
        void import('@/lib/xterm-kit').then((k) => {
          kit.current = k;
          setKitReady(true);
        });
      return;
    }
    const { Terminal, FitAddon, Unicode11Addon, WebLinksAddon } = kit.current;
    for (const tab of s.tabs) {
      if (lives.current.has(tab.id)) continue;
      const el = document.createElement('div');
      el.className = 'tty-pane';
      host.appendChild(el);
      const term = new Terminal({
        allowTransparency: true,
        allowProposedApi: true,
        fontFamily: fontStack(look.fontName),
        fontSize: look.fontSize,
        lineHeight: 1 + 2 / (look.fontSize * 1.2), // Ghostty adjust-cell-height = 2
        cursorStyle: look.cursorStyle,
        cursorBlink: look.cursorBlink,
        theme: toXtermTheme(look.theme),
        scrollback: 10_000,
        macOptionIsMeta: false,
        drawBoldTextInBrightColors: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = '11';
      term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')));
      // ⌘ 组合一律交还给页面:⌘C/⌘V 走浏览器原生复制粘贴,⌘` / ⌘T / ⌘K 等由全局监听处理
      term.attachCustomKeyEventHandler((e) => !e.metaKey);
      term.open(el);
      const l: Live = { term, fit, el, ws: null, retry: 0 };
      lives.current.set(tab.id, l);
      term.onData((d) => l.ws?.readyState === WebSocket.OPEN && l.ws.send(JSON.stringify({ t: 'in', d })));
      term.onResize(({ cols, rows }) => l.ws?.readyState === WebSocket.OPEN && l.ws.send(JSON.stringify({ t: 'resize', cols, rows })));
      try {
        fit.fit();
      } catch {
        /* 首次挂载时容器可能还没尺寸 */
      }
      connect(tab.id, l);
    }
    for (const [id, l] of lives.current) {
      if (s.tabs.some((t) => t.id === id)) continue;
      lives.current.delete(id);
      l.ws?.close();
      l.term.dispose();
      l.el.remove();
    }
    // 只在标签集合变化时跑;外观变化由下一个 effect 推给已有实例
  }, [s.tabs.map((t) => t.id).join(','), kitReady]);

  /* ---- 外观变化推给所有实例 ---- */
  useEffect(() => {
    for (const l of lives.current.values()) {
      l.term.options.fontFamily = fontStack(look.fontName);
      l.term.options.fontSize = look.fontSize;
      l.term.options.lineHeight = 1 + 2 / (look.fontSize * 1.2);
      l.term.options.cursorStyle = look.cursorStyle;
      l.term.options.cursorBlink = look.cursorBlink;
      l.term.options.theme = toXtermTheme(look.theme);
    }
    fitActive();
  }, [look, fitActive]);

  /* ---- 激活标签:显隐 + fit + 聚焦 ---- */
  useEffect(() => {
    for (const [id, l] of lives.current) l.el.classList.toggle('active', id === s.activeId);
    if (!s.open) return;
    fitActive();
    const l = s.activeId ? lives.current.get(s.activeId) : null;
    l?.term.focus();
  }, [s.activeId, s.open, s.tabs.length, fitActive, kitReady]);

  /* ---- 打开 / 收起:焦点管理 ---- */
  useLayoutEffect(() => {
    if (s.open) {
      const a = document.activeElement;
      if (a instanceof HTMLElement && !sheetRef.current?.contains(a)) lastFocus.current = a;
      // 没有标签就开一个
      if (!getTerm().tabs.length && getTerm().info?.local) void openTab();
    } else {
      // WebKit(Pake 壳)不会自动收走 visibility:hidden 元素里的焦点,残留焦点会让按键打进
      // 看不见的终端里——必须显式 blur(见 memory:WebKit 隐藏元素焦点残留)
      const a = document.activeElement;
      if (a instanceof HTMLElement && sheetRef.current?.contains(a)) {
        a.blur();
        const back = lastFocus.current;
        if (back && back.isConnected && back.getClientRects().length > 0) back.focus({ preventScroll: true });
      }
      setMenu(null);
    }
  }, [s.open]);

  /* ---- 尺寸变化 → fit(拖高、最大化、窗口缩放) ---- */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fitActive);
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [fitActive]);

  /* ---- 切视图:按设置决定保持还是收起 ---- */
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    if (prefs.terminal.navMode === 'hide') toggleTerminal(false);
  }, [viewKey]);

  /* ---- 浮层内快捷键(仅焦点在浮层里时) ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!sheetRef.current?.contains(document.activeElement) || !e.metaKey) return;
      const st = getTerm();
      const k = e.key.toLowerCase();
      if (k === 't' && !e.shiftKey) {
        e.preventDefault();
        void openTab();
      } else if (k === 'k' && !e.shiftKey) {
        e.preventDefault();
        const l = st.activeId ? lives.current.get(st.activeId) : null;
        l?.term.clear();
      } else if (e.shiftKey && (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}')) {
        e.preventDefault();
        if (st.tabs.length < 2) return;
        const i = st.tabs.findIndex((t) => t.id === st.activeId);
        const d = e.key === '[' || e.key === '{' ? -1 : 1;
        setTerm({ activeId: st.tabs[(i + d + st.tabs.length) % st.tabs.length]!.id });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openTab]);

  /* ---- 拖高 ---- */
  const onGrip = (e: React.PointerEvent<HTMLDivElement>) => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const g = e.currentTarget;
    const h0 = sheet.getBoundingClientRect().height;
    const y0 = e.clientY;
    g.setPointerCapture(e.pointerId);
    setDragging(true);
    if (s.max) setTerm({ max: false });
    let h = h0;
    const mv = (ev: PointerEvent) => {
      h = Math.max(140, Math.min(window.innerHeight - 56, h0 - (ev.clientY - y0)));
      sheet.style.setProperty('--tty-h', `${h}px`);
    };
    const up = () => {
      g.removeEventListener('pointermove', mv);
      setDragging(false);
      setLook({ ...getTerm().look, height: Math.round(h) });
    };
    g.addEventListener('pointermove', mv);
    g.addEventListener('pointerup', up, { once: true });
  };

  /* ---- 目录菜单(portal 到 body:浮层 overflow:hidden 会裁掉原地菜单) ---- */
  const openMenu = () => {
    if (menu) return setMenu(null);
    const r = cwdBtnRef.current?.getBoundingClientRect();
    if (r) setMenu({ left: Math.max(8, r.right - 300), top: r.bottom + 6 });
  };
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      const t = e.target as Node;
      if (e instanceof PointerEvent && (document.getElementById('tty-cwd-menu')?.contains(t) || cwdBtnRef.current?.contains(t))) return;
      setMenu(null);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menu]);

  if (!s.info?.local) return null;

  const ctx = contextCwd(prefs.terminal.cwdMode, s.dispatchCwd, s.lastCwd);
  const menuDirs = [...new Set(cwdOptions)].filter((d) => d !== s.dispatchCwd).slice(0, 8);
  const style = {
    '--tty-h': `${s.look.height}px`,
    '--t-bg': look.background,
    '--t-fg': look.theme.foreground,
    '--t-op': `${look.opacity}%`,
    '--t-blur': `${look.blur}px`,
    '--t-accent': look.theme.palette[4],
    '--t-ok': look.theme.palette[2],
    '--t-dim': look.theme.palette[8],
    '--t-imgop': look.imgOpacity / 100,
    // 模糊走内联而非样式表:构建链(Tailwind v4 / lightningcss)会把无前缀的 backdrop-filter 折叠成
    // 只剩 -webkit- 前缀,Chrome 不认前缀版 → 模糊整体失效(全站壁纸玻璃档同病,另案)。内联样式不经过它。
    backdropFilter: look.blur ? `blur(${look.blur}px) saturate(1.2)` : 'none',
    WebkitBackdropFilter: look.blur ? `blur(${look.blur}px) saturate(1.2)` : 'none',
  } as React.CSSProperties;

  return (
    <>
      <div
        ref={sheetRef}
        id="tty-c"
        className={cn('tty-c', s.open && 'open', s.max && 'max', dragging && 'dragging', look.hasImg && s.imgUrl && 'has-img')}
        style={style}
        role="dialog"
        aria-label="终端"
        aria-hidden={!s.open}
        onTransitionEnd={(e) => e.target === sheetRef.current && e.propertyName === 'transform' && fitActive()}
      >
        <div className="tty-bgimg" aria-hidden="true" style={s.imgUrl ? { backgroundImage: `url("${s.imgUrl}")` } : undefined} />
        <div className="tty-grip" title="拖动调整高度" onPointerDown={onGrip} />
        <div className="tty-head">
          <div className="tty-tabs" role="tablist">
            {s.tabs.map((t: TermTab) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={t.id === s.activeId}
                className={cn('tty-tab', t.id === s.activeId && 'active', t.busy && 'run')}
                title={shortPath(t.cwd)}
                onClick={() => setTerm({ activeId: t.id })}
              >
                <span className="dot" />
                <span>{baseName(shortPath(t.cwd))}</span>
                {t.busy && <span className="tty-proc">{t.proc}</span>}
                <span
                  className="tty-x"
                  role="button"
                  aria-label="关闭这个终端"
                  title="关闭(结束该 shell)"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeTab(t.id, true);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
            <button className="tty-add" title={`新终端 ⌘T · ${shortPath(ctx)}`} onClick={() => void openTab()}>
              +
            </button>
          </div>
          <span className="tty-spacer" />
          <button ref={cwdBtnRef} className="tty-cwd" title="在其它目录开新终端" onClick={openMenu} aria-expanded={!!menu}>
            <span>{shortPath(ctx)}</span>
            <span className="caret">▾</span>
          </button>
          <button className="tty-ib" title="终端设置" aria-label="终端设置" onClick={onOpenSettings}>
            ⚙
          </button>
          <button className="tty-ib" title={s.max ? '还原' : '最大化'} aria-label="最大化" onClick={() => setTerm({ max: !s.max })}>
            ⤢
          </button>
          <button className="tty-ib" title="收起 ⌘`" aria-label="收起终端" onClick={() => toggleTerminal(false)}>
            ✕
          </button>
        </div>
        <div className="tty-host" ref={hostRef} />
      </div>
      {menu &&
        createPortal(
          <div id="tty-cwd-menu" className="tty-menu" style={{ left: menu.left, top: menu.top }} role="menu">
            <div className="tty-menu-title">在哪个目录开新终端</div>
            {s.dispatchCwd && (
              <button className="dd-item tty-ctx" role="menuitem" onClick={() => (setMenu(null), void openTab(s.dispatchCwd!))}>
                <span className="dd-item-label">当前会话 worktree</span>
                <span className="tty-menu-path">{shortPath(s.dispatchCwd)}</span>
              </button>
            )}
            {menuDirs.map((d) => (
              <button key={d} className="dd-item" role="menuitem" onClick={() => (setMenu(null), void openTab(d))}>
                <span className="dd-item-label">{shortPath(d)}</span>
              </button>
            ))}
            <div className="tty-menu-sep" />
            <button className="dd-item" role="menuitem" onClick={() => (setMenu(null), void openTab('~'))}>
              <span className="dd-item-label">~</span>
              <span className="tty-menu-path">家目录</span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
