import { useEffect, useMemo, useRef, useState } from 'react';
import type { SideQuestion } from '@/api/types';
import type { BtwState } from '@/lib/dispatch';
import { isTypingTarget } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { Md } from '@/components/shared';

/**
 * 旁路提问面板(右侧停靠,原型 prototype-btw.html 形态 A)。
 *
 * 三种视图:单条(默认,停在最新一条)/ 记录列表 / 空态;三种单条状态:提问中 / 已答 / 失败。
 * 记录由父级(useDispatch.btw)持有——答案落库即存,面板只是窗口,关掉再开不丢。
 * 键盘:⇧← / ⇧→ 翻记录、Esc 关(提问中 = 取消);焦点在输入控件里时不抢键。
 */
export interface BtwPanelProps {
  state: BtwState;
  /** 当前会话的工作目录:「存为经验」落到这个项目的 memory 目录 */
  cwd: string | null;
  /** 主对话是否空闲:「钉入主对话」只有此时可用(否则会插队打断正在跑的回合) */
  mainIdle: boolean;
  onClose: () => void;
  onCancel: () => void;
  onRetry: (question: string) => void;
  /** 把问题原样放回输入框、关面板 */
  onToMain: (question: string) => void;
  onPin: (record: SideQuestion) => void;
  onMemory: (record: SideQuestion) => Promise<void>;
}

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const plain = (md: string) => md.replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim();

