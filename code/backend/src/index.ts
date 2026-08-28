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
import { refreshSkillUsage } from './services/skill-usage.js';

const storage = new Storage(config.dataDir);
const scheduler = new SchedulerService(storage);
scheduler.init(); // 重启不丢任务:重新加载全部 pending/blocked 任务并注册 croner 触发器

// 技能触发索引预热:冷库首扫要读近百万行 jsonl(实测 ~5s),放后台跑,
// 让第一次打开技能页就有数;失败不影响启动,下次请求会再触发增量扫描。
void refreshSkillUsage(storage).catch((e) => console.error('[xuanji] skill usage scan failed:', e));

const app = new Hono();

app.route('/api', createApi(storage, scheduler));

// 生产模式:若前端已构建,由后端直接托管 SPA。
// HTML 入口(URL 固定但内容随构建变)必须 no-cache:否则 Pake 壳的 WKWebView 会一直用缓存里的
// 旧 HTML,而 vite 每次构建给 JS/CSS 换新 hash,旧 HTML 连同旧包一起从缓存跑起来——界面看着正常,
// 新改动却怎么都不生效(2026-08-11 实际踩到)。带 hash 的 assets 内容变则文件名变,可放心长缓存。
const frontendDist = path.join(import.meta.dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  const noCacheHtml = (p: string, c: { header: (k: string, v: string) => void }) => {
    if (p.endsWith('.html')) c.header('Cache-Control', 'no-cache, must-revalidate');
  };
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), frontendDist), onFound: noCacheHtml }));
  // SPA 兜底只给前端路由,不给 /assets/:构建换 hash 后旧包路径若也回 index.html,
  // 客户端会拿到 200 + text/html 冒充 JS,报错含糊难查;直接 404 才能一眼看出是缓存过期。
  app.get('/assets/*', (c) => c.notFound());
  app.get(
    '*',
    serveStatic({ path: path.relative(process.cwd(), path.join(frontendDist, 'index.html')), onFound: noCacheHtml }),
  );
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`[xuanji] listening on http://${config.host}:${info.port}  (claudeDir: ${config.claudeDir})`);
});

attachWs(server as Server, storage);
