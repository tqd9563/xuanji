/** 内部领域模型 —— adapter 之上的所有层只认这些类型,不认 ~/.claude 原始格式。 */

/** 随派发消息内联发送的图片(用户在输入框粘贴的截图)。data 是不带 data: 前缀的 base64。 */
export interface InlineImage {
  media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
}

/** Anthropic 接受的图片 media type;粘贴进来的其它格式一律拒收,不做转码。 */
export const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
/** 单图上限 5MB(Anthropic 硬限),按 base64 解码后的字节数算 */
export const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** 单条消息最多带几张图 */
export const INLINE_IMAGE_MAX_COUNT = 8;

/** 校验并归一化来自 WS 的图片数组;任一张不合法即返回错误原因,不做部分接受。 */
export function parseInlineImages(raw: unknown): { ok: true; images: InlineImage[] } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: 'images 必须是数组' };
  if (raw.length > INLINE_IMAGE_MAX_COUNT) return { ok: false, reason: `一条消息最多带 ${INLINE_IMAGE_MAX_COUNT} 张图片` };
  const images: InlineImage[] = [];
  for (const item of raw) {
    const mt = (item as InlineImage)?.media_type;
    const data = (item as InlineImage)?.data;
    if (typeof data !== 'string' || !data) return { ok: false, reason: '图片数据为空' };
    if (!(INLINE_IMAGE_TYPES as readonly string[]).includes(mt)) return { ok: false, reason: `不支持的图片格式:${String(mt)}` };
    // base64 每 4 字符 → 3 字节,末尾 = 号是填充不计入
    const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (bytes > INLINE_IMAGE_MAX_BYTES) return { ok: false, reason: `单张图片不能超过 ${INLINE_IMAGE_MAX_BYTES / 1024 / 1024}MB` };
    images.push({ media_type: mt, data });
  }
  return { ok: true, images };
}

export interface GitStatus {
  branch: string;
  /** zsh 风格:! 已修改(含暂存) */
  modified: number;
  /** ? 未跟踪 */
  untracked: number;
  /** ↑ 领先远端未推送;无 upstream 时为 null */
  ahead: number | null;
}

export interface Project {
  /** basename,用作展示名与分类色键 */
  name: string;
  /** 真实绝对路径 */
  path: string;
  /** ~/.claude/projects 下的编码目录名 */
  encodedDir: string;
  sessionCount: number;
  memoryCount: number;
  /** epoch ms;来自 history.jsonl,无记录为 null */
  lastActiveAt: number | null;
  /** 近 7 日每日 prompt 数,[6天前..今天] */
  heat: number[];
  git: GitStatus | null;
}

/**
 * 看板列。'review'(验收中)不由任何适配器上报,而是在 sessionsBoard 里推导:
 * 已产出、非进行态、未被处置的会话都落在这里,只有显式处置(挂起→idle / 归档→done)
 * 才离开;「看过回放」只熄灭前端的未读角标,不改变归属。
 */
export type SessionState = 'running' | 'blocked' | 'review' | 'idle' | 'done';

export interface AgentSession {
  id: string;
  sessionId: string;
  name: string;
  cwd: string;
  /** cwd basename */
  project: string;
  kind: 'interactive' | 'background';
  state: SessionState;
  startedAt: number;
  /** 终端存活的 interactive 会话 → 只读不可接管 */
  readonly: boolean;
  /** jobs/<id>/state.json 补充 */
  detail?: string;
  needs?: string;
  tokens?: number;
  /** 来源标签:web = 璇玑派发(P2 自嵌套递归的显式标记) */
  source?: 'web';
  /** 后端进程内存活的派发会话:看板点击直接 attach 回原事件流 */
  dispatchId?: string;
  /** 最近一次产出时间:前端据此与本地已读时间比较,标「待验收」 */
  lastOutputAt?: number;
  /** 用户手动拖到「已完成」的归档卡:state 已被覆盖为 done,前端据此给出撤销入口 */
  archived?: boolean;
  /** 用户在验收中显式「挂起」的卡:state 已被覆盖为 idle,前端据此给出复位入口 */
  suspended?: boolean;
}