export function BtwPanel({ state, cwd, mainIdle, onClose, onCancel, onRetry, onToMain, onPin, onMemory }: BtwPanelProps) {
  const { records, inFlight, error } = state;
  const [view, setView] = useState<'one' | 'hist'>('one');
  // 停在哪一条:null = 跟随最新(新答案到达自动跳过去);用户翻页后钉住
  const [pinned, setPinned] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const idx = pinned ?? records.length - 1;
  const cur: SideQuestion | null = records[idx] ?? null;
  // 新答案来了 → 回到跟随态(与 CLI 面板「回到 live 答案」一致)
  useEffect(() => {
    setPinned(null);
  }, [records.length]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = records.map((r, i) => ({ r, i }));
    return (needle ? list.filter(({ r }) => (r.question + r.answer).toLowerCase().includes(needle)) : list).reverse();
  }, [records, q]);

  const step = (delta: number) => {
    if (!records.length) return;
    setPinned(Math.min(records.length - 1, Math.max(0, idx + delta)));
    setView('one');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isTypingTarget(e.target) && e.target !== searchRef.current) return;
        e.preventDefault();
        if (inFlight) onCancel();
        else if (view === 'hist') setView('one');
        else onClose();
        return;
      }
      if (isTypingTarget(e.target)) return;
      if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        step(e.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  useEffect(() => {
    if (view === 'hist') searchRef.current?.focus();
  }, [view]);

  const showing: 'ask' | 'err' | 'done' | 'empty' = inFlight ? 'ask' : error ? 'err' : cur ? 'done' : 'empty';
  const headQ = inFlight?.question ?? error?.question ?? cur?.question ?? '';
  const headT = inFlight ? fmtTime(inFlight.startedAt) : cur ? fmtTime(cur.createdAt) : '';

  return (
    <aside className="btw" aria-label="旁路提问">
      <div className="btw-head">
        <span className="btw-title">旁路提问</span>
        <span className="btw-note">答案不进主对话</span>
        <span className="spacer" />
        {records.length > 0 && showing !== 'ask' && (
          <span className="btw-nav">
            <button className="th-btn" onClick={() => step(-1)} disabled={idx <= 0} title="上一条 ⇧←" aria-label="上一条">←</button>
            <span className="th-pos">{idx + 1}/{records.length}</span>
            <button className="th-btn" onClick={() => step(1)} disabled={idx >= records.length - 1} title="下一条 ⇧→" aria-label="下一条">→</button>
          </span>
        )}
        <button className="th-btn" onClick={() => setView(view === 'hist' ? 'one' : 'hist')} title="旁路记录" aria-label="旁路记录" aria-pressed={view === 'hist'}>≡</button>
        <button className="th-btn" onClick={onClose} title="关闭 Esc" aria-label="关闭">×</button>
      </div>
      <div className="btw-route">直连 · 复用主会话句柄,共享上下文缓存</div>

      {view === 'hist' ? (
        <div className="btw-hist">
          <div className="wd-search">
            <input ref={searchRef} className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜本会话的旁路记录…" aria-label="搜索旁路记录" />
          </div>
          <div className="rp-list" role="listbox">
            {rows.length === 0 && (
              <div className="rp-empty">{records.length ? `没有匹配「${q.trim()}」的旁路记录` : '这个会话还没有旁路记录'}</div>
            )}
            {rows.map(({ r, i }) => (
              <button
                key={r.id}
                type="button"
                role="option"
                aria-selected={i === idx}
                className={cn('rp-item', i === idx && 'sel')}
                onClick={() => {
                  setPinned(i);
                  setView('one');
                }}
              >
                <span className="btw-h-q">
                  {r.question}
                  <span className="btw-h-a">{plain(r.answer)}</span>
                </span>
                {r.memoryFile && <span className="btw-h-mem">经验</span>}
                <span className="btw-h-t">{fmtTime(r.createdAt)}</span>
              </button>
            ))}
          </div>
          <div className="to-foot">
            <span>{records.length} 条 · 存在璇玑自有库,不写 ~/.claude</span>
            <span className="spacer" />
            <kbd>⇧←</kbd><kbd>⇧→</kbd><span>不开列表也能翻</span>
          </div>
        </div>
      ) : showing === 'empty' ? (
        <div className="btw-empty">
          <p>这里回答「顺便问一句」:拿着主对话的全部上下文作答,但答案<b>不进主对话</b>,不占它的 context,也不打断它正在跑的活。</p>
          <p>在输入框里以 <code>/btw</code> 开头提问。答案一回来就自动存进这个会话的旁路记录,关掉面板也不会丢;再按快捷键或点状态条的「旁路 N」随时翻回来。</p>
        </div>
      ) : (
        <div className="btw-one">
          <div className="btw-q">
            <span className="btw-cmd">/btw</span>
            <span className="btw-qtext">{headQ}</span>
            {headT && <span className="btw-ts">{headT}</span>}
          </div>
          {showing === 'ask' && (
            <div className="btw-wait" role="status">
              <div className="btw-skel"><i /><i /><i /></div>
              <div className="btw-wait-line">
                <span className="cs-dot think" />回答中 · 主对话未打断,仍在继续
                <span className="spacer" />
                <button className="btn btn-sm" onClick={onCancel}>取消 Esc</button>
              </div>
            </div>
          )}
          {showing === 'err' && error && (
            <div className="btw-err" role="alert">
              <b>{error.message === '已取消' ? '已取消。' : '没答上来。'}</b>
              {error.message === '已取消' ? '这一问没有留下记录。' : error.message}
              <div className="btw-err-act">
                <button className="btn btn-sm" onClick={() => onRetry(error.question)}>重问</button>
                <button className="btn btn-sm" onClick={() => onToMain(error.question)}>改到主对话问</button>
              </div>
            </div>
          )}
          {showing === 'done' && cur && (
            <>
              <div className="btw-a">
                {cur.synthetic && <div className="btw-synth">模型没有直接作答,以下是 SDK 的合成答复</div>}
                <Md>{cur.answer}</Md>
              </div>
              <div className="btw-foot">
                <span className="btw-saved">
                  <span className="btw-ok" />
                  {cur.memoryFile ? '已存 · 已沉为经验' : '已存 · 旁路记录'}
                </span>
                <span className="spacer" />
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(`${cur.question}\n\n${cur.answer}`);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}
                >
                  {copied ? '已复制' : '复制'}
                </button>
                <button
                  className="btn btn-sm"
                  disabled={!!cur.memoryFile || saving || !cwd}
                  title={cwd ? '写成本项目的一条 reference memory(会写 ~/.claude,需确认)' : '会话工作目录未知'}
                  onClick={() => {
                    if (!window.confirm(`把这一问一答写成「${cwd}」项目的 memory?\n会在 ~/.claude 下新建一个 md 文件并追加索引,不覆盖已有文件。`)) return;
                    setSaving(true);
                    void onMemory(cur).finally(() => setSaving(false));
                  }}
                >
                  {cur.memoryFile ? '已存为经验' : saving ? '写入中…' : '存为经验'}
                </button>
                <button
                  className="btn btn-sm"
                  disabled={!mainIdle}
                  title={mainIdle ? '把这一问一答作为你的下一条消息发进主对话' : '主对话正在跑,回合结束后才能钉入'}
                  onClick={() => onPin(cur)}
                >
                  钉入主对话
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
