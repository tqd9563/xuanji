/**
 * macOS 横幅通知:后端直发(osascript),浏览器与 Pake 壳表现一致(2026-07-08 定案)。
 * 默认只用于璇玑派发的会话与定时任务;失败静默(通知是增强,不是依赖)。
 */
import { execFile } from 'node:child_process';

export function notifyMac(title: string, body: string) {
  if (process.platform !== 'darwin') return;
  const esc = (s: string) => s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').slice(0, 200);
  execFile(
    'osascript',
    ['-e', `display notification "${esc(body)}" with title "璇玑" subtitle "${esc(title)}"`],
    { timeout: 5_000 },
    () => {},
  );
}
