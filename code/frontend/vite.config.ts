import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// 后端端口默认 7777(launchd 常驻实例);验证改动时常需另起一个后端并存——
// 尤其派发会话内不允许重启宿主后端,只能靠 XUANJI_PORT 指到第二个实例上。
const BACKEND_PORT = process.env.XUANJI_PORT ?? '7777';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    port: Number(process.env.XUANJI_WEB_PORT ?? 5173),
    proxy: {
      '/api': `http://127.0.0.1:${BACKEND_PORT}`,
      '/ws': { target: `ws://127.0.0.1:${BACKEND_PORT}`, ws: true },
    },
  },
});
