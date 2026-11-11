import { describe, expect, it } from 'vitest';
import { parseCliJson, isReadyLine } from '../src/adapters/lark-cli.js';
import { parseScreenLocked } from '../src/adapters/screen-lock.js';
import { matchProjects, relTime } from '../src/services/lark/bridge.js';
import {
  errorCard,
  helpCard,
  listCard,
  permCard,
  progressCard,
  PROJECT_TAG_COLORS,
  projectTagColor,
  questionCard,
  REPLY_CLIP,
  switchedCard,
  type ListRow,
  type SessionRef,
  type Step,
} from '../src/services/lark/cards.js';
import { parseCommand, splitMarkdown } from '../src/services/lark/parse.js';

const ref: SessionRef = { name: '飞书中控', project: 'xuanji', paletteIdx: 16 };
const json = (c: object) => JSON.stringify(c);
/** 卡片里所有按钮(含嵌套在 column_set / form 里的) */
function buttons(c: object): { text: string; value?: Record<string, unknown>; name?: string }[] {
  const out: { text: string; value?: Record<string, unknown>; name?: string }[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (o.tag === 'button') {
        const b = (o.behaviors as { value?: Record<string, unknown> }[] | undefined)?.[0];
        out.push({ text: (o.text as { content: string }).content, value: b?.value, name: o.name as string | undefined });
      }
      Object.values(o).forEach(walk);
    }
  };
  walk(c);
  return out;
}
const headerOf = (c: object) => (c as { header: { title: { content: string }; template: string; text_tag_list?: { color: string }[] } }).header;

describe('命令解析', () => {
  it('识别全部命令,大小写不敏感', () => {
    expect(parseCommand('/help')).toEqual({ kind: 'help' });
    expect(parseCommand('/LS')).toEqual({ kind: 'ls', all: false });
    expect(parseCommand('/ls all')).toEqual({ kind: 'ls', all: true });
    expect(parseCommand('/stop')).toEqual({ kind: 'stop' });
    expect(parseCommand('/bind 123456')).toEqual({ kind: 'bind' });
  });
  it('/new 三种形态:空 / 只有项目 / 项目 + 多行任务', () => {
    expect(parseCommand('/new')).toEqual({ kind: 'new' });
    expect(parseCommand('/new atlas')).toEqual({ kind: 'new', project: 'atlas' });
    expect(parseCommand('/new atlas 补一下\n口径说明')).toEqual({ kind: 'new', project: 'atlas', task: '补一下\n口径说明' });
  });
  it('不认识的斜杠命令不当普通消息发给会话', () => {
    expect(parseCommand('/compact')).toEqual({ kind: 'unknown', name: '/compact' });
  });
  it('以路径开头的普通文本不是命令', () => {
    expect(parseCommand('/Users/x/a.ts 这里有问题')).toEqual({ kind: 'text', text: '/Users/x/a.ts 这里有问题' });
    expect(parseCommand('  再加个单测 ')).toEqual({ kind: 'text', text: '再加个单测' });
  });
});

describe('长回复分段', () => {
  it('每段不超过上限,拼回去内容不丢', () => {
    const para = (i: number) => `第 ${i} 段 ` + 'x'.repeat(300);
    const text = Array.from({ length: 20 }, (_, i) => para(i)).join('\n\n');
    const parts = splitMarkdown(text, 1000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1000 + 8);
    expect(parts.join('\n\n').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });
  it('切开代码块时两段各自补齐围栏', () => {
    const text = '```\n' + Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n') + '\n```';
    const parts = splitMarkdown(text, 300);
    for (const p of parts) expect((p.match(/```/g) ?? []).length % 2).toBe(0);
  });
});

