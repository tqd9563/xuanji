/**
 * 飞书中控的卡片构造(纯函数,不触网)。视觉规范见 DESIGN.md「飞书中控」与获批原型
 * wiki/design/prototype-feishu.html。
 *
 * 约定:
 * - 只用飞书卡片 2.0 自带组件;所有卡片带 `update_multi`,以便后端原地 PATCH 成新状态。
 * - 顶色即状态:orange 待处理 · wathet 进行中 · green 完成 · red 出错 · blue 信息与操作 · grey 已处理 / 已失效。
 * - 用户与模型给出的任意文本走 plain_text(不被当成 markdown 解析);只有我们自己拼的格式与 Claude 的回复走 markdown。
 * - 按钮回调值统一 `{ a: 动作, ...参数 }`;卡片本身由 message_id 在桥接层的登记表里定位。
 * - 会话类卡片不写「引用回复本卡 → 发给 X」之类的路由提示(用户 2026-11-11 要求删去)。
 */

export type Template = 'orange' | 'wathet' | 'green' | 'red' | 'blue' | 'grey';

/**
 * 项目标签色(方案 D,用户 2026-11-11 选定):璇玑网页色环 11 个色相按 idx % 11 映射到最接近的飞书内置色。
 * 红 / 橙 / 黄留给状态语义,neutral 留给「终端只读」等灰标签,都不分给项目;
 * 只剩 9 色对 11 个色相,故 idx4(55°)并入 carmine、idx8(165°)并入 turquoise。
 * 网页色相表:frontend/src/lib/utils.ts PROJ_HUES = [115, 265, 190, 340, 55, 215, 140, 290, 165, 315, 240]。
 */
export const PROJECT_TAG_COLORS = [
  'lime',
  'blue',
  'turquoise',
  'carmine',
  'carmine',
  'wathet',
  'green',
  'violet',
  'turquoise',
  'purple',
  'indigo',
] as const;

/** 未进调色板的项目(idx 未知)用与前端相同的 FNV-1a 兜底,保证同名同色 */
export function projectTagColor(name: string, idx?: number): string {
  if (idx !== undefined && idx >= 0) return PROJECT_TAG_COLORS[idx % PROJECT_TAG_COLORS.length]!;
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return PROJECT_TAG_COLORS[(h >>> 0) % PROJECT_TAG_COLORS.length]!;
}

export interface SessionRef {
  name: string;
  project: string;
  /** 项目在璇玑调色板里的序号 */
  paletteIdx?: number;
}

type El = Record<string, unknown>;

const plain = (content: string) => ({ tag: 'plain_text', content });
const md = (content: string): El => ({ tag: 'markdown', content });
const text = (content: string, color?: string): El => ({
  tag: 'div',
  text: { tag: 'plain_text', content, ...(color ? { text_color: color } : {}) },
});
const note = (content: string): El => ({ tag: 'markdown', content: `<font color='grey'>${content}</font>`, text_size: 'notation' });
const hr: El = { tag: 'hr' };

/** 代码块内容里的 ``` 会提前结束代码块,换成形近字符 */
const fence = (s: string) => '```\n' + s.replace(/```/g, 'ʼʼʼ') + '\n```';

/** 给 markdown 拼接用的短文本转义:<> 会被当成飞书富文本标签 */
export const mdSafe = (s: string) => s.replace(/</g, '‹').replace(/>/g, '›');

export function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function button(label: string, value: Record<string, unknown>, type: 'primary' | 'default' | 'danger' = 'default', extra: El = {}): El {
  return { tag: 'button', text: plain(label), type, behaviors: [{ type: 'callback', value }], ...extra };
}

function buttons(...bs: El[]): El {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: bs.map((b) => ({ tag: 'column', width: 'auto', elements: [b] })),
  };
}

function header(title: string, template: Template, ref?: SessionRef, subtitle?: string): El {
  const h: El = { title: plain(title), template };
  const sub = subtitle ?? ref?.name;
  if (sub) h.subtitle = plain(clip(sub, 60));
  if (ref) {
    h.text_tag_list = [{ tag: 'text_tag', text: plain(clip(ref.project, 24)), color: projectTagColor(ref.project, ref.paletteIdx) }];
  }
  return h;
}

