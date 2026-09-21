import { describe, expect, it } from 'vitest';

import { LIVE2D_DEFAULTS, MIN_THUMB_BYTES, normalizeLive2d, staleThumbKeys, thumbKey } from './live2d';
import { describeCaps, modelUrl, readCaps, fitToHeight, type Live2dModelLike } from './live2d-render';

describe('normalizeLive2d', () => {
  it('坏数据全部回落默认值,不让设置把界面搞白屏', () => {
    expect(normalizeLive2d(null)).toEqual(LIVE2D_DEFAULTS);
    expect(normalizeLive2d('nope')).toEqual(LIVE2D_DEFAULTS);
    expect(normalizeLive2d({ enabled: 'yes', size: 9999, side: 'up', talk: 'loud' })).toEqual(LIVE2D_DEFAULTS);
  });

  it('保留合法字段', () => {
    expect(normalizeLive2d({ enabled: true, model: 'Mao', size: 400, side: 'left', talk: 'chat' })).toEqual({
      enabled: true,
      model: 'Mao',
      size: 400,
      side: 'left',
      talk: 'chat',
    });
  });

  it('默认关闭——升级后不该擅自在每个人界面上冒出来', () => {
    expect(LIVE2D_DEFAULTS.enabled).toBe(false);
  });
});

describe('thumbKey / staleThumbKeys', () => {
  it('键带指纹,换了模型文件就是另一个键', () => {
    expect(thumbKey('Hiyori', 'a')).not.toBe(thumbKey('Hiyori', 'b'));
  });

  it('模型没了或指纹变了的键都算失效', () => {
    const models = [{ name: 'Hiyori', fingerprint: 'f2' }];
    const existing = [thumbKey('Hiyori', 'f1'), thumbKey('Hiyori', 'f2'), thumbKey('Gone', 'x')];
    expect(staleThumbKeys(existing, models)).toEqual([thumbKey('Hiyori', 'f1'), thumbKey('Gone', 'x')]);
  });

  it('全都在用时不删任何东西', () => {
    const models = [{ name: 'A', fingerprint: 'f' }];
    expect(staleThumbKeys([thumbKey('A', 'f')], models)).toEqual([]);
  });
});

describe('modelUrl', () => {
  it('中文与空格目录名要编码,否则请求直接 404', () => {
    expect(modelUrl('我的模型/a.model3.json')).toBe(`/live2d/${encodeURIComponent('我的模型')}/a.model3.json`);
    expect(modelUrl('My Model/a.model3.json')).toBe('/live2d/My%20Model/a.model3.json');
  });

  it('不把分隔符一起编码', () => {
    expect(modelUrl('A/b.json')).toBe('/live2d/A/b.json');
  });
});

/** 造一个最小模型替身,只实现 readCaps/fitToHeight 用到的成员 */
function fakeModel(settings: Live2dModelLike['internalModel']['settings'], w = 100, h = 200): Live2dModelLike {
  let scale = 1;
  return {
    anchor: { set: () => {} },
    scale: {
      set: (v: number) => {
        scale = v;
      },
      get x() {
        return scale;
      },
    },
    get width() {
      return w * scale;
    },
    get height() {
      return h * scale;
    },
    x: 0,
    y: 0,
    internalModel: { settings },
    focus: () => {},
    motion: () => {},
    hitTest: () => [],
    destroy: () => {},
  } as unknown as Live2dModelLike;
}

describe('readCaps / describeCaps', () => {
  it('Hiyori 那种只有 Body 的模型不该显示「可摸头」', () => {
    const c = readCaps(fakeModel({ hitAreas: [{ Name: 'Body' }], motions: { Idle: [1, 2], TapBody: [3] } }));
    expect(c).toMatchObject({ head: false, body: true, motions: 3, tapGroup: 'TapBody' });
    expect(describeCaps(c)).toBe('可戳身体 · 3 个动作');
  });

  it('有 Head 命中区时标出可摸头', () => {
    const c = readCaps(fakeModel({ hitAreas: [{ Name: 'Head' }, { Name: 'Body' }], motions: { TapBody: [1] } }));
    expect(describeCaps(c)).toBe('可摸头 · 可戳身体 · 1 个动作');
  });

  it('Mark 那种没有 HitAreas 也没有 Tap 组的,如实说明点了没反应', () => {
    const c = readCaps(fakeModel({ motions: { Idle: [1, 2] } }));
    expect(c.tapGroup).toBeNull();
    expect(describeCaps(c)).toBe('无点击反应 · 2 个动作 · 仅待机动作');
  });

  it('settings 缺字段时不炸', () => {
    expect(() => readCaps(fakeModel({}))).not.toThrow();
  });
});

describe('fitToHeight', () => {
  it('按目标像素高反推缩放,不写死 scale——各家模型原始尺寸差一倍以上', () => {
    const m = fakeModel({}, 100, 200);
    expect(fitToHeight(m, 300)).toEqual({ w: 150, h: 300 });
    expect(m.scale.x).toBeCloseTo(1.5);
  });

  it('换一个原始尺寸完全不同的模型,同样的目标高仍然得到同样的高', () => {
    const big = fakeModel({}, 2000, 4000);
    expect(fitToHeight(big, 300).h).toBe(300);
  });
});

describe('MIN_THUMB_BYTES', () => {
  it('挡得住全透明 PNG,又不会误杀正常缩略图', () => {
    // 实测值:160×160 全透明 PNG 约 1156B;三个官方样例的正常缩略图 12~31KB
    const blankPng = 1156;
    const realThumbs = [12787, 29968, 31335];
    expect(blankPng).toBeLessThan(MIN_THUMB_BYTES);
    for (const size of realThumbs) expect(size).toBeGreaterThan(MIN_THUMB_BYTES);
  });
});
