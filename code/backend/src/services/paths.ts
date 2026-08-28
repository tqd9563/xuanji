/**
 * 工作目录路径解析:把用户手输的路径(`~` 开头或绝对路径)归一成绝对路径并校验存在性。
 * 存在的意义是 /wd 弹窗的候选只来自 ~/.claude/projects 扫描结果,全新目录从未有过会话、
 * 搜不到也就切不过去;手输路径这条旁路需要后端来展开 `~`(前端拿不到 home)并挡住笔误。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ResolvedWorkdir {
  /** 用户原始输入(已 trim) */
  input: string;
  /** 归一后的绝对路径 */
  path: string;
  /** 路径存在且是目录 —— 派发的唯一放行条件 */
  isDir: boolean;
}

/** `~`/`~/x` 展开为 home;其余交给 path.resolve 归一(去掉 `..`、结尾斜杠) */
export function expandPath(input: string, home: string = os.homedir()): string {
  const t = input.trim();
  if (t === '~') return home;
  if (t.startsWith('~/')) return path.resolve(home, t.slice(2));
  return path.resolve(t);
}

export function resolveWorkdir(input: string, home?: string): ResolvedWorkdir {
  const abs = expandPath(input, home);
  let isDir = false;
  try {
    isDir = fs.statSync(abs).isDirectory();
  } catch {
    // 不存在 / 无权限:一律按不可用处理,由前端提示,不区分原因
  }
  return { input: input.trim(), path: abs, isDir };
}