function card(title: string, template: Template, elements: El[], ref?: SessionRef, subtitle?: string): object {
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    header: header(title, template, ref, subtitle),
    body: { elements },
  };
}

const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// ---------- 待审批 ----------

export interface PermView {
  ref: SessionRef;
  tool: string;
  title: string;
  input: string;
  hasAlways: boolean;
  /** pending 显示按钮;其余为已处理 */
  state: 'pending' | 'allow' | 'always' | 'deny' | 'web' | 'gone';
  resolvedAt?: number;
}

export function permCard(v: PermView): object {
  const els: El[] = [md(`**工具** ${mdSafe(v.tool)}`)];
  if (v.title && v.title !== v.tool) els.push(text(clip(v.title, 200)));
  if (v.input) els.push(md(fence(clip(v.input, 500))));
  const t = v.resolvedAt ? hhmm(v.resolvedAt) : '';
  switch (v.state) {
    case 'pending': {
      const bs = [button('批准', { a: 'perm', d: 'allow' }, 'primary')];
      if (v.hasAlways) bs.push(button('总是允许', { a: 'perm', d: 'always' }));
      bs.push(button('拒绝', { a: 'perm', d: 'deny' }, 'danger'));
      els.push(buttons(...bs));
      return card('需要审批', 'orange', els, v.ref);
    }
    case 'allow':
      els.push(note(`${t} 在飞书批准 · 会话继续运行`));
      return card('已批准', 'grey', els, v.ref);
    case 'always':
      els.push(note(`${t} 在飞书批准,本会话不再询问同类操作`));
      return card('已批准(总是允许)', 'grey', els, v.ref);
    case 'deny':
      els.push(note(`${t} 在飞书拒绝 · Claude 会收到拒绝并调整做法`));
      return card('已拒绝', 'grey', els, v.ref);
    case 'web':
      els.push(note(`${t} 已在璇玑网页处理`));
      return card('已在璇玑网页处理', 'grey', els, v.ref);
    case 'gone':
      els.push(note('这个请求已不在等待(会话已结束或已被处理)'));
      return card('已失效', 'grey', els, v.ref);
  }
}

// ---------- 提问(AskUserQuestion) ----------

