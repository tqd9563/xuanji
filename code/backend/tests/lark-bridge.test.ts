/**
 * 飞书中控桥接的端到端行为(飞书侧与派发侧都换成假的):
 * 绑定与白名单、锁屏推送闸门、审批回写、网页先处理时的同步、飞书发起的回合与进度卡、只读会话拦截。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  type Ev = Record<string, unknown>;
  const st = {
    sent: [] as { chatId: string; card: Record<string, unknown>; mid: string }[],
    patched: [] as { mid: string; card: Record<string, unknown> }[],
    texts: [] as string[],
    onMsg: null as null | ((e: Ev) => void),
    onCard: null as null | ((e: Ev) => void),
    onMenu: null as null | ((e: Ev) => void),
    locked: true,
    observers: [] as ((s: unknown) => void)[],
    sessions: new Map<string, FakeSession>(),
    canResume: { ok: true } as { ok: boolean; reason?: string; fork?: boolean },
    board: { idle: [], running: [], blocked: [], review: [], done: [] } as Record<string, unknown[]>,
    seq: 0,
  };
  class FakeSession {
    id: string;
    sessionId: string | null;
    cwd: string;
    displayName: string;
    state = 'idle';
    lastAssistantText: string | undefined;
    sent: string[] = [];
    resolved: [string, string][] = [];
    interrupted = 0;
    private ls = new Set<(e: Ev) => void>();
    constructor(id: string, sessionId: string | null, cwd: string, name: string) {
      this.id = id;
      this.sessionId = sessionId;
      this.cwd = cwd;
      this.displayName = name;
    }
    subscribe(l: (e: Ev) => void) {
      this.ls.add(l);
      return () => this.ls.delete(l);
    }
    emit(e: Ev) {
      for (const l of this.ls) l(e);
    }
    send(t: string) {
      this.sent.push(t);
      this.state = 'working';
      this.emit({ ev: 'user-echo', text: t });
    }
    resolvePermission(r: string, d: string) {
      this.resolved.push([r, d]);
      this.emit({ ev: 'permission-resolved', requestId: r, decision: d });
    }
    resolveQuestion(r: string, answers: Record<string, string>) {
      this.resolved.push([r, JSON.stringify(answers)]);
      this.emit({ ev: 'question-answered', requestId: r, answers });
    }
    async interrupt() {
      this.interrupted++;
    }
  }
  const make = (sessionId: string | null, cwd: string, name: string) => {
    const s = new FakeSession(`d${++st.seq}`, sessionId, cwd, name);
    st.sessions.set(s.id, s);
    for (const o of st.observers) o(s);
    return s;
  };
  return { st, FakeSession, make };
});

vi.mock('../src/adapters/lark-cli.js', () => ({
  botInfo: async () => ({ ok: true, data: { app_name: '澄闪', open_id: 'ou_bot' } }),
  consume: (key: string, onEvent: (e: Record<string, unknown>) => void, onState: (s: { kind: string }) => void) => {
    if (key === 'im.message.receive_v1') h.st.onMsg = onEvent;
    else if (key === 'card.action.trigger') h.st.onCard = onEvent;
    else h.st.onMenu = onEvent;
    onState({ kind: 'ready' });
    return { stop() {} };
  },
  sendCard: async (chatId: string, card: Record<string, unknown>) => {
    const mid = `om_${h.st.sent.length + 1}`;
    h.st.sent.push({ chatId, card, mid });
    return { ok: true, data: { message_id: mid } };
  },
  patchCard: async (mid: string, card: Record<string, unknown>) => {
    h.st.patched.push({ mid, card });
    return { ok: true };
  },
  sendMarkdown: async (_c: string, md: string) => {
    h.st.texts.push(md);
    return { ok: true, data: { message_id: 'om_text' } };
  },
}));
vi.mock('../src/adapters/screen-lock.js', () => ({ isScreenLocked: async () => h.st.locked }));
vi.mock('../src/services/dispatch.js', () => ({
  onDispatchCreated: (fn: (s: unknown) => void) => {
    h.st.observers.push(fn);
    return () => {};
  },
  createDispatch: (_s: unknown, o: { cwd: string; name?: string; resume?: string }) => h.make(o.resume ?? null, o.cwd, o.name ?? ''),
  getDispatch: (id: string) => h.st.sessions.get(id),
  findDispatchBySessionId: (sid: string) => [...h.st.sessions.values()].find((s) => s.sessionId === sid),
  canResume: async () => h.st.canResume,
}));
vi.mock('../src/services/sessions.js', () => ({
  sessionsBoard: async () => ({ ok: true, columns: h.st.board, refreshedAt: 0 }),
  sessionReplay: async () => null,
}));
vi.mock('../src/adapters/claude-dir.js', () => ({
  scanProjectDirs: async () => [{ path: '/p/xuanji', encodedDir: '-p-xuanji', exists: true }],
  readHistory: async () => [],
}));
vi.mock('../src/services/models.js', () => ({ cachedModelCatalog: () => null }));

import { LarkBridge } from '../src/services/lark/bridge.js';

const OWNER = 'ou_me';
const CHAT = 'oc_me';

function fakeStorage() {
  const meta = new Map<string, string>([['prefs', JSON.stringify({ lark: { enabled: true, push: 'locked' } })]]);
  return {
    getMeta: (k: string) => meta.get(k) ?? null,
    setMeta: (k: string, v: string) => void meta.set(k, v),
    assignPalette: (names: string[]) => new Map(names.map((n) => [n, n === 'xuanji' ? 16 : 0])),
    allDispatches: () => [],
    meta,
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};
const title = (c: Record<string, unknown>) => (c.header as { title: { content: string } }).title.content;
let n = 0;
const msg = (content: string, extra: Record<string, unknown> = {}) =>
  h.st.onMsg!({ message_id: `om_in${++n}`, chat_type: 'p2p', message_type: 'text', sender_id: OWNER, chat_id: CHAT, content, ...extra });
const click = (mid: string, value: Record<string, unknown>, operator = OWNER) =>
  h.st.onCard!({ message_id: mid, operator_id: operator, action_value: JSON.stringify(value) });

async function boundBridge() {
  const storage = fakeStorage();
  storage.setMeta('lark.owner', JSON.stringify({ openId: OWNER, chatId: CHAT, boundAt: 1 }));
  const b = new LarkBridge(storage as never);
  b.start();
  await flush();
  return { b, storage };
}

beforeEach(() => {
  Object.assign(h.st, { sent: [], patched: [], texts: [], locked: true, observers: [], canResume: { ok: true } });
  h.st.sessions.clear();
  h.st.board = { idle: [], running: [], blocked: [], review: [], done: [] };
});

describe('绑定与白名单', () => {
  it('未绑定时对任何消息都不回应;正确的绑定码才绑定', async () => {
    const storage = fakeStorage();
    const b = new LarkBridge(storage as never);
    b.start();
    await flush();
    msg('/help');
    msg('/bind 000000');
    await flush();
    expect(h.st.sent).toHaveLength(0);
    const { code } = b.createBindCode();
    msg(`/bind ${code}`);
    await flush();
    expect(JSON.parse(storage.getMeta('lark.owner')!)).toMatchObject({ openId: OWNER, chatId: CHAT });
    expect(title(h.st.sent[0]!.card)).toBe('绑定成功');
  });

  it('绑定后陌生人与群聊一律不回应,卡片点击同理', async () => {
    await boundBridge();
    msg('/help', { sender_id: 'ou_stranger' });
    msg('/help', { chat_type: 'group' });
    await flush();
    expect(h.st.sent).toHaveLength(0);
    msg('/help');
    await flush();
    expect(title(h.st.sent[0]!.card)).toBe('澄闪能做什么');
  });

  it('同一条消息重复投递只处理一次', async () => {
    await boundBridge();
    const e = { message_id: 'om_dup', chat_type: 'p2p', message_type: 'text', sender_id: OWNER, chat_id: CHAT, content: '/help' };
    h.st.onMsg!(e);
    h.st.onMsg!(e);
    await flush();
    expect(h.st.sent).toHaveLength(1);
  });
});

describe('推送与审批', () => {
  it('锁屏时网页会话的审批推到飞书;未锁屏不推', async () => {
    await boundBridge();
    h.st.locked = false;
    const s1 = h.make('sid-1', '/p/xuanji', '飞书中控');
    s1.emit({ ev: 'permission-request', requestId: 'r0', toolName: 'Bash', title: 'Bash(ls)', input: 'ls', hasSuggestions: false });
    await flush();
    expect(h.st.sent).toHaveLength(0);
    h.st.locked = true;
    s1.emit({ ev: 'permission-request', requestId: 'r1', toolName: 'Bash', title: 'Bash(ls)', input: 'ls', hasSuggestions: false });
    await flush();
    expect(title(h.st.sent[0]!.card)).toBe('需要审批');
  });

  it('飞书里批准 → 调 resolvePermission、卡片变灰、随后出进度卡,结束时同一张卡变成回合完成', async () => {
    await boundBridge();
    const s1 = h.make('sid-1', '/p/xuanji', '飞书中控');
    s1.emit({ ev: 'permission-request', requestId: 'r1', toolName: 'Bash', title: 't', input: 'pnpm test', hasSuggestions: true });
    await flush();
    click('om_1', { a: 'perm', d: 'always' });
    await flush();
    expect(s1.resolved).toEqual([['r1', 'always']]);
    expect(title(h.st.patched.find((p) => p.mid === 'om_1')!.card)).toBe('已批准(总是允许)');
    const prog = h.st.sent.find((x) => title(x.card) === '进行中');
    expect(prog).toBeTruthy();
    s1.lastAssistantText = '单测已补齐';
    s1.emit({ ev: 'result', costUsd: 0.4, contextTokens: 1, contextPct: 12, durationMs: 9000 });
    await flush();
    const last = h.st.patched.filter((p) => p.mid === prog!.mid).at(-1)!;
    expect(title(last.card)).toBe('回合完成');
    expect(JSON.stringify(last.card)).toContain('单测已补齐');
  });

  it('网页端先批准:飞书卡片同步为「已在璇玑网页处理」', async () => {
    await boundBridge();
    const s1 = h.make('sid-1', '/p/xuanji', '飞书中控');
    s1.emit({ ev: 'permission-request', requestId: 'r1', toolName: 'Bash', title: 't', input: 'ls', hasSuggestions: false });
    await flush();
    s1.emit({ ev: 'permission-resolved', requestId: 'r1', decision: 'allow' });
    await flush();
    expect(title(h.st.patched[0]!.card)).toBe('已在璇玑网页处理');
  });

  it('已失效的审批卡(会话不在了)点了只会变灰,不会误触发', async () => {
    await boundBridge();
    const s1 = h.make('sid-1', '/p/xuanji', '飞书中控');
    s1.emit({ ev: 'permission-request', requestId: 'r1', toolName: 'Bash', title: 't', input: 'ls', hasSuggestions: false });
    await flush();
    h.st.sessions.delete(s1.id);
    click('om_1', { a: 'perm', d: 'allow' });
    await flush();
    expect(s1.resolved).toEqual([]);
    expect(title(h.st.patched[0]!.card)).toBe('已失效');
  });

  it('陌生人点卡片无效', async () => {
    await boundBridge();
    const s1 = h.make('sid-1', '/p/xuanji', '飞书中控');
    s1.emit({ ev: 'permission-request', requestId: 'r1', toolName: 'Bash', title: 't', input: 'ls', hasSuggestions: false });
    await flush();
    click('om_1', { a: 'perm', d: 'allow' }, 'ou_stranger');
    await flush();
    expect(s1.resolved).toEqual([]);
  });

  it('关闭推送后,锁屏也不推网页会话的回合完成', async () => {
    const { storage } = await boundBridge();
    storage.setMeta('prefs', JSON.stringify({ lark: { enabled: true, push: 'off' } }));
    const s1 = h.make('sid-1', '/p/xuanji', '飞书中控');
    s1.emit({ ev: 'result', costUsd: 0, contextTokens: 0, contextPct: 0, durationMs: 1 });
    await flush();
    expect(h.st.sent).toHaveLength(0);
  });
});

describe('从飞书发消息', () => {
  it('引用回复某张卡 → 发给那张卡的会话,并开进度卡', async () => {
    await boundBridge();
    h.st.locked = true;
    const s1 = h.make('sid-1', '/p/xuanji', '飞书中控');
    s1.emit({ ev: 'result', costUsd: 0, contextTokens: 0, contextPct: 0, durationMs: 1 });
    await flush();
    const done = h.st.sent[0]!;
    msg('再加个单测', { reply_to: done.mid });
    await flush();
    expect(s1.sent).toEqual(['再加个单测']);
    expect(h.st.sent.some((x) => title(x.card) === '进行中')).toBe(true);
    // 之后直接发的消息去同一个会话(当前会话)
    msg('顺便改下注释');
    await flush();
    expect(s1.sent).toEqual(['再加个单测', '顺便改下注释']);
  });

  it('没有当前会话时直接发消息 → 弹「发给哪个会话?」', async () => {
    await boundBridge();
    h.st.board.idle = [{ sessionId: 'sid-9', cwd: '/p/xuanji', name: '旧会话', readonly: false }];
    msg('看一下');
    await flush();
    expect(title(h.st.sent[0]!.card)).toBe('发给哪个会话?');
  });

  it('续接一个不在进程里的会话:按所有权规则冷启动;终端只读会话被拦下', async () => {
    await boundBridge();
    h.st.board.idle = [{ sessionId: 'sid-9', cwd: '/p/xuanji', name: '旧会话', readonly: false }];
    msg('看一下');
    await flush();
    click('om_1', { a: 'route', s: 'sid-9' });
    await flush();
    const resumed = [...h.st.sessions.values()].find((s) => s.sessionId === 'sid-9');
    expect(resumed?.sent).toEqual(['看一下']);

    h.st.canResume = { ok: false, reason: '终端存活的交互会话只读,不可接管(会话所有权规则)' };
    h.st.board.idle.push({ sessionId: 'sid-t', cwd: '/p/xuanji', name: '终端', readonly: true });
    msg('/ls');
    await flush();
    const list = h.st.sent.at(-1)!;
    click(list.mid, { a: 'focus', s: 'sid-t' });
    await flush();
    msg('接管它');
    await flush();
    expect(h.st.texts.at(-1)).toContain('只读');
  });

  it('/stop 中断当前会话,进度卡变成「已中断」', async () => {
    await boundBridge();
    const s1 = h.make('sid-1', '/p/xuanji', '飞书中控');
    s1.emit({ ev: 'result', costUsd: 0, contextTokens: 0, contextPct: 0, durationMs: 1 });
    await flush();
    msg('跑一下', { reply_to: h.st.sent[0]!.mid });
    await flush();
    msg('/stop');
    await flush();
    expect(s1.interrupted).toBe(1);
    expect(h.st.patched.some((p) => title(p.card) === '已中断')).toBe(true);
  });

  it('进度卡:工具步与结果配对成时间线;没有新步骤也按心跳刷新「已用」', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      await boundBridge();
      const s1 = h.make('sid-1', '/p/xuanji', '飞书中控');
      s1.emit({ ev: 'result', costUsd: 0, contextTokens: 0, contextPct: 0, durationMs: 1 });
      await flush();
      msg('跑一下 ls', { reply_to: h.st.sent[0]!.mid });
      await flush();
      const prog = h.st.sent.find((x) => title(x.card) === '进行中')!;
      s1.emit({ ev: 'tool', id: 't1', name: 'Bash', input: 'ls' });
      s1.emit({ ev: 'tool-result', id: 't1', output: 'a', isError: false });
      await flush();
      const before = h.st.patched.length;
      vi.advanceTimersByTime(2_100); // 有新步骤:满 2 秒推一次
      await flush();
      expect(h.st.patched.length).toBe(before + 1);
      expect(JSON.stringify(h.st.patched.at(-1)!.card)).toContain('✅ **Bash**');
      vi.advanceTimersByTime(3_000); // 无新步骤、未满 5 秒:不推
      await flush();
      expect(h.st.patched.length).toBe(before + 1);
      vi.advanceTimersByTime(2_100); // 满 5 秒心跳
      await flush();
      expect(h.st.patched.length).toBe(before + 2);
      expect(h.st.patched.at(-1)!.mid).toBe(prog.mid);
      expect(JSON.stringify(h.st.patched.at(-1)!.card)).toMatch(/已用 \d+s/);
      // 结束后停止心跳
      s1.emit({ ev: 'result', costUsd: 0, contextTokens: 0, contextPct: 0, durationMs: 1 });
      await flush();
      const after = h.st.patched.length;
      vi.advanceTimersByTime(20_000);
      await flush();
      expect(h.st.patched.length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it('机器人菜单:按 event_key 执行命令,只认绑定人', async () => {
    await boundBridge();
    h.st.onMenu!({ event_id: 'ev1', event_key: 'help', operator_open_id: 'ou_stranger' });
    await flush();
    expect(h.st.sent).toHaveLength(0);
    h.st.onMenu!({ event_id: 'ev2', event_key: 'ls', operator_open_id: OWNER });
    h.st.onMenu!({ event_id: 'ev2', event_key: 'ls', operator_open_id: OWNER });
    await flush();
    expect(h.st.sent.map((x) => title(x.card))).toEqual(['会话']);
    h.st.onMenu!({ event_id: 'ev3', event_key: 'new', operator_open_id: OWNER });
    await flush();
    expect(title(h.st.sent.at(-1)!.card)).toBe('派发新任务');
  });

  it('/new 项目 任务:唯一匹配时直接派发并设为当前', async () => {
    await boundBridge();
    msg('/new xuanji 补一下 README');
    await flush();
    const d = [...h.st.sessions.values()].at(-1)!;
    expect(d.cwd).toBe('/p/xuanji');
    expect(d.sent).toEqual(['补一下 README']);
    expect(h.st.sent.map((x) => title(x.card))).toEqual(['已派发', '进行中']);
  });
});
