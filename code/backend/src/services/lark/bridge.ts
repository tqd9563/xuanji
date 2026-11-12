/**
 * 飞书中控桥接:把派发会话的事件推成飞书卡片,把飞书里的消息与按钮点击翻译回派发操作。
 *
 * 设计要点(决策见 .planning/xuanji/findings.md,视觉见 DESIGN.md「飞书中控」):
 * - 只认绑定过的那一个人(owner)的**单聊**;其他人、群聊一律不回应。owner 只能经设置页生成的绑定码建立。
 * - 推送时机:从飞书发起的回合始终回推;其余只在 Mac 锁屏、且「通知」分区的范围与事件都开着时推。
 * - 卡片状态以本进程内存为准(登记表按 message_id 索引),重启即清空;但按钮值自带执行所需信息、
 *   「卡片 → 会话」映射与当前会话落库,所以重启后续接、选择、重试、引用回复照常可用,
 *   只有依赖进程内请求的(审批、提问、中断、完整回复)才显示「已失效」。
 * - 会话所有权铁律照旧:终端里仍开着的交互会话只读,飞书不能接管(canResume 判定)。
 */
import { readHistory, scanProjectDirs } from '../../adapters/claude-dir.js';
import {
  botInfo,
  consume,
  downloadResource,
  patchCard,
  sendCard,
  sendMarkdown,
  type BotInfo,
  type Consumer,
  type ConsumerState,
} from '../../adapters/lark-cli.js';
import { isScreenLocked } from '../../adapters/screen-lock.js';
import { config } from '../../config.js';
import type { Storage } from '../../storage/db.js';
import type { AgentSession, SessionState } from '../../types.js';
import {
  canResume,
  createDispatch,
  findDispatchBySessionId,
  getDispatch,
  onDispatchCreated,
  type DispatchEvent,
  type DispatchSession,
} from '../dispatch.js';
import { cachedModelCatalog } from '../models.js';
import { readPrefs } from '../prefs.js';
import { sessionReplay, sessionsBoard } from '../sessions.js';
import {
  clip,
  closedCard,
  dispatchedCard,
  errorCard,
  helpCard,
  infoCard,
  listCard,
  newFormCard,
  permCard,
  pickProjectCard,
  progressCard,
  questionCard,
  questionUsesButtons,
  routeCard,
  switchedCard,
  type ListRow,
  type PermView,
  type ProgressView,
  type QuestionSpec,
  type QuestionView,
  type SessionRef,
  type Step,
  attachmentsCard,
  type AttachmentView,
} from './cards.js';
import { parseAttachments, parseCommand, safeFileName, sniffImageType, splitMarkdown } from './parse.js';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { INLINE_IMAGE_MAX_BYTES, INLINE_IMAGE_MAX_COUNT, type InlineImage } from '../../types.js';

const OWNER_KEY = 'lark.owner';
/**
 * 卡片消息 → 会话 id 的映射与「当前会话」落库:后端重启后,引用回复旧卡片仍能续到原会话,
 * 当前会话也不丢(内存里的卡片登记表只管卡片状态,重启即清空)。映射封顶 MSG_SESSION_CAP 条。
 */
const MSG_SESSION_KEY = 'lark.msgsess';
const CURRENT_KEY = 'lark.current';
const MSG_SESSION_CAP = 500;
/** 当前会话的有效期:超过就不再默认发给它,先弹选择卡 */
const CURRENT_TTL_MS = 30 * 60_000;
/** 进度卡最短刷新间隔(飞书对单条消息的更新有频率限制) */
const PROGRESS_MIN_INTERVAL_MS = 2_000;
/**
 * 进度卡心跳:没有新步骤也按这个间隔刷一次,让「已用 xx」与当前步骤的耗时继续走。
 * 只靠事件驱动的话,一条跑几分钟的命令期间卡片一动不动,看着像死了(用户 2026-11-11 实测卡在 0s 后跳到 13s)。
 * 不逐秒刷新:每次刷新都是一次飞书 PATCH,多会话并发时会撞频控。节奏与 ~/feishu-claude 一致。
 */
const PROGRESS_HEARTBEAT_MS = 5_000;
const PROGRESS_TICK_MS = 500;
const BIND_TTL_MS = 10 * 60_000;
/** 挂起的附件多久没被用上就丢弃 */
const ATTACH_TTL_MS = 30 * 60_000;
/**
 * 飞书发来的附件落在这里:不进任何项目目录(免得污染仓库),按日期 / 消息分目录。
 * 图片同时以内联图片交给 Claude(与网页粘贴同一条通道),文件只给路径,由 Claude 自己读。
 */
export const LARK_INBOX = process.env.XUANJI_LARK_INBOX ?? join(homedir(), '.xuanji', 'lark-inbox');

interface Pending {
  images: InlineImage[];
  files: { name: string; path: string }[];
  at: number;
}
const DAY = 86_400_000;

interface Owner {
  openId: string;
  chatId: string;
  boundAt: number;
}

type CardEntry =
  | { kind: 'perm'; dispatchId: string; requestId: string; view: PermView }
  | { kind: 'question'; dispatchId: string; requestId: string; view: QuestionView }
  | { kind: 'progress'; dispatchId: string; view: ProgressView }
  | { kind: 'error'; dispatchId: string; ref: SessionRef; message: string; done: boolean }
  | { kind: 'switched'; sessionId: string }
  | { kind: 'list' }
  | { kind: 'newform'; done: boolean }
  | { kind: 'pick'; task: string; done: boolean }
  | { kind: 'route'; text: string; done: boolean };

/** 一张进行中的进度卡;ticker 负责节流刷新与心跳 */
interface Progress {
  messageId: string;
  view: ProgressView;
  lastPatch: number;
  dirty: boolean;
  ticker?: NodeJS.Timeout;
  patching?: Promise<unknown>;
}

/** 每个派发会话的桥接状态 */
interface Watch {
  s: DispatchSession;
  /** 本回合由飞书发起(或在飞书里审批 / 回答后接管):有进度卡,结束必回推 */
  larkTurn: boolean;
  /** 飞书发出、尚未回显的消息数:回显是区分「谁发起了这一轮」的唯一信号 */
  expectEcho: number;
  progress?: Progress;
  /** 本回合统计(无进度卡时也记,推送回合完成卡要用) */
  turnStart: number;
  /** 本回合的执行时间线(工具步 + 中途发言) */
  steps: Step[];
  contextPct?: number;
  stopping: boolean;
  /** 最近一条从飞书发出的用户消息:「重试上一条」用 */
  lastLarkText?: string;
  /** 最近一次审批请求的视图:「重发审批卡」用 */
  pendingPerm?: { requestId: string; view: PermView };
}

