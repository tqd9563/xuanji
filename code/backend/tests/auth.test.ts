/**
 * 远程访问鉴权。config 在模块加载时读 env,故凡涉及配置的用例都用 vi.resetModules + 动态 import。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { Storage } from '../src/storage/db.js';

const PASSWORD = 'p'.repeat(32);
const CONFIRM = 'c'.repeat(32);

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-auth-'));
  storage = new Storage(dir);
});

afterEach(() => {
  storage.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** 载入一份「远程模式」的 auth 模块:开鉴权 + 二次口令,且不信任回环(测试里 IP 恒为 unknown) */
async function loadRemoteAuth(extra: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubEnv('XUANJI_PASSWORD', PASSWORD);
  vi.stubEnv('XUANJI_CONFIRM_TOKEN', CONFIRM);
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
  return import('../src/auth.js');
}

async function remoteApp(extra?: Record<string, string>) {
  const auth = await loadRemoteAuth(extra);
  const app = new Hono();
  app.use('/api/*', auth.createAuthMiddleware(storage));
  const api = new Hono();
  auth.attachAuthRoutes(api, storage);
  api.get('/dashboard', (c) => c.json({ ok: true }));
  api.post('/todos', async (c) => c.json({ created: true, body: await c.req.json() }));
  api.post('/dispatch/handoff', (c) => c.json({ dispatched: true }));
  app.route('/api', api);
  return { app, auth };
}

/** 从 Set-Cookie 里取出会话 cookie,回填到后续请求 */
function sessionCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  return raw.split(';')[0] ?? '';
}

describe('恒时比较与 cookie 解析', () => {
  it('safeEqual 只对完全相同的字符串为真,长度不同不抛错', async () => {
    const { safeEqual } = await import('../src/auth.js');
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcdefghijklmnop')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('cookieFromHeader 只取同名项,兼容空格与百分号编码', async () => {
    const { cookieFromHeader } = await import('../src/auth.js');
    expect(cookieFromHeader('a=1; xuanji_session=abc; b=2', 'xuanji_session')).toBe('abc');
    expect(cookieFromHeader('xuanji_session_other=zzz', 'xuanji_session')).toBeNull();
    expect(cookieFromHeader(undefined, 'xuanji_session')).toBeNull();
    expect(cookieFromHeader('xuanji_session=a%2Bb', 'xuanji_session')).toBe('a+b');
  });

  it('v4-mapped 地址归一后能判为本机', async () => {
    const { normalizeIp, isLoopbackIp } = await import('../src/auth.js');
    expect(isLoopbackIp(normalizeIp('::ffff:127.0.0.1'))).toBe(true);
    expect(isLoopbackIp(normalizeIp('::1'))).toBe(true);
    expect(isLoopbackIp(normalizeIp('192.0.2.87'))).toBe(false);
    expect(normalizeIp(undefined)).toBe('unknown');
  });
});

describe('会话存储', () => {
  it('过期会话查不到,且会被顺带清理', () => {
    storage.createAuthSession('hash-expired', Date.now() - 1000, '10.0.0.1', 'ua');
    expect(storage.findAuthSession('hash-expired')).toBeNull();
  });

  it('新登录踢掉旧会话(单活跃会话)', () => {
    storage.createAuthSession('old', Date.now() + 60_000, '10.0.0.1', 'ua');
    storage.clearAuthSessions();
    storage.createAuthSession('new', Date.now() + 60_000, '10.0.0.2', 'ua');
    expect(storage.findAuthSession('old')).toBeNull();
    expect(storage.findAuthSession('new')).not.toBeNull();
  });
});

describe('二次确认范围', () => {
  it('exec 范围只拦执行类写操作,读操作与待办不拦', async () => {
    const { needsConfirm } = await loadRemoteAuth();
    expect(needsConfirm('POST', '/dispatch/handoff')).toBe(true);
    expect(needsConfirm('POST', '/schedules')).toBe(true);
    expect(needsConfirm('POST', '/skills/baize/toggle')).toBe(true);
    expect(needsConfirm('POST', '/open-url')).toBe(true);
    expect(needsConfirm('POST', '/weekly-review/draft')).toBe(true);
    expect(needsConfirm('POST', '/todos')).toBe(false);
    expect(needsConfirm('GET', '/dispatch/handoff')).toBe(false);
    expect(needsConfirm('POST', '/auth/login')).toBe(false);
  });

  it('all 范围下所有写操作都要口令', async () => {
    const { needsConfirm } = await loadRemoteAuth({ XUANJI_CONFIRM_SCOPE: 'all' });
    expect(needsConfirm('POST', '/todos')).toBe(true);
    expect(needsConfirm('PATCH', '/todos/1')).toBe(true);
    expect(needsConfirm('GET', '/todos')).toBe(false);
    expect(needsConfirm('POST', '/auth/login')).toBe(false);
  });
});

