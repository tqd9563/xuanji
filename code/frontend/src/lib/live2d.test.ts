import { describe, expect, it } from 'vitest';

import { LIVE2D_DEFAULTS, MIN_THUMB_BYTES, normalizeLive2d, staleThumbKeys, thumbKey } from './live2d';
import {
  axisRatioForTest as axisRatio,
  buildHitMask,
  capsFromModel3,
  describeCaps,
  fitToHeight,
  maskHit,
  modelUrl,
  readCaps,
  type Live2dModelLike,
} from './live2d-render';

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

  it('没声明 HitAreas 的模型退化成整体判定,不再说「无点击反应」', () => {
    const c = readCaps(fakeModel({ motions: { Idle: [1, 2] } }));
    expect(c.hasHitAreas).toBe(false);
    expect(describeCaps(c)).toBe('可戳(整体) · 2 个动作');
  });

  it('VTuber 模型:没动作但有注入的表情,说明里要体现表情', () => {
    const c = capsFromModel3({ FileReferences: {} }, 10);
    expect(c).toMatchObject({ hasHitAreas: false, motions: 0, expressions: 10 });
    expect(describeCaps(c)).toBe('可戳(整体) · 10 个表情');
  });

  it('既无动作也无表情时说明只有气泡——模型不动,但点击并非毫无回应', () => {
    expect(describeCaps(capsFromModel3({ FileReferences: {} }, 0))).toBe('可戳(整体) · 点了只出气泡');
  });

  it('model3.json 自带的表情与注入的相加', () => {
    const c = capsFromModel3({ FileReferences: { Expressions: [{}, {}] } }, 3);
    expect(c.expressions).toBe(5);
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

describe('命中掩码(没有 HitAreas 的模型靠它才点得着)', () => {
  /** 造一个 4x2 的假像素缓冲,只有 (1,0) 和 (2,1) 不透明 */
  function fakeRenderer(w: number, h: number, opaque: [number, number][]) {
    const px = new Uint8Array(w * h * 4);
    for (const [x, y] of opaque) px[(y * w + x) * 4 + 3] = 255;
    return { extract: { pixels: () => px } };
  }

  it('只把非透明像素记成可命中', () => {
    const mask = buildHitMask(fakeRenderer(4, 2, [[1, 0], [2, 1]]), 4, 2)!;
    expect(mask).not.toBeNull();
    expect(maskHit(mask, 1, 0, 1)).toBe(true);
    expect(maskHit(mask, 2, 1, 1)).toBe(true);
    expect(maskHit(mask, 0, 0, 1)).toBe(false);
    expect(maskHit(mask, 3, 1, 1)).toBe(false);
  });

  it('全透明返回 null——抽早了的话宁可没有掩码,也不能整块 canvas 都算命中', () => {
    expect(buildHitMask(fakeRenderer(4, 2, []), 4, 2)).toBeNull();
  });

  it('越界不算命中', () => {
    const mask = buildHitMask(fakeRenderer(4, 2, [[1, 0]]), 4, 2)!;
    expect(maskHit(mask, -1, 0, 1)).toBe(false);
    expect(maskHit(mask, 9, 0, 1)).toBe(false);
    expect(maskHit(mask, 1, 5, 1)).toBe(false);
  });

  it('按 devicePixelRatio 缩放坐标:同一个 CSS 坐标在不同 ratio 下落到不同像素', () => {
    // 物理 4x2,只有 (1,0) 不透明。CSS 的 x=1:ratio=1 落在 1(命中),ratio=2 落在 2(透明)
    const mask = buildHitMask(fakeRenderer(4, 2, [[1, 0]]), 4, 2)!;
    expect(maskHit(mask, 1, 0, 1)).toBe(true);
    expect(maskHit(mask, 1, 0, 2)).toBe(false);
  });
});

describe('视线映射(按距离线性,不是只取方向)', () => {
  // 角色贴在右下角:中心 1181,屏幕宽 1280 —— 右边只剩 99px
  const CX = 1181;
  const W = 1280;

  it('角色正下方为 0,不再是「非左即右」的突变', () => {
    expect(axisRatio(CX, CX, 0, W)).toBe(0);
  });

  it('左半屏连续过渡,不会一下饱和', () => {
    const xs = [200, 400, 600, 800, 1000];
    const vals = xs.map((x) => axisRatio(x, CX, 0, W));
    // 严格单调递增(越靠近角色越接近 0)
    for (let i = 1; i < vals.length; i++) expect(vals[i]!).toBeGreaterThan(vals[i - 1]!);
    // 且都落在中间地带,不是清一色的 -1
    expect(vals.every((v) => v > -1 && v < 0)).toBe(true);
  });

  it('屏幕边缘取到满幅度', () => {
    expect(axisRatio(0, CX, 0, W)).toBe(-1);
  });

  it('贴边一侧靠下限兜底,不至于只剩零点几也不至于敏感到抖', () => {
    // 右边仅 99px:按可用空间算会瞬间满幅度,按下限 240 算得到约 0.41
    const v = axisRatio(W, CX, 0, W);
    expect(v).toBeGreaterThan(0.3);
    expect(v).toBeLessThan(0.5);
  });

  it('居中摆放时左右对称', () => {
    const c = W / 2;
    expect(axisRatio(0, c, 0, W)).toBeCloseTo(-axisRatio(W, c, 0, W), 5);
  });
});
