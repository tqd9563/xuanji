import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { config } from './config.js';
import { createApi } from './api/routes.js';
import { attachWs } from './ws.js';
import { Storage } from './storage/db.js';
import { SchedulerService } from './services/scheduler.js';

const storage = new Storage(config.dataDir);
const scheduler = new SchedulerService(storage);
scheduler.init(); // 重启不丢任务:重新加载全部 pending/blocked 任务并注册 croner 触发器

const app = new Hono();

app.route('/api', createApi(storage, scheduler));

// 生产模式:若前端已构建,由后端直接托管 SPA
const frontendDist = path.join(import.meta.dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), frontendDist) }));
  app.get('*', serveStatic({ path: path.relative(process.cwd(), path.join(frontendDist, 'index.html')) }));
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`[xuanji] listening on http://${config.host}:${info.port}  (claudeDir: ${config.claudeDir})`);
});

attachWs(server as Server, storage);
