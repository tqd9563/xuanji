import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '@/api/client';
import { cn, projBg, projColor } from '@/lib/utils';
import type { SessionState } from '@/api/types';

// ---------- Markdown 渲染(统一出口) ----------

/** 外链点击:能力检测而非环境嗅探(Pake 壳 UA 伪装成完整 Safari,UA 嗅探不可靠)。
 *  统一 window.open:真浏览器返回窗口句柄(成功);Pake/Tauri 的 WKWebView 没有
 *  新窗口代理时返回 null(新窗口请求被吞),此时且为本机访问(壳固定加载
 *  127.0.0.1:7777)才走后端 /api/open-url 在宿主 mac 唤起系统默认浏览器。
 *  stopPropagation 阻断壳注入的 body 级 target=_blank 监听,避免其 IPC 可用时双开。 */
function onMdLinkClick(e: MouseEvent<HTMLAnchorElement>) {
  const href = e.currentTarget.href;
  if (!href) return;
  // 修饰键点击(⌘/Ctrl/Shift/中键)交给浏览器默认行为
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const w = window.open(href, '_blank');
  if (w) {
    w.opener = null; // 防 reverse tabnabbing(会话内容按不可信数据处理)
  } else if (['127.0.0.1', 'localhost'].includes(window.location.hostname)) {
    void api.openUrl(href).catch(() => {});
  }
}

// 链接一律新窗口打开:浏览器里避免同窗导航把 SPA 整页带走;
// Pake/Tauri WKWebView 里同窗跨域导航会被吞,new-window 请求才会转交系统浏览器。
const MD_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer" onClick={onMdLinkClick} />
  ),
};

/** Claude 输出的 markdown 统一渲染:gfm(裸 URL 自动成链)+ 外链新窗口打开 */
export function Md({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {children}
    </Markdown>
  );
}

// ---------- 状态胶囊 ----------

const PILL: Record<SessionState | 'err', { cls: string; label: string }> = {
  running: { cls: 'pill-run', label: '运行中' },
  blocked: { cls: 'pill-blk', label: '等待输入' },
  idle: { cls: 'pill-idle', label: '空闲' },
  done: { cls: 'pill-done', label: '已完成' },
  err: { cls: 'pill-err', label: '错误' },
};

export function Pill({ state, label }: { state: SessionState | 'err'; label?: string }) {
  const p = PILL[state];
  return (
    <span className={cn('pill', p.cls)}>
      <span className="dot" />
      {label ?? p.label}
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>;
}

/** 项目芯片:等明度分类色,悬停见完整路径 */
export function ProjChip({ name, path }: { name: string; path?: string }) {
  return (
    <span
      className="proj-chip"
      title={path ?? name}
      style={{ color: projColor(name), background: projBg(name) }}
    >
      {name}
    </span>
  );
}

// ---------- 空态 ----------

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <div className="glyph">◌</div>
      {children}
    </div>
  );
}

// ---------- 抽屉(右侧滑入,Esc/点背景关闭) ----------

export function Drawer({
  open,
  onClose,
  title,
  meta,
  foot,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  meta?: ReactNode;
  foot?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={cn('backdrop', open && 'show')} onClick={onClose} />
      <aside className={cn('drawer', open && 'show')} role="dialog" aria-modal="true">
        {open && (
          <>
            <div className="drawer-head">
              <div style={{ minWidth: 0, flex: 1 }}>
                <h2>{title}</h2>
                {meta && <div className="meta">{meta}</div>}
              </div>
              <button className="x-btn" onClick={onClose} aria-label="关闭">
                ✕
              </button>
            </div>
            <div className="drawer-body">{children}</div>
            {foot && <div className="drawer-foot">{foot}</div>}
          </>
        )}
      </aside>
    </>
  );
}

// ---------- Confirm(应用内确认框:Pake/Tauri 的 WKWebView 不支持 window.confirm) ----------

let pushConfirm: ((msg: string, resolve: (ok: boolean) => void) => void) | null = null;

export function confirmBox(msg: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (pushConfirm) pushConfirm(msg, resolve);
    else resolve(false);
  });
}

export function ConfirmHost() {
  const [req, setReq] = useState<{ msg: string; resolve: (ok: boolean) => void } | null>(null);
  useEffect(() => {
    pushConfirm = (msg, resolve) => setReq({ msg, resolve });
    return () => {
      pushConfirm = null;
    };
  }, []);
  const done = (ok: boolean) => {
    req?.resolve(ok);
    setReq(null);
  };
  const doneRef = useRef(done);
  doneRef.current = done;
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      // 吃掉整个按键:不拦截的话同一个 Enter 会继续传给看板键盘导航(确认删除的同时误入会话)
      e.preventDefault();
      e.stopImmediatePropagation();
      doneRef.current(e.key === 'Enter');
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [req]);
  if (!req) return null;
  return (
    <div className="confirm-mask" onClick={() => done(false)}>
      <div className="confirm-box" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <p>{req.msg}</p>
        <div className="confirm-actions">
          <button className="btn btn-sm" onClick={() => done(false)}>取消(Esc)</button>
          <button className="btn btn-sm btn-primary" onClick={() => done(true)} autoFocus>确认(Enter)</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Toast ----------

let pushToast: ((msg: string) => void) | null = null;
export function toast(msg: string) {
  pushToast?.(msg);
}

export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    pushToast = (m) => {
      setMsg(m);
      setShow(true);
      clearTimeout(timer);
      timer = setTimeout(() => setShow(false), 2400);
    };
    return () => {
      pushToast = null;
    };
  }, []);
  return (
    <div className={cn('toast', show && 'show')} role="status">
      {msg}
    </div>
  );
}

// ---------- 工具调用折叠卡 ----------

/** 工具名 → 类别色,按行为分组(执行/读取/写入/编排/Skill),而非逐工具上色。
 *  data-cat 由 CSS(.toolcard .tc-head .fn[data-cat=...])映射到 --tool-* / --blue / --violet。
 *  mcp__* 与未匹配的工具一律归 'other'(muted 中性),不参与争色。 */
function toolCategory(name: string): 'skill' | 'exec' | 'read' | 'write' | 'orch' | 'other' {
  if (name === 'Skill' || name === 'SlashCommand') return 'skill';
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell') return 'exec';
  if (name === 'Read' || name === 'Grep' || name === 'Glob' || name === 'LSP' || name === 'WebFetch' || name === 'WebSearch') return 'read';
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return 'write';
  if (name === 'Task' || name === 'TodoWrite' || name === 'EnterPlanMode' || name === 'ExitPlanMode') return 'orch';
  return 'other';
}

export function ToolCard({ name, input, output, isError }: { name: string; input: string; output?: string; isError?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn('toolcard', open && 'open')}>
      <button className="tc-head" onClick={() => setOpen(!open)}>
        <span className="fn" data-cat={toolCategory(name)} style={isError ? { color: 'var(--red)' } : undefined}>
          {name}
        </span>
        <span>{input}</span>
        <span className="chev">▾</span>
      </button>
      <div className="tc-body">{output ?? '(无输出)'}</div>
    </div>
  );
}