describe('鉴权中间件(远程来源)', () => {
  it('无会话访问业务接口 → 401', async () => {
    const { app } = await remoteApp();
    const res = await app.request('/api/dashboard');
    expect(res.status).toBe(401);
  });

  it('口令错误 → 401 且不下发 cookie', async () => {
    const { app } = await remoteApp();
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('登录后 cookie 为 HttpOnly + SameSite=Strict,并能访问业务接口', async () => {
    const { app } = await remoteApp();
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);

    const res = await app.request('/api/dashboard', { headers: { Cookie: sessionCookie(login) } });
    expect(res.status).toBe(200);
  });

  it('注销后原 cookie 失效', async () => {
    const { app } = await remoteApp();
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = sessionCookie(login);
    await app.request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } });
    const res = await app.request('/api/dashboard', { headers: { Cookie: cookie } });
    expect(res.status).toBe(401);
  });

  it('第二次登录踢掉第一次的会话', async () => {
    const { app } = await remoteApp();
    const doLogin = () =>
      app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
    const first = sessionCookie(await doLogin());
    const second = sessionCookie(await doLogin());
    expect((await app.request('/api/dashboard', { headers: { Cookie: first } })).status).toBe(401);
    expect((await app.request('/api/dashboard', { headers: { Cookie: second } })).status).toBe(200);
  });

  it('已登录但高危写操作缺二次口令 → 403;口令正确 → 放行;低危写操作不受影响', async () => {
    const { app } = await remoteApp();
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = sessionCookie(login);
    const post = (p: string, body: unknown) =>
      app.request(p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(body),
      });

    expect((await post('/api/dispatch/handoff', { sessionId: 'x' })).status).toBe(403);
    expect((await post('/api/dispatch/handoff', { sessionId: 'x', confirmToken: 'wrong' })).status).toBe(403);
    expect((await post('/api/dispatch/handoff', { sessionId: 'x', confirmToken: CONFIRM })).status).toBe(200);
    expect((await post('/api/todos', { title: '随手记' })).status).toBe(200);
  });

  it('中间件读过 body 后,路由仍能再次解析 body', async () => {
    const { app } = await remoteApp({ XUANJI_CONFIRM_SCOPE: 'all' });
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie(login) },
      body: JSON.stringify({ title: '随手记', confirmToken: CONFIRM }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { body: { title: string } };
    expect(json.body.title).toBe('随手记');
  });

  it('访问日志记录 401 与成功写操作,且不落任何口令内容', async () => {
    const { app } = await remoteApp();
    await app.request('/api/dashboard');
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    await app.request('/api/dispatch/handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie(login) },
      body: JSON.stringify({ confirmToken: CONFIRM }),
    });
    const entries = storage.listAccessLog();
    expect(entries.some((e) => e.path === '/dashboard' && e.status === 401)).toBe(true);
    expect(entries.some((e) => e.path === '/dispatch/handoff' && e.isWrite === 1 && e.status === 200)).toBe(true);
    const dump = JSON.stringify(entries);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(CONFIRM);
  });
});

describe('WS 会话校验', () => {
  it('无 cookie 拒绝,有效 cookie 放行,伪造 cookie 拒绝', async () => {
    const { verifySessionCookie, hashSessionId } = await loadRemoteAuth();
    expect(verifySessionCookie(storage, undefined)).toBe(false);
    expect(verifySessionCookie(storage, 'xuanji_session=forged')).toBe(false);
    storage.createAuthSession(hashSessionId('real-sid'), Date.now() + 60_000, '10.0.0.1', 'ua');
    expect(verifySessionCookie(storage, 'other=1; xuanji_session=real-sid')).toBe(true);
  });

  it('关闭鉴权时一律放行(本机独占模式行为不变)', async () => {
    vi.resetModules();
    const { verifySessionCookie } = await import('../src/auth.js');
    expect(verifySessionCookie(storage, undefined)).toBe(true);
  });
});

