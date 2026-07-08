import os from 'node:os';
import path from 'node:path';

/** 全局配置。严格绑定 127.0.0.1(见 wiki/tech/stack.md 安全决策)。 */
export const config = {
  host: '127.0.0.1',
  port: Number(process.env.XUANJI_PORT ?? 7777),
  /** 测试用 fixture 目录可覆盖 */
  claudeDir: process.env.XUANJI_CLAUDE_DIR ?? path.join(os.homedir(), '.claude'),
  dataDir: process.env.XUANJI_DATA_DIR ?? path.join(import.meta.dirname, '..', 'data'),
  /** 项目扫描噪音过滤规则(同时匹配编码目录名与解码路径,'-'/'/' 等价) */
  projectNoisePatterns: [/multica[-/]workspaces/],
} as const;
