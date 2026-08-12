import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '@/api/client';
import { cn, projBg, projColor } from '@/lib/utils';
import type { SessionState } from '@/api/types';

// ---------- Markdown 渲染(统一出口) ----------

/** 外链点击统一在 window 捕获阶段接管(installExternalLinkHandler)。
 *  为什么不挂在 React 的 onClick 上:Pake 壳在 document 上注入了自己的 a[target=_blank]
 *  拦截器,它先 preventDefault 再走 Tauri IPC,IPC 不可用时就"点了没反应";React 的委托
 *  监听器挂在根容器上,壳的 document 捕获监听跑在它之前。捕获阶段顺序是 window → document,
 *  所以只有 window 捕获监听能抢在壳前面。
 *  打开方式:本机访问(壳固定加载 127.0.0.1:7777)一律交后端 `open <url>` 唤起系统默认浏览器
 *  —— window.open 在 WKWebView 里会返回一个什么都不做的桩窗口,返回值不能当能力检测用。 */
function externalHref(target: EventTarget | null): string | null {
  const a = (target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a) return null;
  let url: URL;
  try {
    url = new URL(a.href, window.location.href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin === window.location.origin) return null; // 站内链接不接管
  return url.href;
}

function openExternal(href: string) {
  if (['127.0.0.1', 'localhost'].includes(window.location.hostname)) {
    void api.openUrl(href).catch(() => {});
    return;
  }
  const w = window.open(href, '_blank');
  if (w) w.opener = null; // 防 reverse tabnabbing(会话内容按不可信数据处理)
}

// 修饰键点击(⌘/Ctrl/Shift/中键)交给默认行为
function isPlainPrimary(e: globalThis.MouseEvent | PointerEvent) {
  return !(e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0);
}

/** 触摸板轻触在 WKWebView 里首次不派发 click(2026-08-05 屏幕探针实测:首次轻触只有
 *  pointerup/mouseup,连配对的 pointerdown 都没有,第二次才是完整的 down→up→click)。
 *  所以主通道走 pointerdown/pointerup,click 只兜底键盘激活,并吞掉 pointer 之后补发的
 *  那次 click 以免双开。用 pointerup 而非 pointerdown:拖拽选中文字时可按位移取消。 */
let pointerStart: { href: string; x: number; y: number } | null = null;
let swallowNextClick = false;

function onPointerDown(e: PointerEvent) {
  pointerStart = null;
  if (!isPlainPrimary(e)) return;
  const href = externalHref(e.target);
  if (href) pointerStart = { href, x: e.clientX, y: e.clientY };
}

function onPointerUp(e: PointerEvent) {
  const start = pointerStart;
  pointerStart = null;
  if (!isPlainPrimary(e)) return;
  let href: string | null;
  if (start) {
    // 只按位移判定:pointerup 的 target 可能因 blur/重排换了元素,拿它当判据会漏触发
    if (Math.abs(e.clientX - start.x) > 6 || Math.abs(e.clientY - start.y) > 6) return; // 拖拽选中,不当点击
    href = start.href;
  } else {
    // 触摸板首次轻触(尤其焦点在输入框时)WKWebView 只派发 pointerup,没有配对的 pointerdown;
    // 没有 down 就不可能是拖拽选中,直接当一次点击处理。
    href = externalHref(e.target);
    if (!href) return;
  }
  e.preventDefault();
  swallowNextClick = true;
  // 若浏览器没有补发 click(preventDefault 可能已抑制),及时撤销标记,免得吞掉下一次无关点击
  window.setTimeout(() => {
    swallowNextClick = false;
  }, 400);
  openExternal(href);
}

function onClick(e: globalThis.MouseEvent) {
  if (swallowNextClick) {
    swallowNextClick = false;
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  if (!isPlainPrimary(e)) return;
  const href = externalHref(e.target);
  if (!href) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  openExternal(href);
}

/** 在应用入口调用一次:全局接管外链点击(捕获阶段,抢在 Pake 壳注入的 document 拦截器前) */
export function installExternalLinkHandler() {
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('click', onClick, true);
}

// 链接一律标记新窗口:浏览器里避免同窗导航把 SPA 整页带走。
const MD_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

/** 裸 URL 自动成链的尾部修剪:GFM 的 autolink 只认 ASCII 标点作终止符,中文正文里
 *  「…/merge_requests/102(`feature/x`」会把全角括号、反引号、中文一并吞进 href。
 *  规则:遇到第一个非 ASCII 可见字符即连同其后全部截断,再剔掉尾部反引号与星号
 *  (加粗写法 `**url**` 的闭合 `**` 也会被吞,得到的非法端口让 new URL 抛错,
 *  外链接管与默认导航都放弃,表现为「点了没反应」——2026-08-11 实测)。
 *  代价:含未转义中文路径或以 `*` 结尾的 URL 会被截断——Claude 输出里几乎都是
 *  percent-encoded,可接受。 */
export function trimAutolinkTail(url: string): string {
  return url.replace(/[^!-~][\s\S]*$/, '').replace(/[`*]+$/, '');
}

type MdNode = { type: string; url?: string; value?: string; children?: MdNode[] };

/** remark 插件:把 autolink 误吞的尾巴从 link 里退回成普通文本 */
function remarkTrimAutolink() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      const kids = node.children;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (!child) continue;
        const text = child.children?.length === 1 ? child.children[0] : undefined;
        // 只处理 autolink(链接文本与 url 完全一致),显式 [文本](url) 不动
        if (child.type === 'link' && child.url && text?.type === 'text' && text.value === child.url) {
          const trimmed = trimAutolinkTail(child.url);
          if (trimmed && trimmed !== child.url) {
            const rest = child.url.slice(trimmed.length);
            child.url = trimmed;
            text.value = trimmed;
            kids.splice(i + 1, 0, { type: 'text', value: rest });
            i++;
          }
        }
        walk(child);
      }
    };
    walk(tree);
  };
}

/** Claude 输出的 markdown 统一渲染:gfm(裸 URL 自动成链)+ 尾巴修剪 + 外链新窗口打开 */
export function Md({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm, remarkTrimAutolink]} components={MD_COMPONENTS}>
      {children}
    </Markdown>
  );
}

// ---------- 状态胶囊 ----------

const PILL: Record<SessionState | 'err', { cls: string; label: string }> = {
  running: { cls: 'pill-run', label: '运行中' },
  blocked: { cls: 'pill-blk', label: '等待输入' },
  review: { cls: 'pill-rev', label: '验收中' },
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
  bodyRef,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  meta?: ReactNode;
  foot?: ReactNode;
  /** 滚动体的 ref:会话内查找(⌘F)需要拿它做查找作用域与高亮定位父级 */
  bodyRef?: RefObject<HTMLDivElement>;
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
            <div className="drawer-body" ref={bodyRef}>{children}</div>
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

/** 思考耗时:秒级足够,超过一分钟才进位(思考很少到分钟级,但 adaptive 深思会) */
function fmtThinkDur(ms?: number): string {
  if (ms === undefined) return '';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

/**
 * 思考文本超过这个字数就截断加渐隐,给「展开全文」;避免单段思考顶掉整屏。
 * 用字数而非测 scrollHeight:后者要等布局完成再 setState,会在展开瞬间抖一下。
 * 68ch 宽下约 60 字符/行,1200 字符 ≈ 20 行 ≈ CSS 里的 max-height:320px。
 */
const THINK_CLAMP_CHARS = 1200;

/**
 * 思考卡(方案 B):思考中默认展开逐字流出且不可折叠,thinking-end 后收起为一行 + 耗时,可点开回看。
 * 视觉上刻意全中性(faint/muted)——彩色留给工具卡函数名,思考永远是助手正文之后的第二层级。
 * 文本按空行分段直出,不走 markdown:summarized 返回的是模型自写的英文散文摘要,
 * 没有 markdown 结构可言,流式逐帧解析纯属浪费。
 */
export function ThinkingCard({ text, streaming, durationMs }: { text: string; streaming: boolean; durationMs?: number }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const paras = text.split(/\n{2,}/).filter((p) => p.trim());
  const expanded = streaming || open;
  // 流式中不截断(正看着它想),收起后再展开才限高
  const clamped = !streaming && !full && text.length > THINK_CLAMP_CHARS;
  return (
    <div className={cn('thinkcard', streaming && 'live', !streaming && open && 'open')}>
      <button
        className="tk-head"
        aria-expanded={expanded}
        disabled={streaming}
        onClick={() => setOpen((v) => !v)}
      >
        <svg className="ico" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4.6" stroke="currentColor" strokeWidth="1.1" strokeDasharray="2.3 2.1" />
        </svg>
        <span className="tk-label">思考</span>
        <span className="tk-meta">{streaming ? '进行中' : fmtThinkDur(durationMs)}</span>
        {!streaming && <span className="chev">▾</span>}
      </button>
      <div className={cn('tk-body', clamped && 'clamped')}>
        {paras.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
        {streaming && <span className="caret" />}
        {clamped && (
          <button className="tk-more" onClick={() => setFull(true)}>展开全文</button>
        )}
      </div>
    </div>
  );
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