/** 回放事件:session jsonl 归一化产物。未知类型降级为 raw,绝不丢弃。 */
export type ReplayEvent =
  | { kind: 'user'; text: string; ts?: string }
  | { kind: 'assistant'; text: string; model?: string; ts?: string }
  | { kind: 'tool'; name: string; input: string; output?: string; isError?: boolean }
  | { kind: 'raw'; type: string; json: string }
  | {
      /** PR/MR 链接:Claude Code 在创建、push、合并时各写一条 pr-link 元事件 */
      kind: 'pr';
      url: string;
      /** 由 URL host 判定;认不出的自建实例归 other,仍出卡片只是不上品牌色 */
      platform: 'gitlab' | 'github' | 'other';
      number?: number;
      repo?: string;
      /** 同一 URL 的后续事件数(每次 push / 合并都会重写一条),0 表示只创建过 */
      updates: number;
      /** 最近一次事件时间;updates 为 0 时与 ts 相同 */
      lastTs?: string;
      ts?: string;
    }
  | {
      kind: 'compact';
      /** manual(/compact) 或 auto(上下文自动压缩) */
      trigger?: string;
      /** 压缩前上下文 token 数 */
      preTokens?: number;
      /** 压缩耗时(ms) */
      durationMs?: number;
      /** 压缩摘要全文(isCompactSummary 记录回填) */
      summary?: string;
      ts?: string;
    };

export interface Replay {
  sessionId: string;
  events: ReplayEvent[];
  /** 解析失败跳过的行数(降级不崩溃的证据) */
  skippedLines: number;
  /** custom-title 事件里的会话名 */
  title?: string;
}

/** 技能触发次数(各窗口计数 + 最近触发);由 session jsonl 重建,非自有数据 */
export interface SkillUsage {
  d7: number;
  d30: number;
  d90: number;
  /** 最近一次触发时刻(ms);从未触发时缺省 */
  lastUsedAt?: number;
}

export interface Skill {
  name: string;
  description: string;
  version?: string;
  userInvocable: boolean;
  allowedTools?: string;
  source: 'user' | 'plugin';
  enabled: boolean;
  /** SKILL.md 正文(frontmatter 之后) */
  body?: string;
  /** 触发统计;索引尚未建好时缺省 */
  usage?: SkillUsage;
}

export interface Memory {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference' | 'cross-project' | 'unknown';
  /** 所属项目展示名 */
  project: string;
  projectPath: string;
  file: string;
  body: string;
  /** [[wikilink]] 引用 */
  links: string[];
}

/** 任务总结(wrapup skill 落在 ~/.claude/worklog/ 的一张卡) */
export interface WorklogCard {
  /** 文件名去扩展名,全局唯一键 */
  name: string;
  /** YYYY-MM-DD */
  date: string;
  /** 项目 slug(卡里只记 slug,不记绝对路径) */
  project: string;
  /** 一句话任务主题 */
  task: string;
  branch?: string;
  commits: string[];
  mr?: string;
  /** 外部锚点:issue id / request_id / 样例文件路径 */
  refs: string[];
  status: 'merged' | 'pending-merge' | 'unresolved' | 'unknown';
  /** 出卡会话 id,直连只读回放 */
  session?: string;
  /** ISO8601,下一张卡据此续接划界 */
  coversUntil?: string;
  file: string;
  /** 正文分段;解析不出任何段落时 raw 保留全文(降级不丢卡) */
  sections: WorklogSections;
  /** frontmatter 缺失/损坏的降级标记 */
  degraded: boolean;
}

export interface WorklogSections {
  problem?: string;
  conclusion?: string;
  /** 排除项 / 已知残留:逐条 bullet(卡片最值钱的两段) */
  excluded: string[];
  residue: string[];
  decisions: string[];
  files: string[];
  /** 一个已知段落都没识别出来时的全文兜底 */
  raw?: string;
}

export interface HistoryEntry {
  display: string;
  /** epoch ms */
  timestamp: number;
  /** 绝对路径 */
  project: string;
  sessionId: string;
}

// ---------- 周回顾(weekly review) ----------

export interface ReviewSession {
  sessionId: string;
  title: string;
  /** 窗口内我发出的 prompt 数(活跃口径) */
  prompts: number;
  firstAt: number;
  lastAt: number;
  /** 窗口内逐日 prompt 数,[窗口首日..末日] */
  days: number[];
  /** prompt 原文样本(截断/封顶,见 caliber) */
  promptTexts: string[];
  /** terminal = history.jsonl;web = 璇玑派发流水 */
  source: 'terminal' | 'web';
  /** 窗口内该会话的 token 成本(USD,按记录时间过滤) */
  costUsd: number;
}

export interface ReviewProject {
  /** basename 展示名(分类色键) */
  project: string;
  /** 真实绝对路径 */
  path: string;
  prompts: number;
  days: number[];
  costUsd: number;
  /** 窗口内 git commit 题目(--all --no-merges,封顶截取);非 git 目录为空 */
  commits: string[];
  sessions: ReviewSession[];
}