describe('密钥加载(remote.env)', () => {
  /**
   * 回归:配置文件里的口令**绝不能写回 process.env**。
   * 曾经写回过,后果是后端 spawn 的每个派发会话都继承了登录口令,
   * 派发出去的 Claude 会话及其运行的任意命令都能读到(2026-08-06 实际发生)。
   */
  it('读得到配置文件的值,但不污染 process.env', async () => {
    const envFile = path.join(dir, 'remote.env');
    fs.writeFileSync(
      envFile,
      ['# 注释行', `XUANJI_PASSWORD=${PASSWORD}`, `XUANJI_CONFIRM_TOKEN="${CONFIRM}"`, 'NOT_XUANJI=ignored', ''].join('\n'),
    );
    vi.resetModules();
    vi.stubEnv('XUANJI_ENV_FILE', envFile);
    const { config } = await import('../src/config.js');

    expect(config.auth.password).toBe(PASSWORD);
    expect(config.auth.confirmToken).toBe(CONFIRM); // 引号被剥掉
    // 关键断言:文件里的值没有被写回环境变量(vitest.config 把它们钉成空串,故比对「不等于口令」)
    expect(process.env.XUANJI_PASSWORD).not.toBe(PASSWORD);
    expect(process.env.XUANJI_CONFIRM_TOKEN).not.toBe(CONFIRM);
    expect(process.env.NOT_XUANJI).toBeUndefined();
  });

  it('真实环境变量优先于配置文件(preview.sh / 测试可覆盖)', async () => {
    const envFile = path.join(dir, 'remote.env');
    fs.writeFileSync(envFile, `XUANJI_PASSWORD=${PASSWORD}\n`);
    vi.resetModules();
    vi.stubEnv('XUANJI_ENV_FILE', envFile);
    vi.stubEnv('XUANJI_PASSWORD', 'env-wins-'.padEnd(20, 'x'));
    const { config } = await import('../src/config.js');
    expect(config.auth.password).toBe('env-wins-'.padEnd(20, 'x'));
  });

  it('XUANJI_ENV_FILE=none 时完全不读文件(隔离验收)', async () => {
    vi.resetModules();
    vi.stubEnv('XUANJI_ENV_FILE', 'none');
    const { config } = await import('../src/config.js');
    expect(config.auth.password).toBe('');
    expect(config.remote.enabled).toBe(false);
  });
});

describe('启动前置校验(fail closed)', () => {
  async function errorsFor(env: Record<string, string>) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const { assertConfigSafe } = await import('../src/config.js');
    return assertConfigSafe();
  }

  it('未表达远程意图时不做任何要求', async () => {
    expect(await errorsFor({})).toEqual([]);
  });

  it('只配口令不配证书:允许启动,但远程监听器不启用(仅本机 http 带鉴权)', async () => {
    vi.resetModules();
    vi.stubEnv('XUANJI_PASSWORD', PASSWORD);
    vi.stubEnv('XUANJI_CONFIRM_TOKEN', CONFIRM);
    const { assertConfigSafe, config } = await import('../src/config.js');
    expect(assertConfigSafe()).toEqual([]);
    expect(config.remote.enabled).toBe(false);
    expect(config.host).toBe('127.0.0.1');
  });

  it('三件套齐备时启用远程监听器,本机监听仍是回环 http', async () => {
    vi.resetModules();
    vi.stubEnv('XUANJI_PASSWORD', PASSWORD);
    vi.stubEnv('XUANJI_CONFIRM_TOKEN', CONFIRM);
    vi.stubEnv('XUANJI_TLS_CERT', '/tmp/c.pem');
    vi.stubEnv('XUANJI_TLS_KEY', '/tmp/k.pem');
    const { config } = await import('../src/config.js');
    expect(config.remote.enabled).toBe(true);
    expect(config.remote.port).toBe(7778);
    // 本机口子不受远程配置影响:仍是回环 + 明文,Pake 壳照旧可用
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(7777);
  });

  it('绑办公网地址但缺口令/TLS 时逐条报错', async () => {
    const errs = await errorsFor({ XUANJI_HOST: '192.0.2.42' });
    expect(errs.some((e) => e.includes('XUANJI_PASSWORD'))).toBe(true);
    expect(errs.some((e) => e.includes('XUANJI_CONFIRM_TOKEN'))).toBe(true);
    expect(errs.some((e) => e.includes('HTTPS'))).toBe(true);
  });

  it('二次口令与登录口令相同时拒绝', async () => {
    const errs = await errorsFor({
      XUANJI_HOST: '192.0.2.42',
      XUANJI_PASSWORD: PASSWORD,
      XUANJI_CONFIRM_TOKEN: PASSWORD,
      XUANJI_TLS_CERT: '/tmp/c.pem',
      XUANJI_TLS_KEY: '/tmp/k.pem',
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('不能与 XUANJI_PASSWORD 相同');
  });

  it('口令过短时拒绝', async () => {
    const errs = await errorsFor({
      XUANJI_HOST: '192.0.2.42',
      XUANJI_PASSWORD: 'short',
      XUANJI_CONFIRM_TOKEN: CONFIRM,
      XUANJI_TLS_CERT: '/tmp/c.pem',
      XUANJI_TLS_KEY: '/tmp/k.pem',
    });
    expect(errs.some((e) => e.includes('过短'))).toBe(true);
  });
});
