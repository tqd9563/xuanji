import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 远程访问的密钥不进仓库、也不进 launchd plist,统一放 ~/.xuanji/remote.env(建议 chmod 600):
 *   XUANJI_HOST=0.0.0.0
 *   XUANJI_PASSWORD=...
 * 已在真实环境变量里的值优先,便于 preview.sh / 测试临时覆盖。
 */
function loadEnvFile() {
  // 测试与隔离验收(preview.sh)不吃宿主机的远程配置,否则用例结果随本机文件漂移
  if (process.env.VITEST || process.env.XUANJI_ENV_FILE === 'none') return;
  const file = process.env.XUANJI_ENV_FILE ?? path.join(os.homedir(), '.xuanji', 'remote.env');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // 没有这个文件 = 本机独占模式,属正常形态
  }
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const key = s.slice(0, i).trim();
    if (!key.startsWith('XUANJI_') || process.env[key] !== undefined) continue;
    process.env[key] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
}
loadEnvFile();

/** 监听地址默认仍绑 127.0.0.1;远程访问模式靠 XUANJI_HOST 显式开启(见 wiki/tech/remote-access.md) */
const host = process.env.XUANJI_HOST?.trim() || '127.0.0.1';
const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

/** 登录口令:未配置 = 关闭鉴权(本机独占模式,与远程访问改造前行为一致) */
const password = process.env.XUANJI_PASSWORD?.trim() || '';
/** 写操作二次口令:独立于登录口令,前端不做任何持久化(防家庭设备失陷后被直接冒用) */
const confirmToken = process.env.XUANJI_CONFIRM_TOKEN?.trim() || '';

/**
 * 二次确认覆盖范围:
 * - exec(默认):只拦「等价于在本机执行任意代码」的操作(派发、定时任务、技能启停、打开外链)
 * - all:所有写操作都要口令,含待办/改名/归档这类纯自有数据变更
 */
const confirmScope = process.env.XUANJI_CONFIRM_SCOPE === 'all' ? 'all' : 'exec';

const tlsCert = process.env.XUANJI_TLS_CERT?.trim() || '';
const tlsKey = process.env.XUANJI_TLS_KEY?.trim() || '';

/** 全局配置。默认形态(全 env 未设)= 改造前的本机只读驾驶舱,零行为差异。 */
export const config = {
  host,
  isLoopback,
  port: Number(process.env.XUANJI_PORT ?? 7777),
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
    sessionTtlDays: Number(process.env.XUANJI_SESSION_TTL_DAYS ?? 7),
    /** 本机来源免登录:办公室日常使用体验与改造前一致 */
    trustLoopback: process.env.XUANJI_TRUST_LOOPBACK !== '0',
  },
  tls: tlsCert && tlsKey ? { cert: tlsCert, key: tlsKey } : null,
} as const;

/**
 * 启动前置校验:绑非回环地址 = 暴露到办公网,此时缺鉴权配置一律拒绝启动(fail closed)。
 * 宁可起不来,也不要以为自己开了远程、实际把无鉴权的派发通道挂到全网段。
 */
export function assertConfigSafe(cfg: typeof config = config): string[] {
  const errors: string[] = [];
  if (cfg.isLoopback) return errors;
  if (!cfg.auth.password) errors.push('XUANJI_HOST 绑定了非回环地址,必须同时设置 XUANJI_PASSWORD');
  if (cfg.auth.password && cfg.auth.password.length < 16) {
    errors.push('XUANJI_PASSWORD 过短(要求 ≥16 字符,建议 32 字节随机)');
  }
  if (!cfg.auth.confirmToken) errors.push('远程模式必须设置 XUANJI_CONFIRM_TOKEN(写操作二次口令)');
  if (cfg.auth.confirmToken && cfg.auth.confirmToken === cfg.auth.password) {
    errors.push('XUANJI_CONFIRM_TOKEN 不能与 XUANJI_PASSWORD 相同(二次闸失去意义)');
  }
  if (!cfg.tls) errors.push('远程模式必须配置 HTTPS(XUANJI_TLS_CERT / XUANJI_TLS_KEY),否则凭证明文过办公网');
  return errors;
}
