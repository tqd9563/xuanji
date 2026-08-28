import os from 'node:os';
import path from 'node:path';

const NOISE_CATEGORIES = [
  { key: 'scan', label: '扫描归因', patterns: [/multica[-/]workspaces/, /[-/.]narrate-cwd$/] },
  { key: 'biz-events', label: '业务事件', patterns: [/baize[-/]biz[-/]events$/] },
] as const;

/** 全局配置。严格绑定 127.0.0.1(见 wiki/tech/stack.md 安全决策)。 */
export const config = {
  host: '127.0.0.1',
  port: Number(process.env.XUANJI_PORT ?? 7777),
  /** 测试用 fixture 目录可覆盖 */
  claudeDir: process.env.XUANJI_CLAUDE_DIR ?? path.join(os.homedir(), '.claude'),
  dataDir: process.env.XUANJI_DATA_DIR ?? path.join(import.meta.dirname, '..', 'data'),
  /**
   * 噪音(非开发)目录分类。同时匹配编码目录名与解码路径,'-'/'/' 等价。
   * - scan(扫描归因):multica workspaces + narrate-cwd。narrate 是 baize multica 任务里
   *   `claude -p` 叙述会话的固定 cwd(如 ~/baize-runs/.narrate-cwd,历史上还有
   *   /private/tmp/narrate-out* 下的同名目录),与 workspaces 同属一次 daily-scan run,
   *   口径对齐 ~/antifraud_skills/baize/scripts/orchestrator/cost_report.py 的 Multica+Narrate 两行。
   * - biz-events(业务事件):baize-biz-events 夜间业务事件抽取(prompt 开头「业务事件抽取规则」),
   *   独立于 daily-scan run,单列一类。
   */
  noiseCategories: NOISE_CATEGORIES,
  /** 扁平噪音规则:项目列表过滤等只关心「是不是噪音」的场景用它 */
  projectNoisePatterns: NOISE_CATEGORIES.flatMap((c) => c.patterns),
} as const;