export interface WeeklyReview {
  range: { start: number; end: number; dayCount: number };
  totals: {
    prompts: number;
    sessions: number;
    projects: number;
    /** 有 ≥1 条 prompt 的自然日数 */
    activeDays: number;
    costUsd: number;
  };
  projects: ReviewProject[];
  /** 本周任务总结(worklog 卡):周报草稿的主料,回顾页也直接展示 */
  cards: WorklogCard[];
  caliber: Record<string, string>;
  computedAt: number;
}

/** 周报草稿(自有数据,SQLite) */
export interface WeeklyDraft {
  id: number;
  rangeStart: number;
  rangeEnd: number;
  status: 'running' | 'done' | 'error';
  content: string | null;
  error: string | null;
  model: string;
  /** 生成草稿的派发会话(可在看板跟踪/续接迭代) */
  sessionId: string | null;
  createdAt: number;
  finishedAt: number | null;
}

/**
 * 待办(自有数据,SQLite):临时想法的收集箱,不映射 ~/.claude 任何文件。
 * 生命周期 open → doing(已开工,挂上派发会话)→ done。完成有两条路:
 * 人手动勾,或挂靠会话被归档/从看板消失后由看板同步自动补上
 * (见 sessions.syncTodosWithBoard;会话仅仅跑完仍不算完——验收处置才算)。
 */
export interface Todo {
  id: number;
  title: string;
  /** 项目工作目录绝对路径;未指定为 null(开工时再选) */
  cwd: string | null;
  /** cwd 末段短名,列表展示用;未指定为 null */
  project: string | null;
  status: 'open' | 'doing' | 'done';
  /** 开工后绑定的派发会话,可直连只读回放 */
  sessionId: string | null;
  createdAt: number;
  /** 首次开工时间 */
  startedAt: number | null;
  doneAt: number | null;
  /** 来源:web 界面 / Raycast 等外部脚本(仅作展示,不影响行为) */
  source: 'web' | 'external';
}

