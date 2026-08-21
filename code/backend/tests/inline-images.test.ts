import { describe, expect, it } from 'vitest';
import { INLINE_IMAGE_MAX_COUNT, parseInlineImages } from '../src/types.js';

/** 1×1 透明 PNG 的 base64,用作合法样本 */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** 造一段解码后约 n 字节的 base64(内容无所谓,只测长度判定) */
const b64OfBytes = (n: number) => 'A'.repeat(Math.ceil(n / 3) * 4);

describe('parseInlineImages', () => {
  it('缺省/空值视为无图,而不是报错', () => {
    expect(parseInlineImages(undefined)).toEqual({ ok: true, images: [] });
    expect(parseInlineImages(null)).toEqual({ ok: true, images: [] });
  });

  it('接受合法的 png 并原样返回', () => {
    const r = parseInlineImages([{ media_type: 'image/png', data: PNG_1PX }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.images).toEqual([{ media_type: 'image/png', data: PNG_1PX }]);
  });

  it('拒收非图片 media type', () => {
    const r = parseInlineImages([{ media_type: 'image/bmp', data: PNG_1PX }]);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toContain('image/bmp');
  });

  it('拒收空数据', () => {
    expect(parseInlineImages([{ media_type: 'image/png', data: '' }])).toMatchObject({ ok: false });
  });

  it('拒收超过 5MB 的单图', () => {
    const r = parseInlineImages([{ media_type: 'image/png', data: b64OfBytes(6 * 1024 * 1024) }]);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toContain('5MB');
  });

  it('拒收超过张数上限的批次', () => {
    const many = Array.from({ length: INLINE_IMAGE_MAX_COUNT + 1 }, () => ({
      media_type: 'image/png' as const,
      data: PNG_1PX,
    }));
    expect(parseInlineImages(many)).toMatchObject({ ok: false });
  });

  it('一张不合法即整批拒收,不做部分接受', () => {
    const r = parseInlineImages([
      { media_type: 'image/png', data: PNG_1PX },
      { media_type: 'image/svg+xml', data: PNG_1PX },
    ]);
    expect(r).toMatchObject({ ok: false });
  });

  it('非数组输入被拒', () => {
    expect(parseInlineImages('nope')).toMatchObject({ ok: false });
  });
});
