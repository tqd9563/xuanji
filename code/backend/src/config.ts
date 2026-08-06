import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 远程访问的密钥不进仓库、也不进 launchd plist,统一放 ~/.xuanji/remote.env(建议 chmod 600)。
 *
 * **绝不写回 process.env**(2026-08-06 修:曾经写回,导致口令被后端 spawn 的每个派发会话继承,
 * 派发出去的 Claude 会话及其运行的任意命令都能读到登录口令)。解析结果只留在本模块内,
 * 读取一律走 env() —— 真实环境变量优先(便于 preview.sh / 测试覆盖),其次才是配置文件。
 */
const fileEnv: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  const explicit = process.env.XUANJI_ENV_FILE;
  if (explicit === 'none') return out;
  // 未显式指定路径时,测试不读宿主机的默认配置文件,否则用例结果随本机文件漂移;
  // 显式指定(测试用临时文件、preview.sh 用 none)则一律照读
  if (!explicit && process.env.VITEST) return out;
  const file = explicit ?? path.join(os.homedir(), '.xuanji', 'remote.env');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out; // 没有这个文件 = 本机独占模式,属正常形态
  }
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const key = s.slice(0, i).trim();
    if (!key.startsWith('XUANJI_')) continue;
    out[key] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
})();

/** 空字符串视同未设置,才能回落到配置文件(preview.sh 用 `VAR=` 表达「显式置空」) */
function env(key: string): string {
  return process.env[key]?.trim() || fileEnv[key]?.trim() || '';
}

/**
 * 双监听(见 wiki/tech/remote-access.md):
 * - 本机 http://127.0.0.1:7777 —— 永远在,永远明文。Pake 壳与本机浏览器走这条,流量不出机器,
 *   没有嗅探威胁;给它套自签 https 只会让 WKWebView 因不认 mkcert rootCA 而白屏(2026-08-06 实际踩到)。
 * - 远程 https://0.0.0.0:7778 —— 仅在口令 + 证书齐备时启用,面向办公网,登录/二次口令/审计全套。
 * 同一端口无法既 http 又 https(绑 0.0.0.0:7777 已包含回环),故远程用独立端口。
 */
const remoteHost = env('XUANJI_HOST') || '0.0.0.0';
const isLoopbackHost = (h: string) => h === '127.0.0.1' || h === 'localhost' || h === '::1';

/** 登录口令:未配置 = 关闭鉴权(本机独占模式,与远程访问改造前行为一致) */
const password = env('XUANJI_PASSWORD');
/** 写操作二次口令:独立于登录口令,前端不做任何持久化(防家庭设备失陷后被直接冒用) */
const confirmToken = env('XUANJI_CONFIRM_TOKEN');

/**
 * 二次确认覆盖范围:
 * - exec(默认):只拦「等价于在本机执行任意代码」的操作(派发、定时任务、技能启停、打开外链)
 * - all:所有写操作都要口令,含待办/改名/归档这类纯自有数据变更
 */
const confirmScope = env('XUANJI_CONFIRM_SCOPE') === 'all' ? 'all' : 'exec';

const tlsCert = env('XUANJI_TLS_CERT');
const tlsKey = env('XUANJI_TLS_KEY');

const tls = tlsCert && tlsKey ? { cert: tlsCert, key: tlsKey } : null;
/** 远程监听器只在「口令 + 二次口令 + 证书」三者齐备时才起,任缺其一就只有本机 http */
const remoteEnabled = Boolean(password && confirmToken && tls);

/** 全局配置。默认形态(全 env 未设)= 改造前的本机只读驾驶舱,零行为差异。 */
export const config = {
  /** 本机监听:恒为回环 + 明文,不受远程配置影响 */
  host: '127.0.0.1',
  port: Number(env('XUANJI_PORT') || 7777),
  remote: {
    enabled: remoteEnabled,
    host: remoteHost,
    port: Number(env('XUANJI_REMOTE_PORT') || 7778),
  },
  /** 测试用 fixture 目录可覆盖 */
  claudeDir: process.env.XUANJI_CLAUDE_DIR ?? path.join(os.homedir(), '.claude'),
  dataDir: process.env.XUANJI_DATA_DIR ?? path.join(import.meta.dirname, '..', 'data'),
  /** 项目扫描噪音过滤规则(同时匹配编码目录名与解码路径,'-'/'/' 等价) */
  projectNoisePatterns: [/multica[-/]workspaces/],
  auth: {
    password,
    confirmToken,
    confirmScope,
    /** 会话有效期(天):过期需重新登录,限制凭证被拷走后的可用窗口 */
    sessionTtlDays: Number(env('XUANJI_SESSION_TTL_DAYS') || 7),
    /** 本机来源免登录:办公室日常使用体验与改造前一致 */
    trustLoopback: env('XUANJI_TRUST_LOOPBACK') !== '0',
  },
  tls,
} as const;

/**
 * 启动前置校验(fail closed):只要用户表达了「要开远程」的意图(设了 XUANJI_HOST 为非回环、
 * 或配了口令/证书中的任意一项),就必须把整套配齐,否则拒绝启动。
 * 宁可起不来,也不要以为自己开了远程、实际把无鉴权的派发通道挂到办公网。
 *
 * 只配 password 不配证书是允许的特例:此时远程监听器不启动,鉴权仅作用于本机 http
 * (preview.sh 验收登录关卡就走这条路径),没有暴露面。
 */
export function assertConfigSafe(cfg: typeof config = config): string[] {
  const errors: string[] = [];
  const wantsRemote = !isLoopbackHost(cfg.remote.host) && Boolean(env('XUANJI_HOST'));
  if (cfg.auth.password && cfg.auth.password.length < 16) {
    errors.push('XUANJI_PASSWORD 过短(要求 ≥16 字符,建议 32 字节随机)');
  }
  if (cfg.auth.confirmToken && cfg.auth.confirmToken === cfg.auth.password) {
    errors.push('XUANJI_CONFIRM_TOKEN 不能与 XUANJI_PASSWORD 相同(二次闸失去意义)');
  }
  if (!wantsRemote) return errors;
  if (!cfg.auth.password) errors.push('XUANJI_HOST 指向非回环地址,必须同时设置 XUANJI_PASSWORD');
  if (!cfg.auth.confirmToken) errors.push('远程模式必须设置 XUANJI_CONFIRM_TOKEN(写操作二次口令)');
  if (!cfg.tls) errors.push('远程模式必须配置 HTTPS(XUANJI_TLS_CERT / XUANJI_TLS_KEY),否则凭证明文过办公网');
  return errors;
}
