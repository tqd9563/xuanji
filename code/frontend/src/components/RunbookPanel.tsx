/**
 * 验收面板。结构与 class 名 1:1 对齐获批原型 wiki/design/prototype-runbook.html。
 *
 * 位置:派发页消息区与状态条之间——它是验收阶段的常驻工具,不是一条消息。
 * 色彩:头部紫罗兰(与「待验收」状态色同源),面板内部回到中性,状态色只给状态灯;
 *      拦截态用红(错误/禁止),与「依赖未就绪」的置灰区分——置灰是「还不能」,拦截是「永远不能」。
 */
import { useEffect, useRef, useState } from 'react';
import {
  depsReady,
  paramValue,
  previewCommand,
  type RequestOutcome,
  type RunbookItem,
  type RunbookRun,
  type RunbookRunStatus,
} from '../lib/runbook';

const STATE_TEXT: Record<RunbookRunStatus, string> = {
  running: '执行中…',
  ready: '就绪',
  ok: '完成',
  exited: '已退出',
  failed: '失败',
  stopped: '已停止',
};

function dotClass(status?: RunbookRunStatus): string {
  if (!status) return '';
  if (status === 'running') return 'running';
  if (status === 'ready' || status === 'ok') return 'ready';
  if (status === 'failed') return 'failed';
  return 'exited';
}

