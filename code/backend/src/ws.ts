/**
 * WebSocket 两条通道:
 * - /ws          变更推送(chokidar → {type:'changed', scope})
 * - /ws/dispatch 派发双向流(每个派发页一条连接;client op → 服务,DispatchEvent → 前端)
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config.js';
import { invalidateMemoryCache } from './services/memories.js';
import { invalidateSkillsCache } from './services/skills.js';
import { invalidateUsageCache } from './services/usage.js';
import { canResume, createDispatch, getDispatch, parseEffort, type DispatchSession } from './services/dispatch.js';
import { bgDispatch } from './adapters/agents-cli.js';
import type { Storage } from './storage/db.js';
import { parseInlineImages } from './types.js';
import { replayRunbookLogs, resolveRunbook, runItem, stopItem, subscribeRunbook } from './services/runbook.js';

export function attachWs(server: Server, storage: Storage) {
  const changesWss = new WebSocketServer({ noServer: true });
  const dispatchWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname === '/ws') {
      changesWss.handleUpgrade(req, socket, head, (ws) => changesWss.emit('connection', ws, req));
    } else if (pathname === '/ws/dispatch') {
      dispatchWss.handleUpgrade(req, socket, head, (ws) => dispatchWss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  // ---------- 变更推送 ----------

  const broadcast = (msg: object) => {
    const data = JSON.stringify(msg);
    for (const client of changesWss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };

  const timers = new Map<string, NodeJS.Timeout>();
  const notify = (scope: string) => {
    clearTimeout(timers.get(scope));
    timers.set(
      scope,
      setTimeout(() => {
        if (scope === 'skills') invalidateSkillsCache();
        if (scope === 'memories') invalidateMemoryCache();
        if (scope === 'history') invalidateUsageCache();
        broadcast({ type: 'changed', scope, at: Date.now() });
      }, 500),
    );
  };

  const watch = (target: string, scope: string, depth: number) => {
    chokidar
      .watch(target, { ignoreInitial: true, depth, persistent: true })
      .on('all', () => notify(scope))
      .on('error', () => {/* watch 失败静默,前端有轮询兜底 */});
  };

  watch(path.join(config.claudeDir, 'history.jsonl'), 'history', 0);
  watch(path.join(config.claudeDir, 'skills'), 'skills', 1);
  watch(path.join(config.claudeDir, 'skills-disabled'), 'skills', 1);
  watch(path.join(config.claudeDir, 'jobs'), 'jobs', 1);

  // ---------- 派发通道 ----------

  dispatchWss.on('connection', (ws) => {
    let session: DispatchSession | null = null;
    let unsubscribe: (() => void) | null = null;
    // 验收面板的订阅独立于派发会话:面板要在会话早已结束(review 态)时照样能用,
    // 而 attach 依赖内存里活着的 DispatchSession。两者按 sessionId 各自订阅,互不牵连。
    let rbUnsubscribe: (() => void) | null = null;

    const send = (obj: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    const attach = (s: DispatchSession, replayEvents: boolean) => {
      session = s;
      unsubscribe?.();
      if (replayEvents) for (const e of s.events) send(e);
      unsubscribe = s.subscribe(send);
      // 接回(replayEvents)时附带垫历史元信息:内存事件只覆盖本进程生命周期,
      // startedAt 之前的对话要由前端从会话 jsonl 回放补齐;全新 start 无更早历史,不带
      const histSid = s.sessionId ?? s.resumeFrom;
      send(
        replayEvents && histSid
          ? { ev: 'attached', dispatchId: s.id, historySessionId: histSid, historyBefore: s.startedAt }
          : { ev: 'attached', dispatchId: s.id },
      );
    };

    ws.on('message', (raw) => {
      void (async () => {
        let msg: any;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return send({ ev: 'error', message: 'bad message' });
        }
        try {
          switch (msg.op) {
            case 'start': {
              const startImgs = parseInlineImages(msg.images);
              if (!startImgs.ok) return send({ ev: 'error', message: startImgs.reason });
              // 带图时允许 prompt 为空:一张截图本身就是完整的诉求
              const hasStartPrompt = typeof msg.prompt === 'string' && (msg.prompt.trim() || startImgs.images.length);
              if (typeof msg.cwd !== 'string' || !hasStartPrompt) {
                return send({ ev: 'error', message: 'start 需要 cwd 与 prompt' });
              }
              // 不存在的 cwd 会让 SDK spawn ENOENT,报错极具误导性("原生二进制启动失败"),前置拦截
              if (!fs.existsSync(msg.cwd)) {
                return send({ ev: 'error', message: `工作目录不存在:${msg.cwd}` });
              }
              let fork = false;
              if (msg.resume) {
                const check = await canResume(String(msg.resume));
                if (!check.ok) return send({ ev: 'error', message: check.reason! });
                fork = check.fork ?? false;
              }
              const s = createDispatch(storage, {
                cwd: msg.cwd,
                permissionMode: msg.permissionMode,
                model: msg.model || undefined,
                effort: parseEffort(msg.effort),
                resume: msg.resume || undefined,
                fork,
                name: msg.name || undefined,
              });
              attach(s, false);
              s.send(msg.prompt, startImgs.images);
              break;
            }
            case 'attach': {
              const s = getDispatch(String(msg.dispatchId ?? ''));
              if (!s) return send({ ev: 'error', message: '派发会话不存在或已结束' });
              attach(s, true);
              break;
            }
            case 'send': {
              if (!session) return send({ ev: 'error', message: '尚未开始会话' });
              const imgs = parseInlineImages(msg.images);
              if (!imgs.ok) return send({ ev: 'error', message: imgs.reason });
              // 只带图不带字也算一条有效消息
              if (typeof msg.text === 'string' && (msg.text.trim() || imgs.images.length)) {
                session.send(msg.text, imgs.images);
              }
              break;
            }
            case 'permission':
              session?.resolvePermission(String(msg.requestId), msg.decision);
              break;
            case 'answer':
              if (msg.answers && typeof msg.answers === 'object') {
                session?.resolveQuestion(String(msg.requestId), msg.answers as Record<string, string>);
              }
              break;
            case 'interrupt':
              await session?.interrupt();
              break;
            case 'model':
              if (!session) return send({ ev: 'error', message: '尚未开始会话' });
              if (typeof msg.model === 'string' && msg.model) await session.changeModel(msg.model);
              break;
            case 'bg': {
              if (typeof msg.cwd !== 'string' || typeof msg.prompt !== 'string') {
                return send({ ev: 'error', message: 'bg 需要 cwd 与 prompt' });
              }
              const r = await bgDispatch(msg.cwd, msg.prompt);
              send({ ev: 'bg-dispatched', ok: r.ok, output: r.output });
              break;
            }
            // ---------- 验收面板 ----------
            case 'rb-watch': {
              // 订阅某会话的面板事件并回放仍在跑的进程的日志尾巴(刷新页面不丢上下文)
              const sid = String(msg.sessionId ?? '');
              if (!sid) return send({ ev: 'rb-error', message: 'rb-watch 需要 sessionId' });
              rbUnsubscribe?.();
              rbUnsubscribe = subscribeRunbook(sid, send);
              replayRunbookLogs(sid, send);
              break;
            }
            case 'rb-run': {
              const sid = String(msg.sessionId ?? '');
              const itemId = String(msg.itemId ?? '');
              const cwd = String(msg.cwd ?? '');
              if (!sid || !itemId || !cwd) {
                return send({ ev: 'rb-error', message: 'rb-run 需要 sessionId / itemId / cwd' });
              }
              // 清单每次现读:worktree 里的文件可能被返工的会话改过,不吃缓存
              const rb = resolveRunbook(storage, sid, cwd);
              const item = rb?.items.find((i) => i.id === itemId);
              if (!item) return send({ ev: 'rb-error', sessionId: sid, itemId, message: '清单项不存在' });
              const params = (msg.params ?? {}) as Record<string, string>;
              const r = runItem({ storage, sessionId: sid, cwd, item, params, confirmed: !!msg.confirmed });
              if (!r.ok) send({ ev: 'rb-error', sessionId: sid, itemId, message: r.reason ?? '执行失败' });
              break;
            }
            case 'rb-stop': {
              const sid = String(msg.sessionId ?? '');
              const itemId = String(msg.itemId ?? '');
              const r = stopItem(storage, sid, itemId);
              if (!r.ok) send({ ev: 'rb-error', sessionId: sid, itemId, message: r.reason ?? '停止失败' });
              break;
            }
            default:
              send({ ev: 'error', message: `unknown op ${msg.op}` });
          }
        } catch (e) {
          send({ ev: 'error', message: e instanceof Error ? e.message : String(e) });
        }
      })();
    });

    ws.on('close', () => {
      unsubscribe?.();
      rbUnsubscribe?.();
      // 面板起的进程不随连接关闭而终止:它们的生命周期跟会话处置走(归档时统一收尾),
      // 否则关个标签页就把正在验收的 dev server 杀了
      // 会话不随连接关闭而终止:刷新页面可 attach 回来;闲置会话由进程生命周期管理
    });
  });

  return { changesWss, dispatchWss };
}
