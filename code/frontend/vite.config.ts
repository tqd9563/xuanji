import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import pkg from './package.json' with { type: 'json' };

// 后端端口默认 7777(launchd 常驻实例);验证改动时常需另起一个后端并存——
// 尤其派发会话内不允许重启宿主后端,只能靠 XUANJI_PORT 指到第二个实例上。
const BACKEND_PORT = process.env.XUANJI_PORT ?? '7777';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 界面上的版本号一律取自 package.json,不在组件里硬编码
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    port: Number(process.env.XUANJI_WEB_PORT ?? 5173),
    // 端口被占时宁可起不来也不静默顺延:preview.sh 打印的验收地址必须就是实际监听的端口,
    // 否则用户会对着别的 worktree 的旧实例验收(2026-08-05 实际发生)。
    strictPort: Boolean(process.env.XUANJI_WEB_PORT),
    proxy: {
      '/api': `http://127.0.0.1:${BACKEND_PORT}`,
      '/ws': { target: `ws://127.0.0.1:${BACKEND_PORT}`, ws: true },
      // 看板娘模型由后端从 ~/.xuanji/live2d 读。漏了这条的话 dev 下会落到
      // vite 的 SPA 兜底,模型请求拿到 200 + index.html,报错是含糊的
      // 「Failed to load resource as json (Status 200)」——生产模式由后端
      // 自己托管所以看不出来,只在开发时坏。
      '/live2d': `http://127.0.0.1:${BACKEND_PORT}`,
    },
  },
});