/** 折叠输出块:service 的日志、command 的输出、request 的 body/响应共用 */
function OutBlock({ label, text, open }: { label: string; text: string; open?: boolean }) {
  const [expanded, setExpanded] = useState(!!open);
  const preRef = useRef<HTMLPreElement>(null);
  // 日志追加时自动贴底,除非用户自己往上翻过(那说明在看历史,别抢滚动条)
  const stickRef = useRef(true);
  useEffect(() => {
    const pre = preRef.current;
    if (!pre || !expanded || !stickRef.current) return;
    pre.scrollTop = pre.scrollHeight;
  }, [text, expanded]);
  useEffect(() => {
    if (open) setExpanded(true);
  }, [open]);
  if (!text) return null;
  return (
    <div className={`rb-out${expanded ? ' open' : ''}`}>
      <button className="rb-out-head" onClick={() => setExpanded((v) => !v)}>
        <span className="chev">▸</span>
        {label}
      </button>
      <pre
        ref={preRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {text}
      </pre>
    </div>
  );
}

interface ItemProps {
  item: RunbookItem;
  run?: RunbookRun;
  runs: Record<string, RunbookRun>;
  log?: string;
  error?: string;
  items: RunbookItem[];
  onRun: (item: RunbookItem, params: Record<string, string>) => void;
  onStop: (item: RunbookItem) => void;
  onRequest: (item: RunbookItem) => void;
  requestOutcome?: RequestOutcome;
}

function ItemRow({ item, run, runs, log, error, items, onRun, onStop, onRequest, requestOutcome }: ItemProps) {
  const [edited, setEdited] = useState<Record<string, string>>({});
  const ready = depsReady(item, runs);
  const blocked = !!item.blockedReason;
  const status = run?.status;
  const busy = status === 'running';
  const waiting = !ready && !status;

  const params: Record<string, string> = {};
  for (const p of item.params ?? []) params[p.key] = paramValue(p, edited);

  const depTitle = (item.dependsOn ?? [])
    .map((id) => items.find((i) => i.id === id)?.title ?? id)
    .join('、');

  const stateText = blocked
    ? '黑名单拦截'
    : waiting
      ? `等待 ${depTitle}`
      : status
        ? STATE_TEXT[status] + (status === 'ok' && run?.exitCode === 0 && item.type !== 'request' ? ' · exit 0' : '')
        : item.type === 'service'
          ? '未启动'
          : '';

  if (item.type === 'cleanup') {
    return (
      <div className="rb-item cleanup">
        <span className="rb-title">{item.title}</span>
        <span className="rb-cmd" title={item.command}>
          {previewCommand(item)}
        </span>
        <span className="auto-note">验收通过 / 归档时自动执行</span>
        <span className="rb-actions">
          <button className="btn btn-sm" disabled={blocked || busy} onClick={() => onRun(item, params)}>
            {busy ? '执行中…' : '执行'}
          </button>
        </span>
      </div>
    );
  }

  if (item.type === 'link') {
    return (
      <div className="rb-item">
        <div className="rb-row">
          <span className="rb-dot ready" />
          <span className="rb-title">{item.title}</span>
        </div>
        <div className="rb-links">
          <a href={item.url} target="_blank" rel="noreferrer">
            ↗ {item.url}
          </a>
        </div>
      </div>
    );
  }

  const isRequest = item.type === 'request';

  return (
    <div className={`rb-item${waiting ? ' dep-wait' : ''}`}>
      <div className="rb-row">
        <span className={`rb-dot ${blocked ? 'failed' : dotClass(status)}`} />
        {isRequest && <span className="rb-method">{item.method ?? 'GET'}</span>}
        <span className="rb-title">{item.title}</span>
        {item.origin === 'session' && (
          <span className="rb-origin" title="本次会话生成,未经模板入库;首次执行需确认">
            会话生成
          </span>
        )}
        <span className={`rb-state ${blocked ? 'failed' : (status ?? '')}`}>{stateText}</span>
        <span className="rb-actions">
          {blocked ? (
            <button className="btn btn-sm" disabled title={item.blockedReason}>
              已拦截
            </button>
          ) : item.type === 'service' && (status === 'ready' || status === 'running') ? (
            <button className="btn btn-sm btn-danger" onClick={() => onStop(item)}>
              停止
            </button>
          ) : (
            <button
              className="btn btn-sm"
              disabled={waiting || busy}
              onClick={() => (isRequest ? onRequest(item) : onRun(item, params))}
            >
              {busy ? '执行中…' : isRequest ? (status ? '重新发送' : '发送') : item.type === 'service' ? (status === 'exited' || status === 'stopped' ? '重新启动' : '启动') : status ? '再次执行' : '执行'}
            </button>
          )}
        </span>
      </div>

      {isRequest ? (
        <>
          <div className="rb-cmd" title={item.url}>
            {item.url}
          </div>
          {item.body && <OutBlock label="请求 body" text={item.body} />}
          {item.expect && (
            <div className="rb-expect">
              <b>预期:</b>
              {item.expect}
            </div>
          )}
          {requestOutcome?.ok && (
            <div className="rb-resp-meta">
              <span className="code-ok">{requestOutcome.status}</span> · {requestOutcome.durationMs} ms
            </div>
          )}
          {requestOutcome?.body && <OutBlock label="响应" text={requestOutcome.body} open />}
        </>
      ) : (
        <>
          <div className="rb-cmd">{previewCommand(item, edited)}</div>
          {!!item.params?.length && (
            <div className="rb-params">
              {item.params.map((p) =>
                p.type === 'boolean' ? (
                  <span className="rb-param" key={p.key}>
                    <input
                      type="checkbox"
                      id={`p-${item.id}-${p.key}`}
                      checked={paramValue(p, edited) === 'true'}
                      onChange={(e) => setEdited((v) => ({ ...v, [p.key]: e.target.checked ? 'true' : 'false' }))}
                    />
                    <label htmlFor={`p-${item.id}-${p.key}`}>{p.label}</label>
                  </span>
                ) : p.type === 'enum' ? (
                  <span className="rb-param" key={p.key}>
                    <label htmlFor={`p-${item.id}-${p.key}`}>
                      {p.label}
                      {p.required && <span className="req"> *</span>}
                    </label>
                    <select
                      className="input"
                      id={`p-${item.id}-${p.key}`}
                      value={paramValue(p, edited)}
                      onChange={(e) => setEdited((v) => ({ ...v, [p.key]: e.target.value }))}
                    >
                      {(p.options ?? []).map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  </span>
                ) : (
                  <span className="rb-param" key={p.key}>
                    <label htmlFor={`p-${item.id}-${p.key}`}>
                      {p.label}
                      {p.required && <span className="req"> *</span>}
                    </label>
                    <input
                      className="input"
                      type={p.type === 'date' ? 'date' : p.type === 'number' ? 'number' : 'text'}
                      id={`p-${item.id}-${p.key}`}
                      value={paramValue(p, edited)}
                      onChange={(e) => setEdited((v) => ({ ...v, [p.key]: e.target.value }))}
                    />
                  </span>
                ),
              )}
            </div>
          )}
          {blocked && <div className="rb-blocked">⛔ {item.blockedReason}</div>}
          {!!item.links?.length && (
            <div className={`rb-links${status === 'ready' ? '' : ' off'}`}>
              {item.links.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noreferrer">
                  ↗ {l.title} <span style={{ color: 'var(--faint)' }}>{l.url}</span>
                </a>
              ))}
            </div>
          )}
          <OutBlock label={item.type === 'service' ? '日志' : '输出'} text={log ?? ''} open={!!log} />
        </>
      )}
      {error && <div className="rb-blocked">⛔ {error}</div>}
    </div>
  );
}

