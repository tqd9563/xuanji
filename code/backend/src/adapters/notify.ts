/**
 * macOS 横幅通知:后端直发(osascript),浏览器与 Pake 壳表现一致(2026-07-08 定案)。
 * 失败静默(通知是增强,不是依赖)。
 *
 * 发不发由「设置 › 通知」决定:范围(谁产生的)与事件(发生了什么)取与——
 * 两者都开才发。判定函数由 server 启动时注入,adapter 层不直接读存储。
 */
import { execFile } from 'node:child_process';

/** 谁产生的通知 */
export type NotifyScope = 'dispatched' | 'scheduled' | 'terminal';
/** 发生了什么 */
export type NotifyKind = 'blocked' | 'turnEnd' | 'error';

type Gate = (scope: NotifyScope, kind: NotifyKind) => boolean;

/** 未注入时一律放行:测试与脚本里不该因为缺少偏好而静默丢通知 */
let gate: Gate = () => true;

export function setNotifyGate(fn: Gate) {
  gate = fn;
}

export function notifyMac(title: string, body: string, scope: NotifyScope, kind: NotifyKind) {
  if (process.platform !== 'darwin') return;
  if (!gate(scope, kind)) return;
  const esc = (s: string) => s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').slice(0, 200);
  execFile(
    'osascript',
    ['-e', `display notification "${esc(body)}" with title "璇玑" subtitle "${esc(title)}"`],
    { timeout: 5_000 },
    () => {},
  );
}
