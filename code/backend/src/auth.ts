/**
 * 远程访问鉴权(部署与鉴权模型见 wiki/tech/remote-access.md)。
 *
 * 设计要点:
 * - 凭证走 httpOnly cookie,前端 JS 读不到,XSS 偷不走;WS 握手浏览器自动带 cookie,不用 query 传 token
 * - 单活跃会话:新登录踢掉旧会话,凭证被盗用时本人立刻被踢下线
 * - 写操作二次口令(confirmToken)独立于登录口令、前端不持久化——家庭设备被实时远控时的最后一道闸
 * - 未配置 XUANJI_PASSWORD = 关闭鉴权,行为与改造前完全一致(本机独占模式)
 */
import crypto from 'node:crypto';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from './config.js';
import type { Storage } from './storage/db.js';

export const SESSION_COOKIE = 'xuanji_session';
const DAY = 86_400_000;

/** 恒时比较,避免逐字符比较泄漏口令前缀(时序攻击) */
export function safeEqual(a: string, b: string): boolean {
  // 长度不等时 timingSafeEqual 会抛错,先取固定长度摘要抹平长度差异
  const ah = crypto.createHash('sha256').update(a, 'utf8').digest();
  const bh = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ah, bh);
}

export function hashSessionId(id: string): string {
  return crypto.createHash('sha256').update(id).digest('hex');
}

export function isAuthEnabled(): boolean {
  return Boolean(config.auth.password);
}

/** '::ffff:127.0.0.1' 这类 v4-mapped 地址归一,否则本机豁免会漏判 */
export function normalizeIp(raw: string | undefined): string {
  if (!raw) return 'unknown';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

export function isLoopbackIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

export function clientIp(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return normalizeIp(env?.incoming?.socket?.remoteAddress);
}

export function cookieFromHeader(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** WS upgrade 用:从原始 Cookie header 校验会话(浏览器 WebSocket 不能设自定义 header,但会带 cookie) */
export function verifySessionCookie(storage: Storage, cookieHeader: string | undefined): boolean {
  if (!isAuthEnabled()) return true;
  const raw = cookieFromHeader(cookieHeader, SESSION_COOKIE);
  if (!raw) return false;
  return Boolean(storage.findAuthSession(hashSessionId(raw)));
}

/**
 * 「等价于在本机执行任意代码」的高危写操作:派发、定时任务、技能启停、打开外链、周报生成。
 * 这些即使拿到登录会话也必须再输 confirmToken;待办/改名/归档等纯自有数据变更默认不拦
 * (XUANJI_CONFIRM_SCOPE=all 可提升为全部写操作都拦)。
 */
const EXEC_WRITE_PATTERNS: RegExp[] = [
  /^\/dispatch(\/|$)/,
  /^\/schedules(\/|$)/,
  /^\/skills\/[^/]+\/toggle$/,
  /^\/open-url$/,
  /^\/sessions\/[^/]+\/close$/,
  /^\/weekly-review\/draft$/,
];

export function isWriteMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

export function needsConfirm(method: string, path: string): boolean {
  if (!isWriteMethod(method)) return false;
  if (path === '/auth/login' || path === '/auth/logout') return false;
  if (config.auth.confirmScope === 'all') return true;
  return EXEC_WRITE_PATTERNS.some((re) => re.test(path));
}

export function checkConfirmToken(provided: unknown): boolean {
  if (!isAuthEnabled() || !config.auth.confirmToken) return true;
  return typeof provided === 'string' && safeEqual(provided, config.auth.confirmToken);
}

/**
 * 鉴权 + 审计中间件。挂在 /api/* 上。
 * 本机来源(127.0.0.1)默认豁免登录,办公室日常使用体验与改造前一致。
 */
export function createAuthMiddleware(storage: Storage): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const ip = clientIp(c);
    const method = c.req.method;
    const path = c.req.path.replace(/^\/api/, '') || '/';
    const write = isWriteMethod(method);

    const log = (status: number, note?: string) => {
      // 只在远程模式记审计,避免本机自用时把库写满
      if (isAuthEnabled()) storage.recordAccess({ ip, method, path, isWrite: write, status, note });
    };

    const localTrusted = config.auth.trustLoopback && isLoopbackIp(ip);
    const publicPath = path === '/auth/login' || path === '/auth/status' || path === '/health';

    if (isAuthEnabled() && !localTrusted && !publicPath) {
      const raw = getCookie(c, SESSION_COOKIE);
      const session = raw ? storage.findAuthSession(hashSessionId(raw)) : null;
      if (!session) {
        log(401, 'no-session');
        return c.json({ error: '未登录或会话已过期' }, 401);
      }
    }

    // 二次口令:高危写操作即使已登录也要输;本机来源同样要求,口令泄露风险不因来源而变
    if (needsConfirm(method, path) && isAuthEnabled() && config.auth.confirmToken) {
      let body: unknown = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const provided = (body as { confirmToken?: unknown })?.confirmToken;
      if (!checkConfirmToken(provided)) {
        log(403, 'bad-confirm-token');
        return c.json({ error: '二次确认口令错误', needConfirm: true }, 403);
      }
    }

    await next();
    log(c.res.status);
  };
}

/** 登录 / 注销 / 状态。挂在 /api 下,登录本身不经过会话校验。 */
export function attachAuthRoutes(api: import('hono').Hono, storage: Storage) {
  api.get('/auth/status', (c) => {
    const ip = clientIp(c);
    const raw = getCookie(c, SESSION_COOKIE);
    const loggedIn =
      !isAuthEnabled() ||
      (config.auth.trustLoopback && isLoopbackIp(ip)) ||
      Boolean(raw && storage.findAuthSession(hashSessionId(raw)));
    return c.json({
      authEnabled: isAuthEnabled(),
      loggedIn,
      /** 前端据此决定写操作是否弹二次确认框 */
      confirmRequired: isAuthEnabled() && Boolean(config.auth.confirmToken),
      confirmScope: config.auth.confirmScope,
    });
  });

  api.post('/auth/login', async (c) => {
    const ip = clientIp(c);
    if (!isAuthEnabled()) return c.json({ ok: true, authEnabled: false });
    const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
    if (typeof body.password !== 'string' || !safeEqual(body.password, config.auth.password)) {
      storage.recordAccess({ ip, method: 'POST', path: '/auth/login', isWrite: true, status: 401, note: 'bad-password' });
      return c.json({ error: '口令错误' }, 401);
    }
    storage.clearAuthSessions(); // 单活跃会话
    const sid = crypto.randomBytes(32).toString('base64url');
    const ttl = Math.max(1, config.auth.sessionTtlDays) * DAY;
    storage.createAuthSession(hashSessionId(sid), Date.now() + ttl, ip, c.req.header('user-agent') ?? '');
    setCookie(c, SESSION_COOKIE, sid, {
      httpOnly: true,
      // 本机 HTTP 调试时 Secure cookie 不会被回写,故仅在启用 TLS 时置 Secure
      secure: Boolean(config.tls),
      sameSite: 'Strict',
      path: '/',
      maxAge: Math.floor(ttl / 1000),
    });
    storage.recordAccess({ ip, method: 'POST', path: '/auth/login', isWrite: true, status: 200, note: 'login' });
    return c.json({ ok: true });
  });

  api.post('/auth/logout', (c) => {
    const raw = getCookie(c, SESSION_COOKIE);
    if (raw) storage.deleteAuthSession(hashSessionId(raw));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  api.get('/auth/access-log', (c) => c.json({ entries: storage.listAccessLog(200) }));
}
