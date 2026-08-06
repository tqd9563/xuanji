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

// 生产模式:若前端已构建,由后端直接托管 SPA。
// HTML 入口(URL 固定但内容随构建变)必须 no-cache:否则 Pake 壳/浏览器会缓存旧 HTML,
// 而 vite 每次构建给 JS/CSS 换新 hash,旧 HTML 引用的资源文件名已不存在 → 白屏
// (2026-08-06 反复踩到)。带 hash 的 assets 内容变则文件名变,可放心让客户端长缓存。
const frontendDist = path.join(import.meta.dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  const noCacheHtml = (p: string, c: { header: (k: string, v: string) => void }) => {
    if (p.endsWith('.html')) c.header('Cache-Control', 'no-cache, must-revalidate');
  };
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), frontendDist), onFound: noCacheHtml }));
  app.get(
    '*',
    serveStatic({ path: path.relative(process.cwd(), path.join(frontendDist, 'index.html')), onFound: noCacheHtml }),
  );
}

// 本机监听:恒为 http + 回环。Pake 壳/本机浏览器走这条,不碰自签证书(WKWebView 不认 mkcert rootCA)。
// 必须同时绑 IPv4(127.0.0.1)与 IPv6(::1):WKWebView 把 localhost 优先解析为 ::1,只绑 IPv4
// 会导致壳连不上而白屏(2026-08-06 实际踩到);而 restart.sh / curl 健康检查走 127.0.0.1,两族都要在。
const mode = isAuthEnabled() ? '鉴权开启' : '本机独占(无鉴权)';
for (const host of ['127.0.0.1', '::1']) {
  const srv = serve({ fetch: app.fetch, hostname: host, port: config.port }, (info) => {
    const shown = host === '::1' ? `[${host}]` : host;
    console.log(`[xuanji] 本机 http://${shown}:${info.port}  [${mode}]  (claudeDir: ${config.claudeDir})`);
  });
  // 某些系统禁用了 IPv6,::1 绑不上时只告警不退出——IPv4 那条已足够保证本机可用
  srv.on('error', (e: NodeJS.ErrnoException) => {
    console.error(`[xuanji] 本机 ${host}:${config.port} 绑定失败(${e.code ?? e.message}),已跳过`);
  });
  attachWs(srv as Server, storage);
}

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