describe('项目标签色(方案 D)', () => {
  it('不使用状态语义色', () => {
    for (const c of PROJECT_TAG_COLORS) expect(['red', 'orange', 'yellow', 'neutral', 'grey']).not.toContain(c);
  });
  it('与网页同一个调色板序号:xuanji(16)→ wathet;两对合并色相', () => {
    expect(projectTagColor('xuanji', 16)).toBe('wathet');
    expect(projectTagColor('a', 3)).toBe(projectTagColor('b', 4));
    expect(projectTagColor('a', 2)).toBe(projectTagColor('b', 8));
  });
  it('没有序号时按名字稳定兜底', () => {
    expect(projectTagColor('foo')).toBe(projectTagColor('foo'));
    expect(PROJECT_TAG_COLORS).toContain(projectTagColor('foo'));
  });
});

describe('卡片', () => {
  it('所有卡片都可原地更新', () => {
    const cards = [
      permCard({ ref, tool: 'Bash', title: 'Bash(pnpm test)', input: 'pnpm test', hasAlways: true, state: 'pending' }),
      progressCard({ ref, state: 'running', steps: [], elapsedMs: 0 }),
      errorCard(ref, 'boom'),
      switchedCard(ref, 'x'),
      helpCard('澄闪'),
    ];
    for (const c of cards) expect((c as { config: { update_multi: boolean } }).config.update_multi).toBe(true);
  });

  it('待审批:三个按钮,项目标签挂在页眉;「总是允许」仅在有建议时出现', () => {
    const c = permCard({ ref, tool: 'Bash', title: '运行单测', input: 'pnpm test', hasAlways: true, state: 'pending' });
    expect(buttons(c).map((b) => b.text)).toEqual(['批准', '总是允许', '拒绝']);
    expect(headerOf(c).template).toBe('orange');
    expect(headerOf(c).text_tag_list?.[0]?.color).toBe('wathet');
    const c2 = permCard({ ref, tool: 'Bash', title: '', input: 'ls', hasAlways: false, state: 'pending' });
    expect(buttons(c2).map((b) => b.text)).toEqual(['批准', '拒绝']);
  });

  it('已处理的审批卡变灰、没有按钮', () => {
    for (const state of ['allow', 'always', 'deny', 'web', 'gone'] as const) {
      const c = permCard({ ref, tool: 'Bash', title: '', input: 'ls', hasAlways: true, state, resolvedAt: Date.now() });
      expect(headerOf(c).template).toBe('grey');
      expect(buttons(c)).toHaveLength(0);
    }
  });

  it('命令里的 ``` 不会提前结束代码块', () => {
    const c = permCard({ ref, tool: 'Bash', title: '', input: 'echo ```x```', hasAlways: false, state: 'pending' });
    expect(json(c)).not.toContain('echo ```');
  });

  it('提问:单个单选题用按钮,其余用表单', () => {
    const single = questionCard({ ref, state: 'pending', questions: [{ question: '口径?', options: [{ label: 'A' }, { label: 'B' }] }] });
    expect(buttons(single).map((b) => b.value)).toEqual([{ a: 'q-pick', i: 0 }, { a: 'q-pick', i: 1 }]);
    const multi = questionCard({
      ref,
      state: 'pending',
      questions: [{ question: '包含?', multiSelect: true, options: [{ label: 'PR' }, { label: '计划' }] }],
    });
    expect(json(multi)).toContain('"name":"q0_o1"');
    expect(buttons(multi).find((b) => b.name === 'q_submit')).toBeTruthy();
  });

  it('回合完成:超长回复折叠并给「完整回复」,短回复不给;执行过程收进折叠面板且不重复正文', () => {
    const steps: Step[] = [
      { kind: 'tool', name: 'Bash', detail: 'ls', status: 'ok', startedAt: 0, endedAt: 3000 },
      { kind: 'text', detail: '最终回复正文', status: 'ok', startedAt: 3000, endedAt: 3000 },
    ];
    const long = progressCard({ ref, state: 'done', steps, elapsedMs: 61_000, reply: 'x'.repeat(REPLY_CLIP + 10), costUsd: 0.5 });
    expect(buttons(long).map((b) => b.text)).toEqual(['完整回复']);
    expect(json(long)).toContain('耗时 1m01s');
    expect(json(long)).toContain('执行过程(1 步)');
    expect(json(long)).not.toContain('最终回复正文');
    const short = progressCard({ ref, state: 'done', steps: [], elapsedMs: 1000, reply: 'ok' });
    expect(buttons(short)).toHaveLength(0);
    expect(json(short)).not.toContain('collapsible_panel');
    expect(headerOf(short).template).toBe('green');
  });

  it('进度卡:时间线带状态图标、工具名、入参与单步耗时,运行中的步骤按渲染时刻计时', () => {
    const steps: Step[] = [
      { kind: 'tool', name: 'Read', detail: 'a.ts', status: 'ok', startedAt: 0, endedAt: 2000 },
      { kind: 'text', detail: '看完了,\n接着改', status: 'ok', startedAt: 2000 },
      { kind: 'tool', name: 'Bash', detail: 'echo `x` <y> *z*', status: 'running', startedAt: 2000 },
    ];
    const c = progressCard({ ref, state: 'running', steps, elapsedMs: 13_000, now: 9000, contextPct: 5 });
    const s = json(c);
    expect(s).toContain('**正在执行 Bash…**');
    expect(s).toContain('✅ **Read**　`a.ts` <font color=\'grey\'>2s</font>');
    expect(s).toContain('⏳ **Bash**');
    expect(s).toContain('7s</font>');
    expect(s).toContain('已用 13s · 共 2 步 · 上下文 5%');
    expect(s).not.toContain('`x`'); // 入参里的反引号不得打断行内代码
    expect(buttons(c).map((b) => b.value)).toEqual([{ a: 'stop' }]);
  });

  it('进度卡刚发出时(不足 1 秒)不显示「已用」,超过 12 步时折叠更早的', () => {
    const many: Step[] = Array.from({ length: 15 }, (_, i) => ({ kind: 'tool' as const, name: `T${i}`, detail: '', status: 'ok' as const, startedAt: 0, endedAt: 0 }));
    const c = json(progressCard({ ref, state: 'running', steps: many, elapsedMs: 400 }));
    expect(c).not.toContain('已用');
    expect(c).toContain('更早的 3 步已折叠');
    expect(c).not.toContain('**T2**');
    expect(c).toContain('**T14**');
    expect(c).toContain('**正在思考…**');
  });

  it('会话列表:同一状态组内按项目分框,框按最近活动排序,项目标签只在框顶出现一次', () => {
    const r = (sessionId: string, project: string, at: number, idx: number): ListRow => ({
      sessionId,
      ref: { name: sessionId, project, paletteIdx: idx },
      detail: '**加粗** `code` 回复\n第二行',
      ago: '刚刚',
      at,
      kind: 'idle',
    });
    const c = listCard([r('a', 'scratch', 1, 0), r('b', 'xuanji', 5, 16), r('c', 'scratch', 9, 0), r('d', 'xuanji', 2, 16)], null, { all: false, truncated: 0 });
    const boxes = (JSON.parse(json(c)).body.elements as { tag: string; border_color?: string; background_style?: string }[]).filter((x) => x.tag === 'interactive_container');
    expect(boxes.map((b) => b.border_color)).toEqual(['box-lime-border', 'box-wathet-border']);
    expect(boxes.map((b) => b.background_style)).toEqual(['box-lime-bg', 'box-wathet-bg']);
    // 框色走低透明度自定义色(内置 -50 档在深色模式下太深),且每个用到的色都在 config 里有定义
    const colors = JSON.parse(json(c)).config.style.color as Record<string, { light_mode: string; dark_mode: string }>;
    for (const k of ['box-lime-bg', 'box-lime-border', 'box-wathet-bg', 'box-wathet-border']) expect(colors[k]).toBeTruthy();
    expect(colors['box-wathet-bg']!.dark_mode).toMatch(/,0\.10\)$/);
    expect(buttons(c).map((b) => b.value?.s)).toEqual(['c', 'a', 'b', 'd']);
    expect(json(c).match(/<text_tag color='lime'>scratch<\/text_tag>/g)).toHaveLength(1);
    // 摘要去掉 markdown 记号与换行
    expect(json(c)).toContain('加粗 code 回复 第二行');
  });

  it('会话列表:终端会话只读无按钮、当前会话打标、其余给「续接」,待处理给「重发审批卡」', () => {
    const row = (sessionId: string, kind: ListRow['kind']): ListRow => ({ sessionId, ref, detail: 'd', ago: '刚刚', kind });
    const c = listCard([row('a', 'blocked'), row('b', 'running'), row('c', 'idle'), row('t', 'terminal')], 'c', { all: false, truncated: 0, currentName: 'C' });
    expect(buttons(c).map((b) => [b.text, b.value?.s])).toEqual([
      ['重发审批卡', 'a'],
      ['续接', 'b'],
    ]);
    expect(json(c)).toContain("<text_tag color='neutral'>终端只读</text_tag>");
    expect(json(c)).toContain("<text_tag color='blue'>当前</text_tag>");
    expect(json(c)).toContain("<text_tag color='wathet'>xuanji</text_tag>");
  });

  it('用户要求删去的提示文案不出现(2026-11-11)', () => {
    const all = [
      permCard({ ref, tool: 'Bash', title: '', input: 'ls', hasAlways: false, state: 'pending' }),
      questionCard({ ref, state: 'pending', questions: [{ question: 'q', options: [{ label: 'A' }] }] }),
      progressCard({ ref, state: 'running', steps: [], elapsedMs: 0 }),
      progressCard({ ref, state: 'done', steps: [], elapsedMs: 0, reply: 'r' }),
      errorCard(ref, 'e'),
      switchedCard(ref, '上一轮'),
      listCard([], null, { all: false, truncated: 0 }),
    ].map(json);
    for (const s of all) {
      expect(s).not.toContain('引用回复本卡 →');
      expect(s).not.toContain('直接发消息即续接');
      expect(s).not.toContain('点「续接」');
    }
  });
});