export interface LarkStatus {
  enabled: boolean;
  /** ok 已连接 / connecting / unset 未配置凭证 / fail 连接失败 / off 已停用 */
  state: 'ok' | 'connecting' | 'unset' | 'fail' | 'off';
  error?: string;
  bot?: { name: string };
  owner?: { openId: string; boundAt: number };
  bindCode?: { code: string; expiresAt: number };
  push: 'locked' | 'off';
  locked: boolean;
}

export class LarkBridge {
  private consumers: Consumer[] = [];
  private states: Record<string, ConsumerState> = {};
  private bot?: BotInfo;
  private configError?: string;
  private cards = new Map<string, CardEntry>();
  private watches = new Map<string, Watch>();
  private seen = new Set<string>();
  private selfResolved = new Set<string>();
  private current: { dispatchId?: string; sessionId?: string; at: number } | null = null;
  private bind: { code: string; expiresAt: number } | null = null;
  /** 收到、还没被下一句话带走的附件 */
  private pending: Pending | null = null;
  private unhook?: () => void;

  constructor(private storage: Storage) {
    // 重启后接回上次的当前会话(仍受 30 分钟有效期约束)
    try {
      const c = JSON.parse(storage.getMeta(CURRENT_KEY) ?? 'null') as { sessionId?: string; at?: number } | null;
      if (c?.sessionId && typeof c.at === 'number') this.current = { sessionId: c.sessionId, at: c.at };
    } catch {
      /* 坏值忽略 */
    }
  }

  private msgSessions(): Record<string, string> {
    try {
      return (JSON.parse(this.storage.getMeta(MSG_SESSION_KEY) ?? '{}') as Record<string, string>) ?? {};
    } catch {
      return {};
    }
  }

  /** 记下「这张卡属于哪个会话」;同一张卡后来才知道 sessionId 的(新派发)在拿到时补记 */
  private rememberMsg(messageId: string | undefined, sessionId: string | null | undefined) {
    if (!messageId || !sessionId) return;
    const m = this.msgSessions();
    if (m[messageId] === sessionId) return;
    delete m[messageId];
    m[messageId] = sessionId;
    const keys = Object.keys(m);
    for (const k of keys.slice(0, Math.max(0, keys.length - MSG_SESSION_CAP))) delete m[k];
    this.storage.setMeta(MSG_SESSION_KEY, JSON.stringify(m));
  }

  // ---------- 生命周期 ----------

  start() {
    this.unhook = onDispatchCreated((s) => this.watch(s));
    if (readPrefs(this.storage).lark.enabled) void this.connect();
  }

  /** 偏好改动后调用:按 enabled 连 / 断 */
  applyPrefs() {
    const on = readPrefs(this.storage).lark.enabled;
    if (on && !this.consumers.length) void this.connect();
    if (!on && this.consumers.length) this.disconnect();
  }

  async reconnect() {
    this.disconnect();
    if (readPrefs(this.storage).lark.enabled) await this.connect();
  }

  stop() {
    this.unhook?.();
    this.disconnect();
  }

  private async connect() {
    this.configError = undefined;
    this.states = { msg: { kind: 'connecting' }, card: { kind: 'connecting' } };
    const info = await botInfo();
    if (!info.ok || !info.data) {
      this.configError = info.error ?? '读取机器人信息失败';
      this.states = {};
      return;
    }
    this.bot = info.data;
    this.consumers = [
      consume('im.message.receive_v1', (e) => void this.onMessage(e).catch(logErr), (st) => (this.states.msg = st)),
      consume('card.action.trigger', (e) => void this.onAction(e).catch(logErr), (st) => (this.states.card = st)),
      // 机器人自定义菜单(输入框上方的快捷按钮):需在开放平台配置菜单并订阅该事件,没配时只是收不到,不影响连接状态
      consume('application.bot.menu_v6', (e) => void this.onMenu(e).catch(logErr), (st) => (this.states.menu = st)),
    ];
  }

  private disconnect() {
    for (const c of this.consumers) c.stop();
    this.consumers = [];
    this.states = {};
  }

  async status(): Promise<LarkStatus> {
    const prefs = readPrefs(this.storage).lark;
    const owner = this.owner();
    // 菜单事件是可选能力:只看收消息与卡片回调两路
    const st = [this.states.msg, this.states.card].filter((x): x is ConsumerState => !!x);
    let state: LarkStatus['state'];
    let error: string | undefined;
    if (!prefs.enabled) state = 'off';
    else if (this.configError) {
      state = /config|profile|credential|not found|未配置|app_id/i.test(this.configError) ? 'unset' : 'fail';
      error = this.configError;
    } else if (st.some((s) => s.kind === 'fail' && s.fatal)) {
      state = 'fail';
      error = (st.find((s) => s.kind === 'fail') as { error: string }).error;
    } else if (st.length && st.every((s) => s.kind === 'ready')) state = 'ok';
    else state = 'connecting';
    return {
      enabled: prefs.enabled,
      state,
      error,
      bot: this.bot ? { name: this.bot.app_name } : undefined,
      owner: owner ? { openId: owner.openId, boundAt: owner.boundAt } : undefined,
      bindCode: this.bind && this.bind.expiresAt > Date.now() ? this.bind : undefined,
      push: prefs.push,
      locked: await isScreenLocked(),
    };
  }

  // ---------- 绑定 ----------

  private owner(): Owner | null {
    const raw = this.storage.getMeta(OWNER_KEY);
    if (!raw) return null;
    try {
      const o = JSON.parse(raw) as Owner;
      return o.openId && o.chatId ? o : null;
    } catch {
      return null;
    }
  }

  createBindCode(): { code: string; expiresAt: number } {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.bind = { code, expiresAt: Date.now() + BIND_TTL_MS };
    return this.bind;
  }

  unbind() {
    this.storage.setMeta(OWNER_KEY, '');
    this.current = null;
  }

