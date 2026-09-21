/**
 * 看板娘模型库:扫描 ~/.xuanji/live2d 下的 Live2D 模型目录。
 *
 * 模型是用户自己下载/购买的资产,不可重建,所以不放仓库内的 dataDir
 * (那个目录的契约是「SQLite 自有数据(可重建)」,随时可以删),也不进版本库。
 * 放用户目录还有个实际原因:本项目是 worktree-first,仓库内的路径在各个
 * worktree 之间不共享,验收环境会直接空掉。
 *
 * ~/.claude 永远不写(架构铁律 2);~/.xuanji 是璇玑自有数据目录,不受该条约束。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Live2dModelEntry {
  /** 目录名,同时作为显示名与前端缓存键 */
  name: string;
  /** model3.json 相对 baseDir 的路径,前端据此拼加载地址 */
  entry: string;
  /**
   * 目录指纹(文件数-总字节-最新 mtime)。前端缩略图缓存键带上它,
   * 用户换了模型就自动重渲染,不会一直显示旧脸。
   */
  fingerprint: string;
}

/** 单个模型目录允许的文件数上限,防止误把巨大目录丢进来拖垮扫描 */
const MAX_FILES_PER_MODEL = 2000;

function statSafe(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** 递归聚合目录指纹。只 stat 不读内容,模型目录文件数有限,成本可忽略。 */
function dirFingerprint(dir: string): string {
  let count = 0;
  let size = 0;
  let mtime = 0;
  const walk = (d: string): void => {
    if (count > MAX_FILES_PER_MODEL) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (count > MAX_FILES_PER_MODEL) return;
      const full = path.join(d, it.name);
      if (it.isDirectory()) {
        walk(full);
        continue;
      }
      const st = statSafe(full);
      if (!st) continue;
      count += 1;
      size += st.size;
      if (st.mtimeMs > mtime) mtime = st.mtimeMs;
    }
  };
  walk(dir);
  return `${count}-${size}-${Math.round(mtime)}`;
}

/**
 * 列出模型。规则刻意宽松:一层子目录里只要有 *.model3.json 就算一个模型,
 * 用户从 nizima / BOOTH 下载的包解压丢进去即可,不必改名或写配置。
 */
export function listLive2dModels(baseDir: string): Live2dModelEntry[] {
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return []; // 目录不存在 = 还没放模型,不是错误
  }
  const out: Live2dModelEntry[] = [];
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const sub = path.join(baseDir, d.name);
    let files: string[];
    try {
      files = fs.readdirSync(sub);
    } catch {
      continue;
    }
    const model3 = files.find((f) => f.toLowerCase().endsWith('.model3.json'));
    if (!model3) continue;
    out.push({
      name: d.name,
      entry: `${d.name}/${model3}`,
      fingerprint: dirFingerprint(sub),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/**
 * 把请求路径解析成磁盘路径,越界返回 null。
 * 只挡 `..` 穿越,不解 symlink——用户可能故意软链一个外部模型库进来。
 */
export function resolveLive2dFile(baseDir: string, rel: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(rel);
    } catch {
      return rel;
    }
  })();
  if (decoded.includes('\0')) return null;
  const base = path.resolve(baseDir);
  const abs = path.resolve(base, decoded);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  const st = statSafe(abs);
  if (!st || !st.isFile()) return null;
  return abs;
}

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.moc3': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

export function live2dContentType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}