export interface QuestionSpec {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export interface QuestionView {
  ref: SessionRef;
  questions: QuestionSpec[];
  state: 'pending' | 'answered' | 'web' | 'gone';
  answers?: Record<string, string>;
}

/** 单个单选题 = 选项即按钮;其余(多选 / 多题)= 表单 + 提交 */
export const questionUsesButtons = (qs: QuestionSpec[]) => qs.length === 1 && !qs[0]!.multiSelect;

export function questionCard(v: QuestionView): object {
  const els: El[] = [];
  const qLine = (q: QuestionSpec) => md(`${q.header ? `<text_tag color='orange'>${mdSafe(clip(q.header, 12))}</text_tag> ` : ''}**${mdSafe(q.question)}**`);
  if (v.state !== 'pending') {
    for (const q of v.questions) {
      els.push(qLine(q));
      const a = v.answers?.[q.question];
      if (a) els.push(text(`已回答:${a}`, 'grey'));
    }
    if (v.state === 'web') els.push(note('已在璇玑网页回答'));
    if (v.state === 'gone') els.push(note('这个提问已不在等待'));
    return card(v.state === 'gone' ? '已失效' : '已回答', 'grey', els, v.ref);
  }
  if (questionUsesButtons(v.questions)) {
    const q = v.questions[0]!;
    els.push(qLine(q));
    q.options.forEach((o, i) => {
      els.push(button(o.label, { a: 'q-pick', i }, 'default', { width: 'fill' }));
      if (o.description) els.push(note(mdSafe(o.description)));
    });
  } else {
    const form: El[] = [];
    v.questions.forEach((q, qi) => {
      form.push(qLine(q));
      if (q.multiSelect) {
        q.options.forEach((o, oi) =>
          form.push({
            tag: 'checker',
            name: `q${qi}_o${oi}`,
            checked: false,
            text: { tag: 'plain_text', content: o.description ? `${o.label} · ${o.description}` : o.label },
          }),
        );
      } else {
        form.push({
          tag: 'select_static',
          name: `q${qi}`,
          width: 'fill',
          placeholder: plain('选择一项'),
          options: q.options.map((o, oi) => ({ text: plain(o.description ? `${o.label} · ${o.description}` : o.label), value: String(oi) })),
        });
      }
    });
    form.push({ tag: 'button', text: plain('提交'), type: 'primary', name: 'q_submit', form_action_type: 'submit' });
    els.push({ tag: 'form', name: 'q_form', elements: form });
  }
  els.push(note('都不合适?引用回复本卡,直接写你的答案'));
  return card('Claude 在问你', 'orange', els, v.ref);
}

// ---------- 进度 / 回合完成 / 中断 ----------

/**
 * 进度时间线的一步。工具步有起止时刻与成败;文字步是 Claude 回合中途的发言。
 * 时间线逐条累积而不是只显示当前一步——否则第二个 Bash 会盖掉第一个,看不出进度
 * (做法参照 ~/feishu-claude 的进度卡,用户 2026-11-11 指定)。
 */
export interface Step {
  kind: 'tool' | 'text';
  /** 工具调用 id:与 tool-result 配对 */
  id?: string;
  /** 工具名;文字步为空 */
  name?: string;
  /** 工具入参摘要 / 发言摘要 */
  detail: string;
  status: 'running' | 'ok' | 'error';
  startedAt: number;
  endedAt?: number;
}

export interface ProgressView {
  ref: SessionRef;
  state: 'running' | 'done' | 'stopped';
  steps: Step[];
  elapsedMs: number;
  contextPct?: number;
  /** 渲染时刻:运行中步骤的「已跑多久」以它为准 */
  now?: number;
  /** done:Claude 本轮最终回复(markdown) */
  reply?: string;
  costUsd?: number;
  /** 回合结束时仍在跑的后台任务数 */
  background?: number;
  fullSent?: boolean;
}

/** 卡片里回复摘要的字数上限;更长的由「完整回复」分段补发 */
export const REPLY_CLIP = 1200;
/** 进度卡只留最近这么多步,更早的折成一行计数 */
export const LIVE_STEPS = 12;
/** 回合完成卡「执行过程」面板的上限,防止撑爆卡片体积 */
const LOG_STEPS = 60;

const STEP_ICON: Record<Step['status'], string> = { running: '⏳', ok: '✅', error: '❌' };

/** 步骤摘要里常有命令 / 正则:反引号、尖括号、星号都会被飞书 markdown 当成语法 */
export const stepSafe = (s: string) =>
  s.replace(/`/g, "'").replace(/</g, '‹').replace(/>/g, '›').replace(/\*/g, '\\*').replace(/\s+/g, ' ').trim();

export function stepLine(st: Step, now?: number): string {
  if (st.kind === 'text') return `💬 <font color='grey'>${stepSafe(clip(st.detail, 60))}</font>`;
  let line = `${STEP_ICON[st.status]} **${stepSafe(st.name ?? '')}**`;
  if (st.detail) line += `　\`${stepSafe(clip(st.detail, 60))}\``;
  const end = st.endedAt ?? (st.status === 'running' ? now : undefined);
  if (end !== undefined) {
    const secs = Math.floor((end - st.startedAt) / 1000);
    if (secs >= 1) line += ` <font color='grey'>${secs}s</font>`;
  }
  return line;
}

export function timeline(steps: Step[], keep: number, now?: number): string {
  const shown = steps.slice(-keep);
  const lines = shown.map((s) => stepLine(s, now));
  const hidden = steps.length - shown.length;
  if (hidden > 0) lines.unshift(`<font color='grey'>…更早的 ${hidden} 步已折叠</font>`);
  return lines.join('\n');
}

const fmtSecs = (ms: number) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};

