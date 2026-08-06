import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createHttpsServer } from 'node:https';
import type { Server } from 'node:http';
import { assertConfigSafe, config } from './config.js';
import { createApi } from './api/routes.js';
import { attachWs } from './ws.js';
import { createAuthMiddleware, isAuthEnabled } from './auth.js';
import { Storage } from './storage/db.js';
import { SchedulerService } from './services/scheduler.js';

// 绑非回环地址却缺鉴权/TLS 配置时直接拒绝启动,不给「以为开了远程其实在裸奔」的机会
const configErrors = assertConfigSafe();
if (configErrors.length) {
  for (const e of configErrors) console.error(`[xuanji] 配置错误:${e}`);
  process.exit(1);
}

const storage = new Storage(config.dataDir);
const scheduler = new SchedulerService(storage);
scheduler.init(); // 重启不丢任务:重新加载全部 pending/blocked 任务并注册 croner 触发器

const app = new Hono();

app.use('/api/*', createAuthMiddleware(storage));
app.route('/api', createApi(storage, scheduler));

// 生产模式:若前端已构建,由后端直接托管 SPA
const frontendDist = path.join(import.meta.dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), frontendDist) }));
  app.get('*', serveStatic({ path: path.relative(process.cwd(), path.join(frontendDist, 'index.html')) }));
}

// 本机监听:恒为 http + 回环。Pake 壳/本机浏览器走这条,不碰自签证书(WKWebView 不认 mkcert rootCA)
const localServer = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  const mode = isAuthEnabled() ? '鉴权开启' : '本机独占(无鉴权)';
  console.log(`[xuanji] 本机 http://${config.host}:${info.port}  [${mode}]  (claudeDir: ${config.claudeDir})`);
});
attachWs(localServer as Server, storage);

// 远程监听:仅在口令 + 证书齐备时启动,面向办公网,强制 https
if (config.remote.enabled && config.tls) {
  const tlsOptions = { key: fs.readFileSync(config.tls.key), cert: fs.readFileSync(config.tls.cert) };
  const remoteServer = serve(
    {
      fetch: app.fetch,
      hostname: config.remote.host,
      port: config.remote.port,
      createServer: createHttpsServer,
      serverOptions: tlsOptions,
    },
    (info) => console.log(`[xuanji] 远程 https://${config.remote.host}:${info.port}  [鉴权开启]`),
  );
  attachWs(remoteServer as Server, storage);
}
