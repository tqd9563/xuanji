/**
 * WebSocket 两条通道:
 * - /ws          变更推送(chokidar → {type:'changed', scope})
 * - /ws/dispatch 派发双向流(每个派发页一条连接;client op → 服务,DispatchEvent → 前端)
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import chokidar from 'chokidar';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config.js';
import { invalidateMemoryCache } from './services/memories.js';
import { invalidateSkillsCache } from './services/skills.js';
import { invalidateUsageCache } from './services/usage.js';
import { canResume, createDispatch, getDispatch, type DispatchSession } from './services/dispatch.js';
import { bgDispatch } from './adapters/agents-cli.js';
import type { Storage } from './storage/db.js';

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

    const send = (obj: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    const attach = (s: DispatchSession, replayEvents: boolean) => {
      session = s;
      unsubscribe?.();
      if (replayEvents) for (const e of s.events) send(e);
      unsubscribe = s.subscribe(send);
      send({ ev: 'attached', dispatchId: s.id });
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
              if (typeof msg.cwd !== 'string' || typeof msg.prompt !== 'string' || !msg.prompt.trim()) {
                return send({ ev: 'error', message: 'start 需要 cwd 与 prompt' });
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
                resume: msg.resume || undefined,
                fork,
                name: msg.name || undefined,
              });
              attach(s, false);
              s.send(msg.prompt);
              break;
            }
            case 'attach': {
              const s = getDispatch(String(msg.dispatchId ?? ''));
              if (!s) return send({ ev: 'error', message: '派发会话不存在或已结束' });
              attach(s, true);
              break;
            }
            case 'send':
              if (!session) return send({ ev: 'error', message: '尚未开始会话' });
              if (typeof msg.text === 'string' && msg.text.trim()) session.send(msg.text);
              break;
            case 'permission':
              session?.resolvePermission(String(msg.requestId), msg.decision);
              break;
            case 'interrupt':
              await session?.interrupt();
              break;
            case 'bg': {
              if (typeof msg.cwd !== 'string' || typeof msg.prompt !== 'string') {
                return send({ ev: 'error', message: 'bg 需要 cwd 与 prompt' });
              }
              const r = await bgDispatch(msg.cwd, msg.prompt);
              send({ ev: 'bg-dispatched', ok: r.ok, output: r.output });
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
      // 会话不随连接关闭而终止:刷新页面可 attach 回来;闲置会话由进程生命周期管理
    });
  });

  return { changesWss, dispatchWss };
}