function stage(steps: Step[]): string {
  const last = steps[steps.length - 1];
  return last?.kind === 'tool' && last.status === 'running' ? `正在执行 ${stepSafe(last.name ?? '')}…` : '正在思考…';
}

export function progressCard(v: ProgressView): object {
  const toolCount = v.steps.filter((s) => s.kind === 'tool').length;
  if (v.state === 'running') {
    const meta: string[] = [];
    if (v.elapsedMs >= 1000) meta.push(`已用 ${fmtSecs(v.elapsedMs)}`);
    if (toolCount) meta.push(`共 ${toolCount} 步`);
    if (v.contextPct !== undefined) meta.push(`上下文 ${v.contextPct}%`);
    const els: El[] = [md(`**${stage(v.steps)}**`)];
    if (meta.length) els.push(note(meta.join(' · ')));
    if (v.steps.length) els.push(md(timeline(v.steps, LIVE_STEPS, v.now)));
    els.push(buttons(button('中断', { a: 'stop' })));
    return card('进行中', 'wathet', els, v.ref);
  }
  const panel = (steps: Step[]): El => ({
    tag: 'collapsible_panel',
    expanded: false,
    header: { title: { tag: 'markdown', content: `<font color='grey'>执行过程(${steps.length} 步)</font>` } },
    elements: [md(timeline(steps, LOG_STEPS))],
  });
  if (v.state === 'stopped') {
    const els: El[] = [text('会话保留,直接发消息即可继续', 'grey')];
    if (v.steps.length) els.push(panel(v.steps));
    els.push(note(`已用 ${fmtSecs(v.elapsedMs)}${toolCount ? ` · 共 ${toolCount} 步` : ''}`));
    return card('已中断', 'grey', els, v.ref);
  }
  const reply = (v.reply ?? '').trim() || '(本轮没有文字回复)';
  const long = reply.length > REPLY_CLIP;
  const els: El[] = [md(long ? clip(reply, REPLY_CLIP) : reply)];
  // 最后一段发言就是正文,面板里不再重复
  const steps = v.steps[v.steps.length - 1]?.kind === 'text' ? v.steps.slice(0, -1) : v.steps;
  if (steps.length) els.push(panel(steps));
  const done = [`耗时 ${fmtSecs(v.elapsedMs)}`];
  if (toolCount) done.push(`工具 ${toolCount} 次`);
  if (v.costUsd !== undefined) done.push(`花费 $${v.costUsd.toFixed(2)}`);
  if (v.contextPct !== undefined) done.push(`上下文 ${v.contextPct}%`);
  els.push(note(done.join(' · ')));
  if (v.background) els.push(note(`${v.background} 个后台任务仍在执行`));
  if (long) els.push(buttons(v.fullSent ? button('已发送完整回复', { a: 'noop' }, 'default', { disabled: true }) : button('完整回复', { a: 'full' })));
  return card('回合完成', 'green', els, v.ref);
}

// ---------- 出错 ----------

export function errorCard(ref: SessionRef, message: string, state: 'pending' | 'retried' = 'pending'): object {
  const els: El[] = [md(fence(clip(message, 800))), text('会话已保留,上下文未丢失。', 'grey')];
  if (state === 'pending') els.push(buttons(button('重试上一条', { a: 'retry' }, 'primary')));
  else els.push(note('已在飞书重试'));
  return card(state === 'pending' ? '出错退出' : '出错退出 · 已重试', 'red', els, ref);
}

// ---------- 会话列表 ----------

export interface ListRow {
  sessionId: string;
  ref: SessionRef;
  detail: string;
  ago: string;
  /** 最近活动时刻:项目框之间、框内各行都按它倒序 */
  at?: number;
  kind: 'blocked' | 'running' | 'idle' | 'terminal' | 'done';
}

/** 列表行里的一句话摘要:去掉 markdown 记号与换行,只留文字(摘要常是 Claude 回复的开头) */
export const plainLine = (s: string) =>
  s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#>]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * 同一状态组内按项目归拢,每个项目一个带边框的浅色框(做法参照 anomaly-board 日报卡,用户 2026-11-11 指定)。
 * 框的边框与底色取该项目标签色的浅档,项目标签只在框顶出现一次,行内不再重复。
 * 项目之间按框内最近活动排序,框内保持看板原有顺序。
 */
