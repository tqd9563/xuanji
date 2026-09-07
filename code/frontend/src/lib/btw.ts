/**
 * 旁路提问(/btw)的文本约定 —— 输入框与发送逻辑共用同一份解析,别在两处各写一遍正则。
 * 与 CLI 一致:`/btw` 大小写不敏感,后面直接跟问题;只有前缀没有问题 = 打开面板看用法/记录。
 */
const BTW_RE = /^\/btw\b/i;

export function isBtwText(text: string): boolean {
  return BTW_RE.test(text.trimStart());
}

/** null = 不是旁路提问;question 为空串 = 只敲了 /btw */
export function parseBtw(text: string): { question: string } | null {
  const t = text.trimStart();
  if (!BTW_RE.test(t)) return null;
  return { question: t.replace(BTW_RE, '').trim() };
}

/** 钉入主对话时发出的正文:这一问一答作为用户的一条消息进入主对话(唯一会进主对话的路径) */
export function pinText(question: string, answer: string): string {
  return `之前旁路问过:${question}\n结论:${answer.trim()}`;
}
