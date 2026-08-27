import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { expandPath, resolveWorkdir } from '../src/services/paths.js';

const HOME = '/home/tester';

describe('expandPath', () => {
  it('单独的 ~ 展开为 home', () => {
    expect(expandPath('~', HOME)).toBe(HOME);
  });

  it('~/x 展开为 home 下的子路径', () => {
    expect(expandPath('~/proj/app', HOME)).toBe('/home/tester/proj/app');
  });

  it('~name 不是 home 展开(和 shell 不同,按普通相对路径处理)', () => {
    expect(expandPath('~other', HOME)).toBe(path.resolve('~other'));
  });

  it('绝对路径归一:去掉 .. 与结尾斜杠', () => {
    expect(expandPath('/a/b/../c/', HOME)).toBe('/a/c');
  });

  it('前后空白被 trim', () => {
    expect(expandPath('  /a/b  ', HOME)).toBe('/a/b');
  });

  it('缺省 home 时取 os.homedir()', () => {
    expect(expandPath('~/x')).toBe(path.join(os.homedir(), 'x'));
  });
});

describe('resolveWorkdir', () => {
  it('真实目录 isDir=true,且回带归一后的绝对路径', () => {
    const r = resolveWorkdir(os.tmpdir());
    expect(r.isDir).toBe(true);
    expect(r.path).toBe(path.resolve(os.tmpdir()));
  });

  it('不存在的路径 isDir=false(不抛错)', () => {
    expect(resolveWorkdir('/definitely/not/a/real/dir/xuanji').isDir).toBe(false);
  });

  it('存在但不是目录(文件)也判 false —— cwd 必须是目录', () => {
    expect(resolveWorkdir(import.meta.filename).isDir).toBe(false);
  });

  it('input 回带 trim 后的原始输入,供前端比对丢弃过期回包', () => {
    expect(resolveWorkdir('  /tmp  ').input).toBe('/tmp');
  });
});
