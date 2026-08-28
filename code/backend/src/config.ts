import os from 'node:os';
import path from 'node:path';

/** 全局配置。严格绑定 127.0.0.1(见 wiki/tech/stack.md 安全决策)。 */
export const config = {
  host: '127.0.0.1',
  port: Number(process.env.XUANJI_PORT ?? 7777),
  /** 测试用 fixture 目录可覆盖 */
  claudeDir: process.env.XUANJI_CLAUDE_DIR ?? path.join(os.homedir(), '.claude'),
  dataDir: process.env.XUANJI_DATA_DIR ?? path.join(import.meta.dirname, '..', 'data'),
  /**
   * 项目扫描噪音过滤规则(同时匹配编码目录名与解码路径,'-'/'/' 等价)。
   * narrate-cwd 是 baize multica 任务里 `claude -p` 叙述会话的固定 cwd
   * (如 ~/baize-runs/.narrate-cwd,历史上还有 /private/tmp/narrate-out* 下的同名目录),
   * 与 multica workspaces 同属一次 run 的用量,口径对齐
   * ~/antifraud_skills/baize/scripts/orchestrator/cost_report.py 的 Multica+Narrate 两行。
   */
  projectNoisePatterns: [/multica[-/]workspaces/, /[-/.]narrate-cwd$/],
} as const;
