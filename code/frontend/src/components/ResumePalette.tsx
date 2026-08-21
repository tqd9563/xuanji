/**
 * /resume 弹窗:列出当前项目下已关闭(隐藏)的会话,打字过滤 · ↑↓/Tab 选择 · Enter 续接 · Esc 关闭。
 * 数据源 GET /api/sessions/closed?cwd=,选中后由派发页完成 unhide + 续接。
 * 搜索为纯前端过滤(列表打开时已全量在手,不新增后端接口),打分复用 lib/fuzzy 的
 * matchScore——会话名当短名、sessionId 当路径,与 /wd·/model 同一套手感。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/api/client';
import { cn, timeAgo } from '@/lib/utils';
import { hitParts, matchScore } from '@/lib/fuzzy';
import type { ClosedSession } from '@/api/types';

/** 列表里 sessionId 只露前 8 位,匹配口径也只认这 8 位 + 整串前缀(粘贴完整 id 的场景)。
 *  不把完整 uuid 交给 matchScore 的 path 通道:那样命中片段会落在界面根本没显示的中后段
 *  (搜得到却看不出为什么),且 uuid 的子序列匹配假阳性极高(「abc」子序列命中 a1b2c3d4)。 */
export function scoreSession(query: string, name: string, sessionId: string): number | null {
  const q = query.trim();
  if (!q) return 0;
  // path 传空串 = 关掉 matchScore 的路径通道,只按会话名分层(前缀 100 / 中段 80 / 子序列 60)
  const byName = matchScore(q, name, '');
  if (byName !== null) return byName;
  const id = sessionId.toLowerCase();
  const lq = q.toLowerCase();
  return id.slice(0, 8).includes(lq) || id.startsWith(lq) ? 40 : null;
}

/** 命中片段玉色高亮;未连续命中时等价于原样文本 */
function Hit({ text, query }: { text: string; query: string }) {
  const { before, hit, after } = hitParts(text, query);
  if (!hit) return <>{before}</>;
  return (
    <>
      {before}
      <span className="rp-mark">{hit}</span>
      {after}
    </>
  );
}

export function ResumePalette({
  cwd,
  onPick,
  onClose,
}: {
  cwd: string;
  onPick: (s: ClosedSession) => void;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<ClosedSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .closedSessions(cwd)
      .then((r) => setSessions(r.sessions))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [cwd]);

  // 同分保持原顺序 = 保留后端给的 recency(最近关闭在前)
  const filtered = useMemo(() => {
    if (!sessions) return [];
    if (!query.trim()) return sessions;
    return sessions
      .map((s, i) => ({ s, i, score: scoreSession(query, s.name, s.sessionId) }))
      .filter((x): x is { s: ClosedSession; i: number; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.s);
  }, [sessions, query]);

  // query 变化时选中项回到第一条(与 WdPalette 同款)
  useEffect(() => {
    setSel(0);
  }, [query]);

  // 打开即聚焦搜索框:WKWebView(Pake 壳)下唤起弹窗的那次 Enter 仍处理在派发框 textarea 上,
  // 同 tick focus 与 setTimeout(0) 补抢均被真机证实可能失效(见 WdPalette 同处注释),
  // 故轮询重试直到焦点真正落座(50ms×20 上限 ~1s);Chromium 首次即成功、零额外开销。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    let tries = 0;
    const timer = setInterval(() => {
      if (document.activeElement === el || ++tries > 20) {
        clearInterval(timer);
        return;
      }
      el.focus();
    }, 50);
    return () => clearInterval(timer);
  }, []);

  // 键盘导航:capture + stopImmediatePropagation 吃掉整个按键,
  // 不拦截的话 Esc/← 会继续传给派发页的「返回看板」监听(ConfirmHost 同款处理)。
  // 字符键不拦截,照常落进搜索框。
  const stateRef = useRef({ filtered, sel, onPick, onClose });
  stateRef.current = { filtered, sel, onPick, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { filtered, sel, onPick, onClose } = stateRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
        return;
      }
      if (filtered.length === 0) return;
      // Tab / Shift+Tab = 循环切换选中项(与 WdPalette 同款):选中态改玉色描边环后,
      // 放行原生 Tab 会做 DOM 焦点遍历,触发全局 :focus-visible 描边,与 sel 选中环同屏双环
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSel((cur) => {
          const next = e.shiftKey ? (cur - 1 + filtered.length) % filtered.length : (cur + 1) % filtered.length;
          listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
          return next;
        });
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSel((cur) => {
          const next = e.key === 'ArrowDown' ? Math.min(cur + 1, filtered.length - 1) : Math.max(cur - 1, 0);
          listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
          return next;
        });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (filtered[sel]) onPick(filtered[sel]);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  const q = query.trim();
  // 搜索框从加载中就渲染:等列表回来再挂输入框,这段窗口里焦点无处可去、用户抢先打的字直接丢失
  // (真机实测确有此窗口)。只有「加载失败」与「一条已关闭会话都没有」两种终态不给搜索框——
  // 此时它是纯噪音,空态文案已说明去处。
  const searchable = !error && sessions?.length !== 0;
  const hasList = !error && !!sessions?.length;

  return (
    <div className="confirm-mask" onClick={onClose}>
      <div className="rp-box" role="dialog" aria-modal="true" aria-label="恢复已关闭会话" onClick={(e) => e.stopPropagation()}>
        <div className="rp-head">
          恢复已关闭会话
          <span className="rp-hint">↑↓/Tab 选择 · Enter 续接 · Esc 关闭</span>
        </div>
        {searchable && (
          <div className="wd-search">
            <input
              ref={inputRef}
              className="input"
              autoFocus
              aria-label="搜索已关闭会话"
              placeholder="搜索会话名或 id…(如 待办)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        {error && <div className="rp-empty">加载失败:{error}</div>}
        {!error && sessions === null && <div className="rp-empty">加载中…</div>}
        {!error && sessions?.length === 0 && (
          <div className="rp-empty">当前项目没有已关闭的会话(看板 × 关闭的会话会出现在这里)</div>
        )}
        {hasList && filtered.length === 0 && <div className="rp-empty">没有匹配「{q}」的已关闭会话</div>}
        {hasList && filtered.length > 0 && (
          <div className="rp-list" ref={listRef}>
            {filtered.map((s, i) => (
              <button
                key={s.sessionId}
                className={cn('rp-item', i === sel && 'sel')}
                // 退出原生 Tab 序列:选中态只由 sel state 单轨驱动(同 WdPalette)
                tabIndex={-1}
                onMouseEnter={() => setSel(i)}
                onClick={() => onPick(s)}
                title={s.name}
              >
                <span className="rp-name">
                  <Hit text={s.name} query={q} />
                </span>
                <span className="rp-meta mono">
                  <Hit text={s.sessionId.slice(0, 8)} query={q} />
                </span>
                <span className="rp-meta">关闭于 {timeAgo(s.hiddenAt)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