describe('适配器解析', () => {
  it('锁屏判定只认 CGSSessionScreenIsLocked=true', () => {
    expect(parseScreenLocked('<key>CGSSessionScreenIsLocked</key>\n\t\t\t<true/>')).toBe(true);
    expect(parseScreenLocked('<key>CGSSessionScreenIsLocked</key><false/>')).toBe(false);
    expect(parseScreenLocked('<key>kCGSSessionOnConsoleKey</key><true/>')).toBe(false);
  });
  it('lark-cli 输出:成功、错误信封、开放平台非 0 code', () => {
    expect(parseCliJson('{"ok":true,"data":{"message_id":"om_1"}}')).toEqual({ ok: true, data: { message_id: 'om_1' } });
    const env = parseCliJson('{"ok":false,"error":{"type":"validation","subtype":"failed_precondition","message":"another event bus"}}');
    expect(env).toMatchObject({ ok: false, error: 'another event bus', errorType: 'validation/failed_precondition' });
    expect(parseCliJson('{"code":230002,"msg":"bot not in chat"}')).toMatchObject({ ok: false, error: 'bot not in chat' });
    expect(parseCliJson('')).toMatchObject({ ok: false });
  });
  it('ready 标记', () => {
    expect(isReadyLine('[event] ready event_key=im.message.receive_v1')).toBe(true);
    expect(isReadyLine('[event] listening for events')).toBe(false);
  });
});

describe('杂项', () => {
  it('项目匹配:完全相等优先于子串', () => {
    const ps = [{ name: 'atlas' }, { name: 'atlas-report' }, { name: 'atlas-sdk' }];
    expect(matchProjects(ps, 'atlas')).toEqual([{ name: 'atlas' }]);
    expect(matchProjects(ps, 'ATLAS-')).toEqual([{ name: 'atlas-report' }, { name: 'atlas-sdk' }]);
    expect(matchProjects(ps, 'zzz')).toEqual([]);
  });
  it('相对时间', () => {
    expect(relTime(10_000)).toBe('刚刚');
    expect(relTime(5 * 60_000)).toBe('5 分钟前');
    expect(relTime(3 * 3600_000)).toBe('3 小时前');
  });
});
