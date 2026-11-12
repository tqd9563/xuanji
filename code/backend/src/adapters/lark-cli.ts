/**
 * LarkCliAdapter —— 飞书中控与飞书开放平台之间的唯一通道:全部经 `lark-cli` 子进程完成。
 *
 * 为什么不直接用飞书 SDK:凭证(app_secret)由 lark-cli 配置档保管(keychain / 本地配置),
 * 璇玑因此不读、不存任何飞书密钥;配置档默认 `xuanji`(XUANJI_LARK_PROFILE 可改)。
 *
 * 两类调用:
 * - 一次性:发卡片 / 改卡片 / 回复 / 查机器人信息,逐次 spawn(实测单次 1.1–1.6s);
 * - 常驻:`event consume <EventKey>` 长连接,stdout 一行一个事件(NDJSON),stderr 有 ready 标记与错误信封。
 *   一个飞书应用全局只允许一个接收方,第二个会被拒(另一个进程占着同一个机器人时的典型报错)。
 */
import { spawn, type ChildProcess } from 'node:child_process';

export const LARK_PROFILE = process.env.XUANJI_LARK_PROFILE ?? 'xuanji';
const BIN = process.env.XUANJI_LARK_CLI ?? 'lark-cli';
const CALL_TIMEOUT_MS = 20_000;

export interface LarkResult<T = unknown> {
  ok: boolean;
  data?: T;
  /** 失败时的一句话原因(取自 lark-cli 错误信封的 message,或进程级错误) */
  error?: string;
  /** 错误信封里的 type/subtype,供调用方分支(如 failed_precondition = 另一个接收方占着) */
  errorType?: string;
}

/** 解析 lark-cli 的 JSON 输出:成功 `{ok:true,data}`,失败 `{ok:false,error:{type,subtype,message}}` */
export function parseCliJson<T>(stdout: string): LarkResult<T> {
  const text = stdout.trim();
  if (!text) return { ok: false, error: 'lark-cli 无输出' };
  // 部分子命令在 JSON 之前会打印提示行,取第一个 { 起的整段
  const start = text.indexOf('{');
  if (start < 0) return { ok: false, error: text.slice(0, 200) };
  try {
    const j = JSON.parse(text.slice(start)) as {
      ok?: boolean;
      data?: T;
      code?: number;
      msg?: string;
      error?: { type?: string; subtype?: string; message?: string };
    };
    if (j.ok === false || j.error) {
      return {
        ok: false,
        error: j.error?.message ?? j.msg ?? '未知错误',
        errorType: [j.error?.type, j.error?.subtype].filter(Boolean).join('/') || undefined,
      };
    }
    // `api` 子命令透传开放平台原始响应:code 非 0 即失败
    if (typeof j.code === 'number' && j.code !== 0) return { ok: false, error: j.msg ?? `code ${j.code}` };
    return { ok: true, data: (j.data ?? j) as T };
  } catch {
    return { ok: false, error: text.slice(0, 200) };
  }
}

/** 执行一次 lark-cli 调用;stdin 用于传大段 JSON(卡片内容),避免进程参数里出现长串 */
export function larkCall<T = unknown>(args: string[], stdin?: string): Promise<LarkResult<T>> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (r: LarkResult<T>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ChildProcess;
    try {
      child = spawn(BIN, ['--profile', LARK_PROFILE, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, error: `lark-cli 超时(${CALL_TIMEOUT_MS / 1000}s)` });
    }, CALL_TIMEOUT_MS);
    child.stdout?.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr?.on('data', (b: Buffer) => (err += b.toString()));
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', () => {
      const r = parseCliJson<T>(out);
      if (!r.ok && r.error === 'lark-cli 无输出') {
        const env = parseCliJson<T>(err);
        return finish(env.ok ? { ok: false, error: err.trim().slice(0, 200) } : env);
      }
      finish(r);
    });
    child.stdin?.end(stdin ?? '');
  });
}

// ---------- 一次性调用 ----------

export interface SentMessage {
  message_id: string;
  chat_id?: string;
}

/** 发卡片到会话;卡片 JSON 经 stdin 传入 */
export function sendCard(chatId: string, card: object, idempotencyKey?: string) {
  const args = ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--msg-type', 'interactive', '--content', '-'];
  if (idempotencyKey) args.push('--idempotency-key', idempotencyKey.slice(0, 50));
  return larkCall<SentMessage>(args, JSON.stringify(card));
}

