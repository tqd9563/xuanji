import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listLive2dModels, resolveLive2dFile, live2dContentType } from '../src/services/live2d.js';

let base = '';

function put(rel: string, content = 'x'): string {
  const abs = path.join(base, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-live2d-'));
  // 正常模型
  put('Hiyori/Hiyori.model3.json', '{}');
  put('Hiyori/Hiyori.moc3', 'binary');
  put('Hiyori/Hiyori.2048/texture_00.png', 'png');
  // 中文目录名 + 大写扩展名变体
  put('我买的模型/character.Model3.json', '{}');
  // 不是模型:没有 model3.json
  put('随手放的图/a.png', 'png');
  // 隐藏目录(缩略图缓存之类)不该被当成模型
  put('.thumbs/Hiyori.png', 'png');
});

afterAll(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe('listLive2dModels', () => {
  it('目录不存在时返回空数组,不抛错——还没放模型不是错误', () => {
    expect(listLive2dModels(path.join(base, 'nope'))).toEqual([]);
  });

  it('只认带 model3.json 的一层子目录,忽略其它目录与隐藏目录', () => {
    const names = listLive2dModels(base).map((m) => m.name);
    expect(names).toContain('Hiyori');
    expect(names).toContain('我买的模型');
    expect(names).not.toContain('随手放的图');
    expect(names).not.toContain('.thumbs');
  });

  it('entry 指向真实的 model3.json,大小写不敏感', () => {
    const models = listLive2dModels(base);
    expect(models.find((m) => m.name === 'Hiyori')?.entry).toBe('Hiyori/Hiyori.model3.json');
    expect(models.find((m) => m.name === '我买的模型')?.entry).toBe('我买的模型/character.Model3.json');
  });

  it('指纹随目录内容变化——用户换了模型缩略图才会重渲染', () => {
    const before = listLive2dModels(base).find((m) => m.name === 'Hiyori')!.fingerprint;
    put('Hiyori/Hiyori.2048/texture_01.png', 'another');
    const after = listLive2dModels(base).find((m) => m.name === 'Hiyori')!.fingerprint;
    expect(after).not.toBe(before);
  });
});

describe('resolveLive2dFile', () => {
  it('解析目录内的真实文件', () => {
    expect(resolveLive2dFile(base, 'Hiyori/Hiyori.moc3')).toBe(path.join(base, 'Hiyori/Hiyori.moc3'));
  });

  it('挡住 .. 穿越', () => {
    expect(resolveLive2dFile(base, '../../../etc/passwd')).toBeNull();
    expect(resolveLive2dFile(base, 'Hiyori/../../outside.txt')).toBeNull();
  });

  it('挡住 URL 编码过的 .. 穿越', () => {
    expect(resolveLive2dFile(base, '%2e%2e/%2e%2e/etc/passwd')).toBeNull();
  });

  it('目录本身与不存在的文件都返回 null', () => {
    expect(resolveLive2dFile(base, 'Hiyori')).toBeNull();
    expect(resolveLive2dFile(base, 'Hiyori/missing.moc3')).toBeNull();
  });
});

describe('live2dContentType', () => {
  it('moc3 走二进制,json 带 charset,未知扩展名兜底', () => {
    expect(live2dContentType('a/b.moc3')).toBe('application/octet-stream');
    expect(live2dContentType('a/b.model3.json')).toBe('application/json; charset=utf-8');
    expect(live2dContentType('a/b.png')).toBe('image/png');
    expect(live2dContentType('a/b.unknown')).toBe('application/octet-stream');
  });
});

describe('unlinkedExpressions', () => {
  it('挑出目录里没被 model3.json 引用的表情——VTuber 模型常把表情放着不引用', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-exp-'));
    fs.mkdirSync(path.join(d, 'ariu'));
    fs.writeFileSync(path.join(d, 'ariu/ariu.model3.json'), JSON.stringify({ FileReferences: { Moc: 'a.moc3' } }));
    fs.writeFileSync(path.join(d, 'ariu/黑化.exp3.json'), '{}');
    fs.writeFileSync(path.join(d, 'ariu/爱心眼.exp3.json'), '{}');
    const m = listLive2dModels(d)[0]!;
    expect(m.unlinkedExpressions).toEqual(['爱心眼.exp3.json', '黑化.exp3.json']);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('已经被引用的不再报——否则注入后会出现重复条目', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-exp2-'));
    fs.mkdirSync(path.join(d, 'm'));
    fs.writeFileSync(
      path.join(d, 'm/m.model3.json'),
      JSON.stringify({ FileReferences: { Expressions: [{ Name: 'a', File: 'a.exp3.json' }] } }),
    );
    fs.writeFileSync(path.join(d, 'm/a.exp3.json'), '{}');
    fs.writeFileSync(path.join(d, 'm/b.exp3.json'), '{}');
    expect(listLive2dModels(d)[0]!.unlinkedExpressions).toEqual(['b.exp3.json']);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('model3.json 不是合法 JSON 时不抛错,全部当未引用', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-exp3-'));
    fs.mkdirSync(path.join(d, 'm'));
    fs.writeFileSync(path.join(d, 'm/m.model3.json'), '{ broken');
    fs.writeFileSync(path.join(d, 'm/a.exp3.json'), '{}');
    expect(() => listLive2dModels(d)).not.toThrow();
    expect(listLive2dModels(d)[0]!.unlinkedExpressions).toEqual(['a.exp3.json']);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('没有表情文件时是空数组,不是 undefined', () => {
    expect(listLive2dModels(base).find((m) => m.name === 'Hiyori')!.unlinkedExpressions).toEqual([]);
  });
});