function projectBoxes(list: ListRow[], currentId: string | null): El[] {
  const order: string[] = [];
  const by = new Map<string, ListRow[]>();
  const sorted = [...list].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  for (const r of sorted) {
    const k = r.ref.project;
    if (!by.has(k)) {
      by.set(k, []);
      order.push(k);
    }
    by.get(k)!.push(r);
  }
  return order.map((k, i) => {
    const rows = by.get(k)!;
    const color = projectTagColor(k, rows[0]!.ref.paletteIdx);
    const els: El[] = [md(`<text_tag color='${color}'>${mdSafe(clip(k, 24))}</text_tag> <font color='grey'>${rows.length} 个</font>`)];
    for (const r of rows) {
      let right: El;
      if (r.kind === 'terminal') right = md(`<text_tag color='neutral'>终端只读</text_tag>`);
      else if (r.kind === 'blocked') right = button('重发审批卡', { a: 'resend', s: r.sessionId }, 'default', { size: 'small' });
      else if (currentId === r.sessionId) right = md(`<text_tag color='blue'>当前</text_tag>`);
      else right = button('续接', { a: 'focus', s: r.sessionId }, 'default', { size: 'small' });
      const detail = plainLine(r.detail);
      els.push({
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: '8px',
        columns: [
          {
            tag: 'column',
            width: 'weighted',
            weight: 1,
            vertical_align: 'center',
            elements: [
              md(`**${mdSafe(clip(r.ref.name, 30))}**\n<font color='grey'>${detail ? `${mdSafe(clip(detail, 40))} · ` : ''}${r.ago}</font>`),
            ],
          },
          { tag: 'column', width: 'auto', vertical_align: 'center', elements: [right] },
        ],
      });
    }
    return {
      tag: 'interactive_container',
      width: 'fill',
      has_border: true,
      border_color: `${color}-200`,
      background_style: `${color}-50`,
      corner_radius: '8px',
      padding: '10px 12px 10px 12px',
      vertical_spacing: '6px',
      margin: i === order.length - 1 ? '0px' : '0px 0px 8px 0px',
      elements: els,
    };
  });
}

export function listCard(rows: ListRow[], currentId: string | null, opts: { all: boolean; truncated: number; currentName?: string }): object {
  const groups: [string, ListRow[]][] = [
    ['待处理', rows.filter((r) => r.kind === 'blocked')],
    ['运行中', rows.filter((r) => r.kind === 'running')],
    ['空闲 · 待验收', rows.filter((r) => r.kind === 'idle' || r.kind === 'terminal')],
  ];
  if (opts.all) groups.push(['已完成', rows.filter((r) => r.kind === 'done')]);
  const els: El[] = [];
  for (const [g, list] of groups) {
    if (!list.length) continue;
    els.push(md(`**${g} ${list.length}**`));
    els.push(...projectBoxes(list, currentId));
  }
  if (!els.length) els.push(text('没有进行中的会话', 'grey'));
  if (opts.truncated > 0) els.push(note(`另有 ${opts.truncated} 个未列出`));
  els.push(hr);
  if (opts.currentName) els.push(note(`**当前会话** ${mdSafe(opts.currentName)}`));
  const total = rows.length + opts.truncated;
  return card('会话', 'blue', els, undefined, `${total} 个${opts.all ? '' : ' · 不含已完成'}`);
}

/** 点「续接」后的回执:只有上一轮摘要(用户 2026-11-11 要求删去唤醒 / 排队说明) */
export function switchedCard(ref: SessionRef, lastReply: string | undefined): object {
  const reply = (lastReply ?? '').trim();
  return card(
    '已切换会话',
    'blue',
    [text('上一轮 Claude 说:', 'grey'), reply ? md(clip(reply, 600)) : text('(这个会话还没有回复)', 'grey')],
    ref,
  );
}

// ---------- 派发 ----------

