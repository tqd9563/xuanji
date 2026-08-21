/// <reference types="vite/client" />

// 构建时由 vite.config.ts 的 define 注入,值取自 package.json 的 version,
// 避免版本号在界面上被硬编码后随发版过期(2026-08-14 左上角停在 v1.4.0)。
declare const __APP_VERSION__: string;
