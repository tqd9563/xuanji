/**
 * Mac 锁屏判定:飞书中控「锁屏时才推送」的唯一依据。
 *
 * 读 `ioreg -n Root -d1 -a` 的 IOConsoleUsers → `CGSSessionScreenIsLocked`:锁屏时该键为 true,
 * 未锁屏时缺省或为 false。非 macOS 一律按未锁屏处理(不推送)。
 * 结果缓存 5 秒:推送判定可能在一次回合里被连续问到多次,不值得每次都 fork ioreg。
 */
import { execFile } from 'node:child_process';

const CACHE_MS = 5_000;
let cache: { at: number; locked: boolean } | null = null;

/** 从 ioreg 的 plist 输出里判定是否锁屏(纯函数,便于测试) */
export function parseScreenLocked(plist: string): boolean {
  return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(plist);
}

export function isScreenLocked(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  if (cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.locked);
  return new Promise((resolve) => {
    execFile('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a'], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      const locked = err ? false : parseScreenLocked(String(out));
      cache = { at: Date.now(), locked };
      resolve(locked);
    });
  });
}