export interface NewFormView {
  projects: { name: string; path: string }[];
  models: { id: string; label: string }[];
  defaultModel: string;
  presetProject?: string;
  presetTask?: string;
}

export function newFormCard(v: NewFormView): object {
  const proj = v.presetProject ?? v.projects[0]?.path;
  return card('派发新任务', 'blue', [
    {
      tag: 'form',
      name: 'new_form',
      elements: [
        {
          tag: 'select_static',
          name: 'proj',
          required: true,
          width: 'fill',
          placeholder: plain('项目'),
          ...(proj ? { initial_option: proj } : {}),
          options: v.projects.slice(0, 50).map((p) => ({ text: plain(p.name), value: p.path })),
        },
        {
          tag: 'input',
          name: 'task',
          required: true,
          input_type: 'multiline_text',
          rows: 3,
          width: 'fill',
          placeholder: plain('要 Claude 做什么'),
          ...(v.presetTask ? { default_value: v.presetTask } : {}),
        },
        {
          tag: 'select_static',
          name: 'model',
          width: 'fill',
          initial_option: v.defaultModel,
          options: v.models.map((m) => ({ text: plain(m.label), value: m.id })),
        },
        {
          tag: 'column_set',
          flex_mode: 'flow',
          horizontal_spacing: '8px',
          columns: [
            { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: plain('派发'), type: 'primary', name: 'new_submit', form_action_type: 'submit' }] },
            { tag: 'column', width: 'auto', elements: [button('取消', { a: 'new-cancel' })] },
          ],
        },
      ],
    },
    note('权限模式沿用璇玑设置页的默认值;需要审批时会推审批卡'),
  ]);
}

export function dispatchedCard(ref: SessionRef, task: string, model: string): object {
  return card('已派发', 'grey', [md(`**模型** ${mdSafe(model)}`), text(clip(task, 500)), note('已设为当前会话,进度见下一张卡片')], ref);
}

export function closedCard(title: string, line: string): object {
  return card(title, 'grey', [text(line, 'grey')]);
}

export function pickProjectCard(kw: string, task: string, options: { name: string; path: string }[]): object {
  return card('选择项目', 'blue', [
    text(`「${kw}」匹配到 ${options.length} 个项目:`),
    ...options.slice(0, 8).map((o) => button(o.name, { a: 'pick', p: o.path }, 'default', { width: 'fill' })),
    md(fence(clip(task, 300))),
  ]);
}

export interface RouteOption {
  sessionId: string;
  ref: SessionRef;
}

export function routeCard(textIn: string, options: RouteOption[]): object {
  const els: El[] = [text('上一次交互已超过 30 分钟,为免发错,先确认一下:', 'grey'), md(fence(clip(textIn, 300)))];
  for (const o of options.slice(0, 5)) {
    els.push(md(`<text_tag color='${projectTagColor(o.ref.project, o.ref.paletteIdx)}'>${mdSafe(clip(o.ref.project, 24))}</text_tag>`));
    els.push(button(clip(o.ref.name, 30), { a: 'route', s: o.sessionId }, 'default', { width: 'fill' }));
  }
  els.push(button('作为新任务派发…', { a: 'route-new' }, 'default', { width: 'fill' }));
  return card('发给哪个会话?', 'blue', els);
}

export function helpCard(botName: string, currentName?: string): object {
  const els: El[] = [
    md(
      [
        '- **直接发消息**:发给当前会话',
        '- **引用回复某张卡片**:发给那张卡片的会话,并设为当前',
        '- **/ls**:列出会话,可续接;**/ls all** 含已完成',
        '- **/new**:派发新任务;`/new 项目 任务` 一步到位',
        '- **/stop**:中断当前会话',
      ].join('\n'),
    ),
    note('Mac 锁屏时才主动推送;从飞书发起的回合始终回推'),
  ];
  if (currentName) els.push(note(`**当前会话** ${mdSafe(currentName)}`));
  return card(`${botName}能做什么`, 'blue', els);
}

export function infoCard(title: string, body: string, template: Template = 'blue'): object {
  return card(title, template, [text(body)]);
}