/** 发纯文本(用 markdown 富文本,支持加粗与代码) */
export function sendMarkdown(chatId: string, markdown: string) {
  return larkCall<SentMessage>(['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--markdown', '-'], markdown);
}

/** 原地更新机器人发出的卡片(卡片需带 config.update_multi=true) */
export function patchCard(messageId: string, card: object) {
  return larkCall(
    ['api', 'PATCH', `/open-apis/im/v1/messages/${messageId}`, '--as', 'bot', '--data', '-'],
    JSON.stringify({ content: JSON.stringify(card) }),
  );
}

export interface BotInfo {
  app_name: string;
  open_id: string;
  activate_status?: number;
}

export function botInfo() {
  return larkCall<BotInfo>(['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot']);
}

// ---------- 常驻长连接 ----------

export type ConsumerState =
  | { kind: 'connecting' }
  | { kind: 'ready' }
  /** 不可自动恢复的失败(如另一个接收方占着同一个应用):停止重连,等用户手动重试 */
  | { kind: 'fail'; error: string; fatal: boolean };

export interface Consumer {
  stop(): void;
}

/** 占用冲突的重试间隔 */
export const CONFLICT_RETRY_MS = 30_000;

/**
 * 是否为「已有别的接收方」类错误。实测两种措辞(lark-cli 1.0.99):
 * 跨机器 `another event bus is already connected to this app`;
 * 同机器 `another consumer (pid N) is already running for this subscription`。
 */
export const isConflictError = (msg: string) => /another (event bus|consumer)|already (connected|running)/i.test(msg);

/** stderr 的一行是否为 ready 标记 */
export const isReadyLine = (line: string) => line.startsWith('[event] ready event_key=');

/**
 * 常驻消费一个 EventKey。进程意外退出按指数退避重连(2s → 60s 封顶);
 * 致命错误(配置缺失、另一个接收方)不重连,交由 onState 上报。
 * stdin 保持打开:lark-cli 把 stdin EOF 当作优雅退出信号。
 */
export function consume(
  eventKey: string,
  onEvent: (e: Record<string, unknown>) => void,
  onState: (s: ConsumerState) => void,
): Consumer {
  let child: ChildProcess | null = null;
  let stopped = false;
  let backoff = 2_000;
  let retry: NodeJS.Timeout | null = null;

  const start = () => {
    if (stopped) return;
    onState({ kind: 'connecting' });
    let errBuf = '';
    let fatal: { error: string } | null = null;
    let outBuf = '';
    child = spawn(BIN, ['--profile', LARK_PROFILE, 'event', 'consume', eventKey, '--as', 'bot'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (b: Buffer) => {
      outBuf += b.toString();
      let i: number;
      while ((i = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, i).trim();
        outBuf = outBuf.slice(i + 1);
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
    });
    child.stderr?.on('data', (b: Buffer) => {
      errBuf += b.toString();
      for (const line of b.toString().split('\n')) {
        if (isReadyLine(line.trim())) {
          backoff = 2_000;
          onState({ kind: 'ready' });
        }
      }
      // 错误信封(多行 JSON):尽早识别致命错误
      const env = parseCliJson(errBuf);
      if (!env.ok && env.errorType) fatal = { error: env.error ?? '连接失败' };
    });
    child.on('error', (e) => {
      fatal = { error: `无法启动 lark-cli:${e.message}` };
    });
    child.on('close', () => {
      child = null;
      if (stopped) return;
      if (fatal) {
        onState({ kind: 'fail', error: fatal.error, fatal: true });
        // 被别的接收方占着(典型:验收环境与生产后端同时连着同一个机器人)是暂时的:
        // 照样报「连接失败」让用户看到原因,但每 30 秒自己再试,对方一退出就自动接上,不必手点重试。
        // 配置缺失这类真·致命错误不重试,免得空转。
        if (isConflictError(fatal.error)) retry = setTimeout(start, CONFLICT_RETRY_MS);
        return;
      }
      onState({ kind: 'fail', error: '长连接已断开,正在重连', fatal: false });
      retry = setTimeout(start, backoff);
      backoff = Math.min(backoff * 2, 60_000);
    });
  };
  start();
  return {
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      // 关 stdin = 优雅退出;不用 kill -9,否则服务端订阅可能残留
      child?.stdin?.end();
      const c = child;
      setTimeout(() => c?.kill('SIGTERM'), 3_000).unref();
    },
  };
}
