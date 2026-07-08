/**
 * WebSocket 推送:chokidar 浅层监听 ~/.claude 关键路径,变更去抖后广播
 * {type:'changed', scope} —— 前端据此重取。M2 在此扩展对话双向流。
 */
import type { Server } from 'node:http';
import path from 'node:path';
import chokidar from 'chokidar';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config.js';
import { invalidateMemoryCache } from './services/memories.js';
import { invalidateSkillsCache } from './services/skills.js';
import { invalidateUsageCache } from './services/usage.js';

export function attachWs(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  const broadcast = (msg: object) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
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

  return wss;
}
