/**
 * 远程访问鉴权的前端状态(部署与鉴权模型见 wiki/tech/remote-access.md)。
 *
 * 两个凭证都**不做任何持久化**:
 * - 登录会话在 httpOnly cookie 里,JS 根本读不到,这里只存「是否已登录」的布尔值
 * - 写操作二次口令只驻内存,刷新即忘——家庭设备失陷时它是最后一道闸,落盘就白设了
 */

export type AuthStatus = {
  authEnabled: boolean;
  loggedIn: boolean;
  confirmRequired: boolean;
  confirmScope: 'exec' | 'all';
};

/** 未开鉴权时的默认态:一切照旧,与改造前的本机独占模式行为一致 */
export const OPEN_STATUS: AuthStatus = { authEnabled: false, loggedIn: true, confirmRequired: false, confirmScope: 'exec' };

let status: AuthStatus = OPEN_STATUS;
export function getAuthStatus(): AuthStatus {
  return status;
}
export function setAuthStatus(next: AuthStatus) {
  status = next;
}

// ---------- 二次确认口令(仅内存) ----------

let confirmToken: string | null = null;

export function peekConfirmToken(): string | null {
  return confirmToken;
}

export function forgetConfirmToken() {
  confirmToken = null;
}

let askSecret: ((opts: { title: string; hint?: string }) => Promise<string | null>) | null = null;
export function registerSecretPrompt(fn: typeof askSecret) {
  askSecret = fn;
}

/**
 * 取二次口令:内存里有就直接用,没有(或上次被服务端判错)才弹框问一次。
 * 于是每次刷新页面后的首个高危操作问一次,之后同一会话内不再打断。
 */
export async function ensureConfirmToken(force = false): Promise<string | null> {
  if (!status.confirmRequired) return null;
  if (confirmToken && !force) return confirmToken;
  const got = await askSecret?.({
    title: '二次确认口令',
    hint: '派发、定时任务、技能启停等会在办公笔记本上执行代码的操作需要二次口令。口令不会被保存,刷新页面后需重新输入。',
  });
  confirmToken = got && got.trim() ? got.trim() : null;
  return confirmToken;
}

// ---------- 掉线/未登录 ----------

let onUnauthorized: (() => void) | null = null;
export function registerUnauthorized(fn: (() => void) | null) {
  onUnauthorized = fn;
}

/** 会话过期或被新登录踢下线:清掉内存口令并把界面切回登录页 */
export function notifyUnauthorized() {
  confirmToken = null;
  if (status.authEnabled) {
    status = { ...status, loggedIn: false };
    onUnauthorized?.();
  }
}
