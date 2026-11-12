/** 飞书中控的输入解析(纯函数) */

export type Command =
  | { kind: 'help' }
  | { kind: 'ls'; all: boolean }
  | { kind: 'stop' }
  | { kind: 'bind' }
  | { kind: 'new'; project?: string; task?: string }
  | { kind: 'unknown'; name: string }
  | { kind: 'text'; text: string };

/**
 * 只有以 `/` 开头且命令名完全匹配的才算命令;`/ls` 之类大小写不敏感。
 * 不认识的 `/xxx` 返回 unknown 而不是当普通消息发给会话:发错一条斜杠命令进正在干活的会话,代价比提示一句大。
 * 例外:`/` 后面紧跟非字母(如路径 `/Users/…`)时按普通文本处理。
 */
export function parseCommand(input: string): Command {
  const text = input.trim();
  const m = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return { kind: 'text', text };
  const name = m[1]!.toLowerCase();
  const rest = (m[2] ?? '').trim();
  switch (name) {
    case 'help':
      return { kind: 'help' };
    case 'ls':
      return { kind: 'ls', all: rest.toLowerCase() === 'all' };
    case 'stop':
      return { kind: 'stop' };
    case 'bind':
      return { kind: 'bind' };
    case 'new': {
      if (!rest) return { kind: 'new' };
      const sp = rest.search(/\s/);
      if (sp < 0) return { kind: 'new', project: rest };
      const task = rest.slice(sp).trim();
      return { kind: 'new', project: rest.slice(0, sp), task: task || undefined };
    }
    default:
      // 路径样式(`/Users/x` 被正则截成命令名 Users 时后面紧跟 /)不会走到这里:正则要求命令名后是空白或结尾
      return { kind: 'unknown', name: `/${m[1]}` };
  }
}

/**
 * 长回复按段落切成多条消息(飞书单条消息有长度上限)。优先在空行处切,其次换行,
 * 都没有才硬切;代码块被切开时在两段各自补上围栏,保证每段单独渲染都不乱。
 */
export function splitMarkdown(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    let head = rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).trimStart();
    const fences = (head.match(/```/g) ?? []).length;
    if (fences % 2 === 1) {
      head += '\n```';
      rest = '```\n' + rest;
    }
    out.push(head);
  }
  if (rest) out.push(rest);
  return out;
}

export interface Attachments {
  /** 图片资源 key(img_xxx) */
  images: string[];
  files: { key: string; name: string }[];
  /** 去掉附件标记后剩下的文字(富文本消息里的说明) */
  text: string;
}

/**
 * 从 lark-cli 预渲染的消息内容里取出附件。实测渲染格式(lark-cli 1.0.99 convertlib):
 * 图片 `[Image: img_v3_xxx]`,文件 `<file key="file_v3_xxx" name="a.pdf"/>`;富文本(post)里图文混排。
 */
export function parseAttachments(content: string): Attachments {
  const images: string[] = [];
  const files: { key: string; name: string }[] = [];
  let text = content.replace(/\[Image:\s*([^\]\s]+)\]/g, (_, k: string) => {
    images.push(k);
    return ' ';
  });
  text = text.replace(/<file\s+key="([^"]+)"(?:\s+name="([^"]*)")?\s*\/>/g, (_, k: string, n?: string) => {
    files.push({ key: k, name: n || k });
    return ' ';
  });
  return { images, files, text: text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() };
}

/** 落盘文件名:去掉路径分隔符与控制字符,保留扩展名 */
export function safeFileName(name: string): string {
  const s = name.replace(/[\/\\\x00-\x1f]/g, '_').replace(/^\.+/, '_').trim();
  return (s || 'file').slice(0, 120);
}

/** 按文件头判图片格式;不是 Claude 支持的四种就返回 null(按普通文件处理) */
export function sniffImageType(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