export interface ModelUsage {
  model: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** token 量:inOut = in + out + cacheWrite(与统计条同口径),cacheRead 单列 */
export interface TokenTotals {
  inOut: number;
  cacheRead: number;
}

export interface SessionUsage {
  sessionId: string;
  title: string;
  byModel: ModelUsage[];
  totalCostUsd: number;
  totalTokens: TokenTotals;
}

export interface ProjectUsage {
  /** 编码目录名(~/.claude/projects 下),天然唯一,作稳定 key 用 */
  dir: string;
  /** 展示名:目录末段,重名时往前多带一段消歧 */
  project: string;
  byModel: ModelUsage[];
  totalCostUsd: number;
  totalTokens: TokenTotals;
  sessions: SessionUsage[];
}

// ---------- 定时任务(scheduled jobs,自有数据 SQLite) ----------

export type ScheduledJobKind = 'once' | 'cron';

/**
 * pending  待执行(排程未到点 / cron 等待下次)
 * running  已触发,派发会话进行中
 * blocked  会话卡在权限审批,挂起等用户处理(不计入熔断失败)
 * done     一次性:成功完成,终态;周期:本期成功,已回到 pending 等下一期
 * error    一次性:本次运行失败,终态
 * fused    周期:连续失败达阈值,调度已停止
 * missed   一次性:错过触发且超出补跑宽限期
 * canceled 用户取消(一次性)
 * paused   用户暂停(周期)
 */
export type ScheduledJobStatus =
  | 'pending'
  | 'running'
  | 'blocked'
  | 'done'
  | 'error'
  | 'fused'
  | 'missed'
  | 'canceled'
  | 'paused';

export interface ScheduledJob {
  id: string;
  kind: ScheduledJobKind;
  name: string;
  prompt: string;
  cwd: string;
  model: string | null;
  permissionMode: string;
  /** 单次运行预算上限(USD),null = 不限。软上限:回合结束后核对,超出记录但不能中途打断(SDK 未暴露增量成本流) */
  maxBudgetUsd: number | null;
  /** kind='once' 的计划执行时间(epoch ms) */
  runAt: number | null;
  /** kind='cron' 的 cron 表达式(croner 语法,Asia/Shanghai 时区) */
  cronExpr: string | null;
  status: ScheduledJobStatus;
  /** 连续失败计数:达 3 熔断(仅 cron 有意义) */
  consecutiveFailures: number;
  /** 最近一次触发产生的派发会话 id;前端「结果会话」跳转与只读回放的入口 */
  resultSessionId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  /** 下次触发时间(epoch ms),由 croner 计算回填,pending 态才有意义 */
  nextRunAt: number | null;
}

export interface ScheduledRun {
  id: number;
  jobId: string;
  /** 计划触发时间(epoch ms);错过/延迟触发时与 startedAt 存在差值 */
  scheduledFor: number;
  startedAt: number | null;
  finishedAt: number | null;
  status: 'running' | 'done' | 'error' | 'blocked' | 'missed';
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number | null;
  error: string | null;
}

// ============ 验收面板(Acceptance Runbook)============
// 设计与取舍见 wiki/tech/acceptance-runbook.md。
// 三层实体:模板(项目级骨架,自有 SQLite)→ 实例(一次交付的清单,worktree 内
// .xuanji/runbook.json)→ 运行态(点了按钮之后的事,自有 SQLite)。

export type RunbookItemType = 'service' | 'command' | 'request' | 'link' | 'cleanup';

/** 参数定义:命令里可变的那部分。会话预填 default,用户在面板上改 */
export interface RunbookParam {
  key: string;
  label: string;
  type: 'string' | 'date' | 'number' | 'boolean' | 'enum';
  required?: boolean;
  default?: string;
  /** type=enum 时的可选值 */
  options?: string[];
  description?: string;
  /** 给出则按 `<flag> <value>` 追加;命令里出现 {{key}} 占位符时改为原地插值 */
  flag?: string;
}

/** 就绪判定:service 从 running 转 ready 的依据 */
export type RunbookReadiness =
  | { kind: 'port'; port: number }
  | { kind: 'http'; url: string; timeoutSec?: number }
  | { kind: 'logPattern'; pattern: string };

export interface RunbookLink {
  title: string;
  url: string;
}

export interface RunbookItem {
  id: string;
  type: RunbookItemType;
  title: string;
  description?: string;
  /** 来源分级:template=用户确认入库过,点击即执行;session=会话本次生成,首次执行需确认 */
  origin: 'template' | 'session';
  command?: string;
  /** 相对 worktree 根;逃逸出 cwd 的路径在执行层拒绝 */
  cwd?: string;
  params?: RunbookParam[];
  env?: Record<string, string>;
  readiness?: RunbookReadiness;
  links?: RunbookLink[];
  stopCommand?: string;
  timeoutSec?: number;
  /** 软约束:依赖项未就绪时按钮置灰,不做自动编排 */
  dependsOn?: string[];
  // --- request 专用 ---
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  /** 自然语言预期要点,给人看的;不做自动断言(要断言就该进 vitest) */
  expect?: string;
  /** 命中执行层黑名单时由后端回填的拒绝原因(渲染时前置,不等点击才报错) */
  blockedReason?: string;
}

/** 项目级验收模板:一次沉淀长期复用,变的只有参数 */
export interface RunbookTemplate {
  id: string;
  /** 项目真实路径,与项目总览同源 */
  project: string;
  name: string;
  /** 每次编辑 +1;实例按版本锁定引用,模板后续编辑不回溯已交付清单 */
  version: number;
  status: 'draft' | 'active' | 'archived';
  /** agent 归纳生成的进 draft,用户界面确认后转 active */
  source: 'user' | 'agent';
  items: RunbookItem[];
  createdAt: number;
  updatedAt: number;
}

/** 一次交付的验收清单(worktree 内 .xuanji/runbook.json 的内容) */
export interface AcceptanceRunbook {
  schemaVersion: 1;
  /**
   * 清单归属的会话。面板只对这条会话渲染——清单是「某次交付」的产物而非项目常驻配置,
   * 不绑会话的话同一目录下的后续会话会一路继承上一次交付的清单(实测:项目里躺着一份
   * 旧清单,新会话刚问完版本号就弹出验收面板)。
   * 缺失时由后端按「写于本会话开始之后」认领并回写盖章(见 services/runbook.ts)。
   */
  sessionId?: string;
  templateRef?: { id: string; version: number };
  /** itemId → paramKey → 值,会话预填的本次默认 */
  paramValues?: Record<string, Record<string, string>>;
  /** 本次用不上的模板项 id(面板隐藏,非删除) */
  omitItems?: string[];
  /** 本次特有项(origin 恒为 session) */
  extraItems?: RunbookItem[];
  notes?: string;
}

/** 解析 + 模板实例化后交给前端的最终形态 */
export interface ResolvedRunbook {
  sessionId: string;
  cwd: string;
  templateName?: string;
  templateVersion?: number;
  notes?: string;
  items: RunbookItem[];
  /** 每项的当前运行态,itemId → run */
  runs: Record<string, RunbookRun>;
}

export type RunbookRunStatus = 'running' | 'ready' | 'exited' | 'failed' | 'stopped' | 'ok';

export interface RunbookRun {
  id: number;
  sessionId: string;
  itemId: string;
  /** 参数插值后的完整命令:审计与「用户点的到底是什么」的唯一事实 */
  resolvedCommand: string;
  status: RunbookRunStatus;
  pid: number | null;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  /** 输出落盘路径,面板 tail */
  logPath: string | null;
}
