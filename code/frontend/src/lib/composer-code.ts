/**
 * 派发输入框的代码语法支持:行内代码 `x` 与代码块 ```。
 *
 * 纯函数层,不碰 DOM —— 供 Dispatch 的高亮镜像层、Enter 语义判定与包裹快捷键共用。
 * 解析的是 markdown 的最小子集,口径与消息区渲染保持一致:
 *   - 围栏以行首 ``` 开启,下一条行首 ``` 关闭;到文本末尾仍未关闭 = 未闭合围栏
 *   - 行内代码只在围栏之外识别,且必须同一行内成对(跨行不算,避免半句话被误染)
 *
 * 铁律:parse() 切出的所有 text 拼回去必须逐字等于原文(见 composer-code.test.ts 的往返用例)。
 * 镜像层与 textarea 是逐像素叠放的,少一个字就整段错位。
 */

export type Seg = {
  text: string;
  /** 高亮类名;缺省为普通文本 */
  cls?: 'tk-inline' | 'tk-mark' | 'tk-lang' | 'tk-fence';
};

export type Block =
  /** 一行普通文本(可能含若干行内代码切片) */
  | { type: 'plain'; segs: Seg[] }
  /** 一段代码块(含开合围栏行);closed=false 表示还差一条收尾 ``` */
  | { type: 'fence'; closed: boolean; segs: Seg[] };

/** 块之间以换行相接:渲染时在相邻块间补 '\n',与原文行结构一一对应 */
export const BLOCK_SEP = '\n';

/** 单行内成对反引号 → 行内代码;奇数个反引号时最后一个按普通字符处理 */
function splitInline(line: string): Seg[] {
  const segs: Seg[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) segs.push({ text: line.slice(last, m.index) });
    segs.push({ text: m[0], cls: 'tk-inline' });
    last = m.index + m[0].length;
  }
  if (last < line.length) segs.push({ text: line.slice(last) });
  return segs.length ? segs : [{ text: '' }];
}

export function parse(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const open = /^```(\S*)/.exec(lines[i]!);
    if (!open) {
      out.push({ type: 'plain', segs: splitInline(lines[i]!) });
      i += 1;
      continue;
    }
    let j = i + 1;
    let closed = false;
    while (j < lines.length) {
      if (/^```\s*$/.test(lines[j]!)) {
        closed = true;
        break;
      }
      j += 1;
    }
    const end = closed ? j : lines.length - 1;
    const segs: Seg[] = [{ text: '```', cls: 'tk-mark' }];
    if (open[1]) segs.push({ text: open[1], cls: 'tk-lang' });
    // 语言名之后行内的其余字符(如 ```ts title=x)按普通文本原样保留
    const restOfOpen = lines[i]!.slice(3 + (open[1]?.length ?? 0));
    if (restOfOpen) segs.push({ text: restOfOpen });
    for (let k = i + 1; k <= end; k += 1) {
      const isCloser = closed && k === j;
      segs.push({ text: '\n' });
      segs.push(isCloser ? { text: lines[k]!, cls: 'tk-mark' } : { text: lines[k]!, cls: 'tk-fence' });
    }
    out.push({ type: 'fence', closed, segs });
    i = end + 1;
  }
  return out;
}

/** 把 parse() 的结果拼回原文 —— 测试与调试用,也是「不丢字」这条铁律的可执行定义 */
export function blocksToText(blocks: Block[]): string {
  return blocks.map((b) => b.segs.map((s) => s.text).join('')).join(BLOCK_SEP);
}

/**
 * 光标是否落在代码块内部(围栏是否已收尾都算)—— 决定 Enter 是换行还是发送。
 * 只看光标之前出现过几条行首 ```:奇数条 = 正处在一段代码块里。
 */
export function isInFence(text: string, caret: number): boolean {
  let open = false;
  for (const line of text.slice(0, caret).split('\n')) if (line.startsWith('```')) open = !open;
  return open;
}

/** 取代码块的正文(去掉开合围栏行本身)—— 消息区把用户消息渲染成 <pre> 时用 */
export function fenceBody(block: Block): string {
  return block.segs
    .filter((sg) => sg.cls === 'tk-fence')
    .map((sg) => sg.text)
    .join('\n');
}

export type EditResult = { value: string; selStart: number; selEnd: number };

/** 用反引号包裹选区(空选区则插入一对反引号并把光标放中间) */
export function wrapInline(value: string, start: number, end: number): EditResult {
  const sel = value.slice(start, end);
  return {
    value: value.slice(0, start) + '`' + sel + '`' + value.slice(end),
    selStart: start + 1,
    selEnd: start + 1 + sel.length,
  };
}

/**
 * 插入代码块骨架:选区内容进围栏,光标落在正文首字符处。
 * 若光标不在行首,先补一个换行 —— 围栏必须自成一行才会被解析成代码块。
 */
export function insertFence(value: string, start: number, end: number): EditResult {
  const sel = value.slice(start, end);
  const pre = start === 0 || value[start - 1] === '\n' ? '' : '\n';
  const inserted = `${pre}\`\`\`\n${sel}\n\`\`\`\n`;
  const bodyAt = start + pre.length + 4; // pre + "```\n"
  return {
    value: value.slice(0, start) + inserted + value.slice(end),
    selStart: bodyAt,
    selEnd: bodyAt + sel.length,
  };
}