export interface RunbookPanelProps {
  runbook: import('../lib/runbook').ResolvedRunbook;
  runs: Record<string, RunbookRun>;
  logs: Record<string, string>;
  errors: Record<string, string>;
  onRun: (item: RunbookItem, params: Record<string, string>, confirmed: boolean) => void;
  onStop: (item: RunbookItem) => void;
  onRequest: (item: RunbookItem, confirmed: boolean) => Promise<RequestOutcome>;
}

export function RunbookPanel({ runbook, runs, logs, errors, onRun, onStop, onRequest }: RunbookPanelProps) {
  const [open, setOpen] = useState(true);
  const [outcomes, setOutcomes] = useState<Record<string, RequestOutcome>>({});
  /** 已确认过的会话生成项:同一会话内二次执行免确认(§6.1) */
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<{ item: RunbookItem; params: Record<string, string>; isRequest: boolean } | null>(
    null,
  );

  const liveCount = runbook.items.filter((i) => i.type === 'service' && runs[i.id]?.status === 'ready').length;

  const needsConfirm = (item: RunbookItem) => item.origin === 'session' && !confirmedIds.has(item.id);

  const doRun = (item: RunbookItem, params: Record<string, string>) => {
    if (needsConfirm(item)) return setPending({ item, params, isRequest: false });
    onRun(item, params, item.origin === 'session');
  };

  const doRequest = (item: RunbookItem) => {
    if (needsConfirm(item)) return setPending({ item, params: {}, isRequest: true });
    void onRequest(item, item.origin === 'session').then((r) => setOutcomes((v) => ({ ...v, [item.id]: r })));
  };

  const confirmPending = () => {
    if (!pending) return;
    const { item, params, isRequest } = pending;
    setConfirmedIds((s) => new Set(s).add(item.id));
    setPending(null);
    if (isRequest) void onRequest(item, true).then((r) => setOutcomes((v) => ({ ...v, [item.id]: r })));
    else onRun(item, params, true);
  };

  // Esc 关闭确认层(与全局「Esc 逐层退出」一致)
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPending(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pending]);

  return (
    <>
      <div className={`runbook${open ? ' open' : ''}`}>
        <button className="rb-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="rb-label">验收面板</span>
          {runbook.templateName && (
            <span className="rb-tpl">
              {runbook.templateName}
              {runbook.templateVersion ? ` v${runbook.templateVersion}` : ''}
            </span>
          )}
          <span className="rb-sum">
            {liveCount ? <span className="on">● {liveCount} 个环境运行中</span> : '环境未启动'}
          </span>
          <span className="chev">▾</span>
        </button>
        <div className="rb-body">
          {runbook.notes && <div className="rb-notes">验收要点:{runbook.notes}</div>}
          {runbook.items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              items={runbook.items}
              run={runs[item.id]}
              runs={runs}
              log={logs[item.id]}
              error={errors[item.id]}
              onRun={doRun}
              onStop={onStop}
              onRequest={doRequest}
              requestOutcome={outcomes[item.id]}
            />
          ))}
        </div>
      </div>

      {pending && (
        <div className="confirm-mask" onClick={(e) => e.target === e.currentTarget && setPending(null)}>
          <div className="confirm-box" role="dialog" aria-modal="true">
            <div className="c-title">
              <span className="rb-origin">会话生成</span>确认执行
            </div>
            <div className="c-sub">
              这一项由本次派发会话生成、未经模板入库,首次执行前请核对完整内容;同一会话内再次执行不再确认。
            </div>
            <div className="cmd-block">
              {pending.isRequest
                ? `${pending.item.method ?? 'GET'} ${pending.item.url ?? ''}${pending.item.body ? `\n\n${pending.item.body}` : ''}`
                : previewCommand(pending.item, pending.params)}
            </div>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setPending(null)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={confirmPending}>
                确认执行
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