  async sendTest(): Promise<{ ok: boolean; error?: string }> {
    const owner = this.owner();
    if (!owner) return { ok: false, error: '还没有绑定飞书账号' };
    const r = await sendCard(owner.chatId, infoCard('测试卡片', '飞书中控连接正常。这张卡片由璇玑设置页「发送测试卡片」触发。'));
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  // ---------- 派发会话 → 飞书 ----------

  private watch(s: DispatchSession) {
    const w: Watch = { s, larkTurn: false, expectEcho: 0, turnStart: Date.now(), steps: [], stopping: false };
    this.watches.set(s.id, w);
    s.subscribe((e) => void this.onDispatchEvent(w, e).catch(logErr));
  }

  private ref(w: Watch): SessionRef {
    return this.refOf(w.s.cwd, w.s.displayName);
  }

  private refOf(cwd: string, name: string): SessionRef {
    const project = cwd.split('/').filter(Boolean).pop() ?? cwd;
    const idx = this.storage.assignPalette([project]).get(project);
    return { name: name || project, project, paletteIdx: idx };
  }

  /** 是否推送:飞书发起的回合必推;其余看偏好 + 「通知」开关 + 锁屏 */
  private async shouldPush(w: Watch, kind: 'blocked' | 'turnEnd' | 'error'): Promise<boolean> {
    const owner = this.owner();
    if (!owner || !this.consumers.length) return false;
    if (w.larkTurn) return true;
    const p = readPrefs(this.storage);
    if (!p.lark.enabled || p.lark.push === 'off') return false;
    if (!p.notify.dispatched || !p.notify[kind]) return false;
    return isScreenLocked();
  }

  private async push(card: object, entry?: CardEntry): Promise<string | undefined> {
    const owner = this.owner();
    if (!owner) return undefined;
    const r = await sendCard(owner.chatId, card);
    if (!r.ok || !r.data?.message_id) {
      console.error('[xuanji] lark send failed:', r.error);
      return undefined;
    }
    if (entry) {
      this.cards.set(r.data.message_id, entry);
      const sid = 'dispatchId' in entry ? getDispatch(entry.dispatchId)?.sessionId : entry.kind === 'switched' ? entry.sessionId : undefined;
      this.rememberMsg(r.data.message_id, sid);
    }
    return r.data.message_id;
  }

  private async onDispatchEvent(w: Watch, e: DispatchEvent) {
    switch (e.ev) {
      case 'user-echo': {
        if (w.expectEcho > 0) {
          w.expectEcho--;
          return;
        }
        // 网页端发起了新一轮:飞书不再跟进度
        if (w.progress) await this.finishProgress(w, 'stopped');
        w.larkTurn = false;
        this.resetTurn(w);
        return;
      }
      case 'tool':
        w.steps.push({ kind: 'tool', id: e.id, name: e.name, detail: e.input, status: 'running', startedAt: Date.now() });
        this.trimSteps(w);
        this.markDirty(w);
        return;
      case 'tool-result': {
        const st = w.steps.find((x) => x.id === e.id);
        if (st) {
          st.status = e.isError ? 'error' : 'ok';
          st.endedAt = Date.now();
          this.markDirty(w);
        }
        return;
      }
      case 'assistant':
        // 回合中途的发言也进时间线;最后一段就是正文,完成卡里会被剔掉
        if (e.text.trim()) {
          w.steps.push({ kind: 'text', detail: e.text, status: 'ok', startedAt: Date.now(), endedAt: Date.now() });
          this.trimSteps(w);
          this.markDirty(w);
        }
        return;
      case 'context':
        w.contextPct = e.pct;
        return;
      case 'permission-request': {
        const view: PermView = {
          ref: this.ref(w),
          tool: e.toolName,
          title: e.title,
          input: e.input,
          hasAlways: e.hasSuggestions,
          state: 'pending',
        };
        w.pendingPerm = { requestId: e.requestId, view };
        if (await this.shouldPush(w, 'blocked')) {
          await this.push(permCard(view), { kind: 'perm', dispatchId: w.s.id, requestId: e.requestId, view });
        }
        return;
      }
      case 'question': {
        const view: QuestionView = { ref: this.ref(w), questions: e.questions as QuestionSpec[], state: 'pending' };
        if (await this.shouldPush(w, 'blocked')) {
          await this.push(questionCard(view), { kind: 'question', dispatchId: w.s.id, requestId: e.requestId, view });
        }
        return;
      }
      case 'permission-resolved':
      case 'question-answered': {
        if (w.pendingPerm?.requestId === e.requestId) w.pendingPerm = undefined;
        if (this.selfResolved.delete(e.requestId)) return;
        // 网页端先处理了:把飞书里对应的卡片同步成「已在璇玑网页处理」
        for (const [mid, c] of this.cards) {
          if (c.kind === 'perm' && c.requestId === e.requestId && c.view.state === 'pending') {
            c.view = { ...c.view, state: 'web', resolvedAt: Date.now() };
            await patchCard(mid, permCard(c.view));
          } else if (c.kind === 'question' && c.requestId === e.requestId && c.view.state === 'pending') {
            c.view = { ...c.view, state: 'web', answers: e.ev === 'question-answered' ? e.answers : undefined };
            await patchCard(mid, questionCard(c.view));
          }
        }
        return;
      }
      case 'result': {
        const view: ProgressView = {
          ref: this.ref(w),
          state: 'done',
          steps: [...w.steps],
          elapsedMs: e.durationMs || Date.now() - w.turnStart,
          contextPct: e.contextPct,
          reply: w.s.lastAssistantText,
          costUsd: e.costUsd,
        };
        if (w.progress) {
          if (w.stopping) await this.finishProgress(w, 'stopped');
          else await this.finishProgress(w, 'done', view);
        } else if (!w.stopping && (await this.shouldPush(w, 'turnEnd'))) {
          await this.push(progressCard(view), { kind: 'progress', dispatchId: w.s.id, view });
        }
        w.larkTurn = false;
        this.resetTurn(w);
        return;
      }
      case 'error': {
        if (w.progress) await this.finishProgress(w, 'stopped');
        if (w.larkTurn || (await this.shouldPush(w, 'error'))) {
          const ref = this.ref(w);
          await this.push(errorCard(ref, e.message, 'pending', { sessionId: w.s.sessionId ?? undefined, text: w.lastLarkText }), {
            kind: 'error',
            dispatchId: w.s.id,
            ref,
            message: e.message,
            done: false,
          });
        }
        w.larkTurn = false;
        this.resetTurn(w);
        return;
      }
      default:
        return;
    }
  }

  private resetTurn(w: Watch) {
    w.turnStart = Date.now();
    w.steps = [];
    w.stopping = false;
  }

  /** 时间线封顶:完成卡的执行过程面板最多看 60 步,内存里多留一点余量即可 */
  private trimSteps(w: Watch) {
    if (w.steps.length > 80) w.steps.splice(0, w.steps.length - 80);
  }

  private markDirty(w: Watch) {
    if (w.progress) w.progress.dirty = true;
  }

  /** 开一张进度卡(飞书发起的回合 / 在飞书里审批、回答、重试之后) */
  private async startProgress(w: Watch) {
    if (w.progress) return;
    w.larkTurn = true;
    const view: ProgressView = { ref: this.ref(w), state: 'running', steps: w.steps, elapsedMs: 0 };
    const p: Progress = { messageId: '', view, lastPatch: Date.now(), dirty: false };
    w.progress = p;
    const mid = await this.push(progressCard(view), { kind: 'progress', dispatchId: w.s.id, view });
    if (w.progress !== p) return;
    p.messageId = mid ?? '';
    p.lastPatch = Date.now();
    if (p.messageId) p.ticker = setInterval(() => this.tickProgress(w, p), PROGRESS_TICK_MS);
  }

  /** 有新步骤满 2 秒推一次;没有新步骤满 5 秒也推一次(心跳)。上一次 PATCH 未返回时不叠加 */
  tickProgress(w: Watch, p: Progress, now = Date.now()) {
    if (w.progress !== p || !p.messageId || p.patching) return;
    const since = now - p.lastPatch;
    if (!((p.dirty && since >= PROGRESS_MIN_INTERVAL_MS) || since >= PROGRESS_HEARTBEAT_MS)) return;
    p.dirty = false;
    p.lastPatch = now;
    p.view = { ...p.view, steps: [...w.steps], elapsedMs: now - w.turnStart, contextPct: w.contextPct, now };
    p.patching = patchCard(p.messageId, progressCard(p.view)).finally(() => {
      p.patching = undefined;
    });
  }

  private async finishProgress(w: Watch, state: 'done' | 'stopped', done?: ProgressView) {
    const p = w.progress;
    if (!p) return;
    w.progress = undefined;
    if (p.ticker) clearInterval(p.ticker);
    await p.patching?.catch(() => {});
    const view: ProgressView =
      state === 'done' && done
        ? done
        : { ...p.view, state: 'stopped', steps: [...w.steps], elapsedMs: Date.now() - w.turnStart, contextPct: w.contextPct };
    if (!p.messageId) return;
    this.cards.set(p.messageId, { kind: 'progress', dispatchId: w.s.id, view });
    this.rememberMsg(p.messageId, w.s.sessionId);
    await patchCard(p.messageId, progressCard(view));
  }

  // ---------- 飞书 → 璇玑:消息 ----------

  private async onMessage(e: Record<string, unknown>) {
    const mid = String(e.message_id ?? '');
    if (!mid || this.seen.has(mid)) return;
    this.seen.add(mid);
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
    if (e.chat_type !== 'p2p') return;
    const sender = String(e.sender_id ?? '');
    const chatId = String(e.chat_id ?? '');
    const content = String(e.content ?? '').trim();
    const owner = this.owner();

    if (!owner) {
      const m = /^\/bind\s+(\d{6})$/.exec(content);
      if (m && this.bind && this.bind.expiresAt > Date.now() && m[1] === this.bind.code) {
        this.storage.setMeta(OWNER_KEY, JSON.stringify({ openId: sender, chatId, boundAt: Date.now() } satisfies Owner));
        this.bind = null;
        await sendCard(chatId, infoCard('绑定成功', '之后只有你能在这里操作璇玑。Mac 锁屏时,需要你处理的事会推到这里;发 /help 看用法。', 'green'));
      }
      return; // 未绑定时对任何人都不回应,不暴露机器人的存在与用法
    }
    if (sender !== owner.openId) return;
    if (chatId !== owner.chatId) this.storage.setMeta(OWNER_KEY, JSON.stringify({ ...owner, chatId }));

    const type = String(e.message_type ?? '');
    if (!['text', 'post', 'image', 'file'].includes(type)) {
      await sendMarkdown(owner.chatId, '暂不支持语音、视频和表情;文字、图片、文件都可以');
      return;
    }
    const att = parseAttachments(content);
    if (att.images.length || att.files.length) {
      const got = await this.fetchAttachments(mid, att.images, att.files);
      if (!got) return;
      // 只有附件没有话:先挂起,等下一句话带上;富文本里图文都有:直接当一条消息发
      if (!att.text) {
        await this.push(attachmentsCard(got));
        return;
      }
      await this.routeText(att.text, String(e.reply_to ?? '') || undefined);
      return;
    }
    const cmd = parseCommand(content);
    switch (cmd.kind) {
      case 'help':
        await this.push(helpCard(this.bot?.app_name ?? '璇玑', this.currentName()));
        return;
      case 'bind':
        await sendMarkdown(owner.chatId, '已经绑定过了。要换账号,先在璇玑设置 › 飞书里解除绑定');
        return;
      case 'ls':
        await this.sendList(cmd.all);
        return;
      case 'stop':
        await this.stopCurrent();
        return;
      case 'new':
        await this.newTask(cmd.project, cmd.task);
        return;
      case 'unknown':
        await sendMarkdown(owner.chatId, `不认识的命令 **${clip(cmd.name, 20)}**,发 /help 看看能做什么`);
        return;
      case 'text':
        await this.routeText(cmd.text, String(e.reply_to ?? '') || undefined);
        return;
    }
  }

  /** 下载附件并挂起;失败时回一句原因(缺权限时点名要开哪个) */
  private async fetchAttachments(messageId: string, images: string[], files: { key: string; name: string }[]): Promise<AttachmentView[] | null> {
    const owner = this.owner()!;
    const day = new Date().toISOString().slice(0, 10);
    const dir = join(LARK_INBOX, day, messageId);
    mkdirSync(dir, { recursive: true });
    if (!this.pending || Date.now() - this.pending.at > ATTACH_TTL_MS) this.pending = { images: [], files: [], at: Date.now() };
    const p = this.pending;
    p.at = Date.now();
    const views: AttachmentView[] = [];
    const items = [
      ...images.map((k, i) => ({ key: k, name: `image-${i + 1}`, type: 'image' as const })),
      ...files.map((f) => ({ key: f.key, name: safeFileName(f.name), type: 'file' as const })),
    ];
    for (const it of items) {
      const r = await downloadResource(messageId, it.key, it.type, dir, it.name);
      if (!r.ok) {
        const scope = /scope|权限/i.test(r.error ?? '');
        await sendMarkdown(
          owner.chatId,
          scope
            ? '下载附件失败:机器人缺少读取消息的权限。请在飞书开放平台给这个应用开通 **im:message:readonly** 并发布新版本'
            : `下载附件失败:${clip(r.error ?? '未知错误', 200)}`,
        );
        return null;
      }
      // lark-cli 会按 Content-Type 补扩展名,实际落盘名以目录里出现的为准
      const path = resolveSaved(dir, it.name);
      if (!path) {
        await sendMarkdown(owner.chatId, '下载附件失败:没有找到落盘的文件');
        return null;
      }
      const buf = readFileSync(path);
      const mt = it.type === 'image' ? sniffImageType(buf) : null;
      if (mt && buf.length <= INLINE_IMAGE_MAX_BYTES && p.images.length < INLINE_IMAGE_MAX_COUNT) {
        p.images.push({ media_type: mt, data: buf.toString('base64') });
      } else {
        // 超限或格式不受支持的图片也退化成文件路径,Claude 照样能读
        p.files.push({ name: path.split('/').pop()!, path });
      }
      views.push({ name: it.type === 'image' ? `图片 ${p.images.length + p.files.length}` : path.split('/').pop()!, kind: it.type, bytes: buf.length });
    }
    return views;
  }

  /** 取走挂起的附件:图片原样,文件拼成一段路径说明附在消息末尾 */
  private takePending(text: string): { text: string; images: InlineImage[] } {
    const p = this.pending;
    this.pending = null;
    if (!p || Date.now() - p.at > ATTACH_TTL_MS) return { text, images: [] };
    const note = p.files.length
      ? `\n\n附件(飞书发来,已保存在本机,可直接读取):\n${p.files.map((f) => `- ${f.name}: ${f.path}`).join('\n')}`
      : '';
    return { text: text + note, images: p.images };
  }

  private currentName(): string | undefined {
    const t = this.resolveCurrent();
    return t?.name;
  }

  /** 当前会话解析为可用的目标;过期返回 null */
  private resolveCurrent(): { sessionId?: string; dispatchId?: string; name: string } | null {
    const c = this.current;
    if (!c) return null;
    const d = c.dispatchId ? getDispatch(c.dispatchId) : c.sessionId ? findDispatchBySessionId(c.sessionId) : undefined;
    const sessionId = d?.sessionId ?? c.sessionId;
    return { sessionId: sessionId ?? undefined, dispatchId: d?.id, name: d?.displayName ?? sessionId?.slice(0, 8) ?? '新会话' };
  }

  private setCurrent(t: { dispatchId?: string; sessionId?: string }) {
    this.current = { ...t, at: Date.now() };
    const sid = t.sessionId ?? (t.dispatchId ? getDispatch(t.dispatchId)?.sessionId : undefined);
    if (sid) this.storage.setMeta(CURRENT_KEY, JSON.stringify({ sessionId: sid, at: this.current.at }));
  }

  private async routeText(textIn: string, replyTo?: string) {
    // 1) 引用回复:发给那张卡片的会话
    if (replyTo) {
      const c = this.cards.get(replyTo);
      if (c?.kind === 'question' && c.view.state === 'pending') {
        return this.answerQuestion(replyTo, c, Object.fromEntries(c.view.questions.map((q) => [q.question, textIn])));
      }
      const target = c ? this.targetOfCard(c) : undefined;
      if (target) return this.sendTo(target, textIn);
      // 登记表里没有(后端重启过):按落库的「卡片 → 会话」映射续接
      const sid = this.msgSessions()[replyTo];
      if (sid) return this.sendTo({ sessionId: sid }, textIn);
    }
    // 2) 当前会话(30 分钟内)
    if (this.current && Date.now() - this.current.at < CURRENT_TTL_MS) {
      const t = this.resolveCurrent();
      if (t && (t.dispatchId || t.sessionId)) return this.sendTo(t, textIn);
    }
    // 3) 弹选择卡
    const board = await sessionsBoard(this.storage);
    const opts = [...board.columns.blocked, ...board.columns.running, ...board.columns.review, ...board.columns.idle]
      .filter((s) => !s.readonly)
      .slice(0, 5)
      .map((s) => ({ sessionId: s.sessionId, ref: this.refOf(s.cwd, s.name) }));
    await this.push(routeCard(textIn, opts), { kind: 'route', text: textIn, done: false });
  }

  private targetOfCard(c: CardEntry): { dispatchId?: string; sessionId?: string } | undefined {
    if ('dispatchId' in c) return { dispatchId: c.dispatchId, sessionId: getDispatch(c.dispatchId)?.sessionId ?? undefined };
    if (c.kind === 'switched') return { sessionId: c.sessionId };
    return undefined;
  }

  /** 把一句话送进目标会话:进程内存活的直接 send,否则按所有权规则冷启动续接 */
  private async sendTo(t: { dispatchId?: string; sessionId?: string }, textIn: string) {
    const owner = this.owner()!;
    let d = t.dispatchId ? getDispatch(t.dispatchId) : undefined;
    if (!d && t.sessionId) d = findDispatchBySessionId(t.sessionId);
    if (!d) {
      if (!t.sessionId) {
        await sendMarkdown(owner.chatId, '这个会话已经不在了,发 /ls 重新选择');
        return;
      }
      const check = await canResume(t.sessionId);
      if (!check.ok) {
        await sendMarkdown(owner.chatId, `${check.reason ?? '不能续接这个会话'}`);
        return;
      }
      const card = await this.boardCard(t.sessionId);
      if (!card) {
        await sendMarkdown(owner.chatId, '找不到这个会话的工作目录,发 /ls 重新选择');
        return;
      }
      const prefs = readPrefs(this.storage);
      d = createDispatch(this.storage, {
        cwd: card.cwd,
        resume: t.sessionId,
        fork: check.fork ?? false,
        name: card.name,
        permissionMode: prefs.perm,
      });
    }
    const w = this.watches.get(d.id);
    this.setCurrent({ dispatchId: d.id, sessionId: d.sessionId ?? t.sessionId });
    if (w) {
      w.lastLarkText = textIn;
      w.expectEcho++;
      this.resetTurn(w);
      await this.startProgress(w);
    }
    const out = this.takePending(textIn);
    d.send(out.text, out.images);
  }

  private async boardCard(sessionId: string): Promise<AgentSession | undefined> {
    const board = await sessionsBoard(this.storage);
    for (const col of Object.values(board.columns)) {
      const hit = col.find((s) => s.sessionId === sessionId);
      if (hit) return hit;
    }
    const rec = this.storage.allDispatches().find((r) => r.sessionId === sessionId);
    if (rec) return { sessionId, cwd: rec.cwd, name: rec.name ?? '' } as AgentSession;
    return undefined;
  }

  private async stopCurrent() {
    const owner = this.owner()!;
    const t = this.resolveCurrent();
    const d = t?.dispatchId ? getDispatch(t.dispatchId) : undefined;
    if (!t) {
      await sendMarkdown(owner.chatId, '还没有当前会话,先发 /ls 选一个');
      return;
    }
    if (!d || d.state !== 'working') {
      await sendMarkdown(owner.chatId, `「${clip(t.name, 30)}」当前没有在运行`);
      return;
    }
    await this.interrupt(d);
    await sendMarkdown(owner.chatId, `已中断「${clip(t.name, 30)}」`);
  }

  private async interrupt(d: DispatchSession) {
    const w = this.watches.get(d.id);
    if (w) w.stopping = true;
    if (w?.progress) await this.finishProgress(w, 'stopped');
    await d.interrupt();
  }

  private async sendList(all: boolean) {
    const board = await sessionsBoard(this.storage);
    const ago = (t?: number) => (t ? relTime(Date.now() - t) : '');
    const kindOf = (col: string, s: AgentSession): ListRow['kind'] =>
      s.readonly ? 'terminal' : col === 'blocked' ? 'blocked' : col === 'running' ? 'running' : col === 'done' ? 'done' : 'idle';
    const rows: ListRow[] = [];
    const cols: SessionState[] = ['blocked', 'running', 'review', 'idle', ...(all ? (['done'] as const) : [])];
    for (const col of cols) {
      for (const s of board.columns[col]) {
        rows.push({
          sessionId: s.sessionId,
          ref: this.refOf(s.cwd, s.name),
          detail: s.needs ?? s.detail ?? (col === 'review' ? '回合完成 · 待验收' : col === 'idle' ? '空闲' : ''),
          ago: ago(s.lastOutputAt ?? s.startedAt),
          at: s.lastOutputAt ?? s.startedAt,
          kind: kindOf(col, s),
        });
      }
    }
    // 截断前先排好:状态组顺序不变,组内按最近活动倒序,超出上限时丢的是最久没动的
    const rank: Record<ListRow['kind'], number> = { blocked: 0, running: 1, idle: 2, terminal: 2, done: 3 };
    rows.sort((a, b) => rank[a.kind] - rank[b.kind] || (b.at ?? 0) - (a.at ?? 0));
    const MAX = 15;
    const t = this.resolveCurrent();
    await this.push(
      listCard(rows.slice(0, MAX), t?.sessionId ?? null, { all, truncated: Math.max(0, rows.length - MAX), currentName: t?.name }),
      { kind: 'list' },
    );
  }

  private async lastReply(sessionId: string): Promise<string | undefined> {
    const live = findDispatchBySessionId(sessionId)?.lastAssistantText;
    if (live) return live;
    const replay = await sessionReplay(sessionId).catch(() => null);
    const ev = replay?.events ?? [];
    for (let i = ev.length - 1; i >= 0; i--) {
      const x = ev[i]!;
      if (x.kind === 'assistant' && x.text.trim()) return x.text;
    }
    return undefined;
  }

  // ---------- 派发 ----------

  private async projects(): Promise<{ name: string; path: string }[]> {
    const [dirs, history] = await Promise.all([
      scanProjectDirs(config.claudeDir),
      readHistory(config.claudeDir, { sinceMs: Date.now() - 90 * DAY }),
    ]);
    const last = new Map<string, number>();
    for (const h of history) last.set(h.project, Math.max(last.get(h.project) ?? 0, h.timestamp));
    for (const r of this.storage.allDispatches()) last.set(r.cwd, Math.max(last.get(r.cwd) ?? 0, r.createdAt));
    return dirs
      .filter((p) => p.exists && !config.projectNoisePatterns.some((re) => re.test(p.path) || re.test(p.encodedDir)))
      .map((p) => ({ name: p.path.split('/').filter(Boolean).pop() ?? p.path, path: p.path, t: last.get(p.path) ?? 0 }))
      .sort((a, b) => b.t - a.t)
      .map(({ name, path }) => ({ name, path }));
  }

  private models(): { id: string; label: string }[] {
    const cat = cachedModelCatalog(this.storage);
    const list = (cat?.models ?? []).map((m) => ({ id: m.value, label: m.displayName }));
    return list.length ? list : [{ id: 'default', label: '默认' }];
  }

  private async newTask(kw?: string, task?: string) {
    const projects = await this.projects();
    const prefs = readPrefs(this.storage);
    const models = this.models();
    const defaultModel = prefs.model && models.some((m) => m.id === prefs.model) ? prefs.model : models[0]!.id;
    if (!kw || !task) {
      const hits = kw ? matchProjects(projects, kw) : [];
      await this.push(
        newFormCard({ projects, models, defaultModel, presetProject: hits.length === 1 ? hits[0]!.path : undefined }),
        { kind: 'newform', done: false },
      );
      return;
    }
    const hits = matchProjects(projects, kw);
    if (hits.length === 1) return this.dispatchNew(hits[0]!.path, task, defaultModel);
    if (hits.length > 1) {
      await this.push(pickProjectCard(kw, task, hits), { kind: 'pick', task, done: false });
      return;
    }
    await sendMarkdown(this.owner()!.chatId, `没有找到项目「${clip(kw, 30)}」。发 **/new** 从列表里选`);
  }

  private async dispatchNew(cwd: string, task: string, model: string, formMessageId?: string) {
    const prefs = readPrefs(this.storage);
    const name = clip(task.replace(/\s+/g, ' ').trim(), 20);
    const d = createDispatch(this.storage, { cwd, name, permissionMode: prefs.perm, model: model === 'default' ? undefined : model });
    const ref = this.refOf(cwd, name);
    const label = this.models().find((m) => m.id === model)?.label ?? model;
    if (formMessageId) {
      this.cards.set(formMessageId, { kind: 'newform', done: true });
      await patchCard(formMessageId, dispatchedCard(ref, task, label));
    } else {
      await this.push(dispatchedCard(ref, task, label));
    }
    const w = this.watches.get(d.id);
    this.setCurrent({ dispatchId: d.id });
    if (w) {
      w.lastLarkText = task;
      w.expectEcho++;
      await this.startProgress(w);
    }
    const out = this.takePending(task);
    d.send(out.text, out.images);
  }

  // ---------- 飞书 → 璇玑:机器人菜单 ----------

  /**
   * 菜单 event_key 与命令一一对应:ls / ls_all / new / stop / help。
   * 菜单点击不会在聊天里留下用户消息,直接回卡片即可。
   */
  private async onMenu(e: Record<string, unknown>) {
    const owner = this.owner();
    const op = String(e.operator_open_id ?? e.operator_id ?? '');
    if (!owner || op !== owner.openId) return;
    const id = String(e.event_id ?? '');
    if (id) {
      if (this.seen.has(id)) return;
      this.seen.add(id);
    }
    switch (String(e.event_key ?? '')) {
      case 'ls':
        return this.sendList(false);
      case 'ls_all':
        return this.sendList(true);
      case 'new':
        return this.newTask();
      case 'stop':
        return this.stopCurrent();
      case 'help':
        await this.push(helpCard(this.bot?.app_name ?? '璇玑', this.currentName()));
        return;
      default:
        return;
    }
  }

  // ---------- 飞书 → 璇玑:卡片按钮 ----------

  private async onAction(e: Record<string, unknown>) {
    const owner = this.owner();
    if (!owner || String(e.operator_id ?? '') !== owner.openId) return;
    const mid = String(e.message_id ?? '');
    const entry = this.cards.get(mid);
    let value: Record<string, unknown> = {};
    try {
      value = typeof e.action_value === 'string' && e.action_value ? JSON.parse(e.action_value) : {};
    } catch {
      /* 非 JSON 值按空处理 */
    }
    let form: Record<string, unknown> = {};
    try {
      form = typeof e.form_value === 'string' && e.form_value ? JSON.parse(e.form_value) : {};
    } catch {
      /* 同上 */
    }
    const name = String(e.action_name ?? '');
    if (this.current) this.current.at = Date.now();
    const a = String(value.a ?? (name === 'new_submit' ? 'new-submit' : name === 'q_submit' ? 'q-submit' : ''));
    if (!entry) {
      // 后端重启过:登记表里没有这张卡,按按钮自带的信息尽量照常执行
      await this.onStatelessAction(mid, a, value, form);
      return;
    }

    switch (entry.kind) {
      case 'perm': {
        if (a !== 'perm') return;
        const d = getDispatch(entry.dispatchId);
        if (entry.view.state !== 'pending' || !d) {
          entry.view = { ...entry.view, state: entry.view.state === 'pending' ? 'gone' : entry.view.state };
          await patchCard(mid, permCard(entry.view));
          return;
        }
        const decision = value.d === 'always' ? 'always' : value.d === 'deny' ? 'deny' : 'allow';
        entry.view = { ...entry.view, state: decision, resolvedAt: Date.now() };
        this.selfResolved.add(entry.requestId);
        await patchCard(mid, permCard(entry.view));
        const w = this.watches.get(d.id);
        this.setCurrent({ dispatchId: d.id, sessionId: d.sessionId ?? undefined });
        d.resolvePermission(entry.requestId, decision);
        if (w) await this.startProgress(w);
        return;
      }
      case 'question': {
        if (entry.view.state !== 'pending' || !getDispatch(entry.dispatchId)) {
          if (entry.view.state === 'pending') {
            entry.view = { ...entry.view, state: 'gone' };
            await patchCard(mid, questionCard(entry.view));
          }
          return;
        }
        const qs = entry.view.questions;
        let answers: Record<string, string>;
        if (a === 'q-pick' && questionUsesButtons(qs)) {
          const opt = qs[0]!.options[Number(value.i)];
          if (!opt) return;
          answers = { [qs[0]!.question]: opt.label };
        } else if (a === 'q-submit') {
          answers = {};
          qs.forEach((q, qi) => {
            if (q.multiSelect) {
              const picked = q.options.filter((_, oi) => form[`q${qi}_o${oi}`] === true).map((o) => o.label);
              if (picked.length) answers[q.question] = picked.join(', ');
            } else {
              const oi = Number(form[`q${qi}`]);
              const opt = q.options[oi];
              if (opt) answers[q.question] = opt.label;
            }
          });
          if (Object.keys(answers).length < qs.length) {
            await sendMarkdown(owner.chatId, '每个问题至少选一项再提交');
            return;
          }
        } else return;
        return this.answerQuestion(mid, entry, answers);
      }
      case 'progress': {
        const d = getDispatch(entry.dispatchId);
        if (a === 'stop') {
          if (d && entry.view.state === 'running') await this.interrupt(d);
          return;
        }
        const reply = entry.view.reply;
        if (a === 'full' && entry.view.state === 'done' && !entry.view.fullSent && reply) {
          entry.view = { ...entry.view, fullSent: true };
          await patchCard(mid, progressCard(entry.view));
          for (const chunk of splitMarkdown(reply, 3500)) await sendMarkdown(owner.chatId, chunk);
        }
        return;
      }
      case 'error': {
        if (a !== 'retry' || entry.done) return;
        const w = this.watches.get(entry.dispatchId);
        const textIn = w?.lastLarkText ?? '继续';
        entry.done = true;
        await patchCard(mid, errorCard(entry.ref, entry.message, 'retried'));
        const d = getDispatch(entry.dispatchId);
        await this.sendTo({ dispatchId: entry.dispatchId, sessionId: d?.sessionId ?? undefined }, textIn);
        return;
      }
      case 'list': {
        const sid = String(value.s ?? '');
        if (a === 'focus' && sid) return this.focus(sid);
        if (a === 'resend' && sid) return this.resend(sid);
        return;
      }
      case 'newform': {
        if (entry.done) return;
        if (a === 'new-cancel') {
          entry.done = true;
          await patchCard(mid, closedCard('已取消派发', '已取消'));
          return;
        }
        if (a === 'new-submit') {
          const cwd = String(form.proj ?? '');
          const task = String(form.task ?? '').trim();
          if (!cwd || !task) {
            await sendMarkdown(owner.chatId, '项目和任务描述都要填');
            return;
          }
          entry.done = true;
          await this.dispatchNew(cwd, task, String(form.model ?? 'default'), mid);
        }
        return;
      }
      case 'pick': {
        if (a !== 'pick' || entry.done) return;
        entry.done = true;
        const path = String(value.p ?? '');
        await patchCard(mid, closedCard('已选择项目', `已选 ${path.split('/').pop()},正在派发`));
        const prefs = readPrefs(this.storage);
        const models = this.models();
        await this.dispatchNew(path, entry.task, prefs.model && models.some((m) => m.id === prefs.model) ? prefs.model : models[0]!.id);
        return;
      }
      case 'route': {
        if (entry.done) return;
        if (a === 'route') {
          const sid = String(value.s ?? '');
          entry.done = true;
          const card = await this.boardCard(sid);
          await patchCard(mid, closedCard('已发送', `已发给「${clip(card?.name ?? sid.slice(0, 8), 30)}」,并设为当前会话`));
          await this.sendTo({ sessionId: sid }, entry.text);
        } else if (a === 'route-new') {
          entry.done = true;
          await patchCard(mid, closedCard('已发送', '作为新任务派发'));
          await this.newTask();
        }
        return;
      }
      default:
        return;
    }
  }

  /** 「续接」:切换当前会话并推一张带上一轮摘要的回执 */
  private async focus(sid: string) {
    const d = findDispatchBySessionId(sid);
    this.setCurrent({ dispatchId: d?.id, sessionId: sid });
    const card = await this.boardCard(sid);
    const ref = this.refOf(card?.cwd ?? d?.cwd ?? '', card?.name ?? d?.displayName ?? '');
    await this.push(switchedCard(ref, await this.lastReply(sid)), { kind: 'switched', sessionId: sid });
  }

  private async resend(sid: string) {
    const d = findDispatchBySessionId(sid);
    const w = d ? this.watches.get(d.id) : undefined;
    if (w?.pendingPerm) {
      const { requestId, view } = w.pendingPerm;
      await this.push(permCard(view), { kind: 'perm', dispatchId: w.s.id, requestId, view });
    } else {
      await sendMarkdown(this.owner()!.chatId, '这个会话现在没有在等审批(或审批不在璇玑里,如终端会话)');
    }
  }

  /**
   * 登记表里找不到卡片时的兜底:凡是按钮值自带足够信息的动作照常执行;
   * 依赖进程内状态的(审批、提问、中断、完整回复)才说明已失效——那些请求随重启一起结束了。
   */
  private async onStatelessAction(mid: string, a: string, value: Record<string, unknown>, form: Record<string, unknown>) {
    const sid = typeof value.s === 'string' ? value.s : '';
    const t = typeof value.t === 'string' ? value.t : '';
    switch (a) {
      case 'focus':
        if (sid) return this.focus(sid);
        break;
      case 'resend':
        if (sid) return this.resend(sid);
        break;
      case 'route':
        if (sid && t) {
          const card = await this.boardCard(sid);
          await patchCard(mid, closedCard('已发送', `已发给「${clip(card?.name ?? sid.slice(0, 8), 30)}」,并设为当前会话`));
          return this.sendTo({ sessionId: sid }, t);
        }
        break;
      case 'route-new':
        await patchCard(mid, closedCard('已发送', '作为新任务派发'));
        return this.newTask();
      case 'pick': {
        const path = typeof value.p === 'string' ? value.p : '';
        if (path && t) {
          await patchCard(mid, closedCard('已选择项目', `已选 ${path.split('/').pop()},正在派发`));
          return this.dispatchNew(path, t, this.defaultModel());
        }
        break;
      }
      case 'new-submit': {
        const cwd = String(form.proj ?? '');
        const task = String(form.task ?? '').trim();
        if (cwd && task) return this.dispatchNew(cwd, task, String(form.model ?? 'default'), mid);
        break;
      }
      case 'new-cancel':
        await patchCard(mid, closedCard('已取消派发', '已取消'));
        return;
      case 'retry':
        if (sid) {
          await patchCard(mid, closedCard('出错退出 · 已重试', '已在飞书重试'));
          return this.sendTo({ sessionId: sid }, t || '继续');
        }
        break;
    }
    await patchCard(mid, closedCard('已失效', '璇玑重启过,这个请求已随之结束。发 /ls 查看会话现状'));
  }

  private defaultModel(): string {
    const prefs = readPrefs(this.storage);
    const models = this.models();
    return prefs.model && models.some((m) => m.id === prefs.model) ? prefs.model : models[0]!.id;
  }

  private async answerQuestion(mid: string, entry: Extract<CardEntry, { kind: 'question' }>, answers: Record<string, string>) {
    const d = getDispatch(entry.dispatchId);
    if (!d) return;
    entry.view = { ...entry.view, state: 'answered', answers };
    this.selfResolved.add(entry.requestId);
    await patchCard(mid, questionCard(entry.view));
    this.setCurrent({ dispatchId: d.id, sessionId: d.sessionId ?? undefined });
    d.resolveQuestion(entry.requestId, answers);
    const w = this.watches.get(d.id);
    if (w) await this.startProgress(w);
  }
}

// ---------- 工具 ----------

function logErr(e: unknown) {
  console.error('[xuanji] lark bridge:', e);
}

export function relTime(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 项目名匹配:完全相等优先,其次子串(不区分大小写) */
export function matchProjects<T extends { name: string }>(projects: T[], kw: string): T[] {
  const k = kw.toLowerCase();
  const exact = projects.filter((p) => p.name.toLowerCase() === k);
  if (exact.length) return exact;
  return projects.filter((p) => p.name.toLowerCase().includes(k));
}

/** lark-cli 可能给文件名补扩展名:先找原名,再找「原名.任意扩展名」 */
function resolveSaved(dir: string, name: string): string | null {
  const exact = join(dir, name);
  try {
    if (statSync(exact).isFile()) return exact;
  } catch {
    /* 没有原名,往下找 */
  }
  try {
    const hit = readdirSync(dir).find((f) => f.startsWith(`${name}.`));
    return hit ? join(dir, hit) : null;
  } catch {
    return null;
  }
}
