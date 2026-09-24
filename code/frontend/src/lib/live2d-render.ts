/**
 * Live2D 渲染:pixi + Cubism Core 的装载与模型操作。
 *
 * pixi 约 460KB,全部走动态 import——看板娘默认关闭,关着就一个字节都不该下载。
 * Cubism Core 不在 npm(Live2D 专有许可,但官方 RedistributableFiles.txt 允许随产品
 * 再分发),所以随前端放在 public/vendor/live2d/ 下,用时挂 <script> 引入
 * (不能放 /live2d/:那整段路径被后端用于读 ~/.xuanji/live2d 下的模型文件)。
 */

import { MIN_THUMB_BYTES } from './live2d.js';

/** pixi-live2d-display 的模型实例。它没有导出可用的公开类型,这里按用到的成员收窄。 */
export interface Live2dModelLike {
  anchor: { set(x: number, y: number): void };
  scale: { set(v: number): void; x: number };
  width: number;
  height: number;
  x: number;
  y: number;
  internalModel: {
    /** 视线目标。x/y 取 -1~1,库每帧把它乘进 ParamAngleX/EyeBallX 等 */
    focusController?: { focus(x: number, y: number, instant?: boolean): void };
    settings: {
      motions?: Record<string, unknown[]>;
      hitAreas?: { Name?: string; name?: string }[];
      expressions?: unknown[];
    };
  };
  focus(x: number, y: number): void;
  motion(group: string): void;
  expression(id?: string | number): Promise<boolean>;
  hitTest(x: number, y: number): string[];
  destroy(): void;
}

/** model3.json 的原始结构里我们会去动的那部分 */
export interface Model3Source {
  url?: string;
  FileReferences?: { Expressions?: { Name: string; File: string }[] };
  HitAreas?: { Name?: string }[];
  [k: string]: unknown;
}

export interface Live2dRuntime {
  PIXI: typeof import('pixi.js');
  Live2DModel: {
    /** 传字符串会去 fetch;传 JSON 对象则直接当 settings 用(需带 url 以解析相对路径) */
    from(source: string | Model3Source, opts?: { autoInteract?: boolean }): Promise<Live2dModelLike>;
  };
}

/*
 * 放 /vendor/ 而不是 /live2d/:后端把 /live2d/* 整段用于读 ~/.xuanji/live2d 下的
 * 模型文件,Core 若也挂在 /live2d/ 下会被那条路由抢走,请求转到模型目录里找这个 js
 * 而 404。症状是「模型加载失败」,和真因(脚本被路由抢走)看着毫不相干。
 */
const CORE_SRC = '/vendor/live2d/live2dcubismcore.min.js';

let runtimePromise: Promise<Live2dRuntime> | null = null;

function loadCore(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as { Live2DCubismCore?: unknown }).Live2DCubismCore) {
      resolve();
      return;
    }
    const exist = document.querySelector<HTMLScriptElement>(`script[src="${CORE_SRC}"]`);
    if (exist) {
      exist.addEventListener('load', () => resolve());
      exist.addEventListener('error', () => reject(new Error('Cubism Core 加载失败')));
      return;
    }
    const el = document.createElement('script');
    el.src = CORE_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('Cubism Core 加载失败'));
    document.head.appendChild(el);
  });
}

/** 装载运行时。并发调用共用同一个 promise,不会重复下载 pixi。 */
export function loadRuntime(): Promise<Live2dRuntime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      await loadCore();
      const PIXI = await import('pixi.js');
      // pixi-live2d-display 要在全局拿到 PIXI 才能注册 Ticker/Loader
      (window as unknown as { PIXI: unknown }).PIXI = PIXI;
      const mod = await import('pixi-live2d-display/cubism4');
      return { PIXI, Live2DModel: mod.Live2DModel as unknown as Live2dRuntime['Live2DModel'] };
    })().catch((e: unknown) => {
      runtimePromise = null; // 失败可重试,否则一次网络抖动就永久坏掉
      throw e;
    });
  }
  return runtimePromise;
}

/**
 * 按目标显示高反推缩放。各家模型原始尺寸差异极大(官方样例里就差一倍),
 * 写死 scale 换个模型就溢出画布被裁掉半截。
 */
export function fitToHeight(model: Live2dModelLike, targetH: number): { w: number; h: number } {
  model.scale.set(1);
  const natH = model.height || 1;
  const natW = model.width || 1;
  const s = targetH / natH;
  model.scale.set(s);
  return { w: Math.max(1, Math.ceil(natW * s)), h: Math.max(1, Math.ceil(targetH)) };
}

/** 模型自报的能力。绝不写死:官方 8 个样例里没有一个有 TapHead 组,Mark 连 HitAreas 都没有。 */
export interface ModelCaps {
  head: boolean;
  body: boolean;
  motions: number;
  /** 表情数(含前端注入的那些) */
  expressions: number;
  /** 模型自己声明了命中区吗。没有的话点击退化成整体像素判定 */
  hasHitAreas: boolean;
  /** 可用于点击反馈的动作组,没有则点了不该有动作 */
  tapGroup: string | null;
}

/** 从「命中区名字 + 动作组」归纳能力,两种来源(已加载的模型 / 裸 model3.json)共用 */
export function capsFrom(
  hitNames: string[],
  motionGroups: Record<string, unknown[]>,
  expressions = 0,
): ModelCaps {
  const groups = Object.keys(motionGroups);
  return {
    head: hitNames.some((h) => /head/i.test(h)),
    body: hitNames.some((h) => /body/i.test(h)),
    motions: groups.reduce((a, g) => a + (motionGroups[g]?.length ?? 0), 0),
    expressions,
    hasHitAreas: hitNames.length > 0,
    tapGroup: groups.find((g) => /^tap/i.test(g)) ?? groups.find((g) => !/^idle$/i.test(g)) ?? null,
  };
}

export function readCaps(model: Live2dModelLike): ModelCaps {
  const st = model.internalModel.settings;
  return capsFrom(
    (st.hitAreas ?? []).map((h) => h.Name ?? h.name ?? ''),
    (st.motions ?? {}) as Record<string, unknown[]>,
    (st.expressions ?? []).length,
  );
}

/** model3.json 的原始结构(未经 pixi 规范化,字段是大写开头的) */
interface Model3Json {
  FileReferences?: { Motions?: Record<string, unknown[]>; Expressions?: unknown[] };
  HitAreas?: { Name?: string }[];
}

export function capsFromModel3(raw: unknown, extraExpressions = 0): ModelCaps {
  const j = (raw ?? {}) as Model3Json;
  return capsFrom(
    (j.HitAreas ?? []).map((h) => h.Name ?? ''),
    j.FileReferences?.Motions ?? {},
    (j.FileReferences?.Expressions ?? []).length + extraExpressions,
  );
}

/**
 * 只读 model3.json 判断能力(几 KB),不加载整个模型。
 * 早先这里走 pixi 完整加载一遍 4.7MB 的模型,只为显示一行「可戳身体 · 10 个动作」,
 * 解析把主线程占满,连带把已命中缓存的缩略图也堵住——实测三张图要等 29.5 秒,
 * 而 IndexedDB 单次读取只要 6ms。
 */
export async function fetchCaps(entry: string, extraExpressions = 0): Promise<ModelCaps> {
  const r = await fetch(modelUrl(entry));
  if (!r.ok) throw new Error(`model3.json ${r.status}`);
  return capsFromModel3(await r.json(), extraExpressions);
}

/** 能力的中文摘要,显示在设置里,让用户选之前就知道会失去什么 */
export function describeCaps(c: ModelCaps): string {
  const bits: string[] = [];
  if (c.head) bits.push('可摸头');
  if (c.body) bits.push('可戳身体');
  // 没声明命中区的模型(VTuber 模型大多如此)退化成整体像素判定,照样点得着
  if (!c.head && !c.body) bits.push('可戳(整体)');
  if (c.motions) bits.push(`${c.motions} 个动作`);
  if (c.expressions) bits.push(`${c.expressions} 个表情`);
  // 模型本身不会动,但点击仍有气泡回应,所以不能说成「无反应」
  if (!c.motions && !c.expressions) bits.push('点了只出气泡');
  return bits.join(' · ');
}

/** 模型文件地址。后端 /live2d/* 直读 ~/.xuanji/live2d。 */
export function modelUrl(entry: string): string {
  return `/live2d/${entry.split('/').map(encodeURIComponent).join('/')}`;
}

/** 扫描非透明像素的包围盒。全透明返回 null。 */
function opaqueBounds(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((data[(y * w + x) * 4 + 3] ?? 0) > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * 离屏渲染一张头像缩略图。
 *
 * 不按「头部占全身高多少」这类固定参数去裁:各家模型构图差得很远,立绘型、Q 版、
 * 兽型的头部位置完全不同,猜错就裁到一片空白(Wanko 实测如此)。
 * 改成先渲全身,扫描非透明像素求包围盒,再从包围盒顶部取一个正方形——
 * 不管什么造型,头都在最上面,这条对所有模型都成立。
 *
 * Node 端没有 WebGL,这件事只能在浏览器里做,所以渲染一次就缓存进 IndexedDB
 * (见 lib/live2d.ts)。
 */
export async function renderThumb(entry: string, opts: { size?: number } = {}): Promise<Blob> {
  const S = opts.size ?? 160;
  const R = S * 2; // 先按两倍分辨率渲全身,裁完再缩回去,避免糊
  const { PIXI, Live2DModel } = await loadRuntime();

  /*
   * 离屏 canvas 必须真的挂进 DOM。只 createElement 不挂载的话拿不到渲染帧,
   * 纹理加载永远等不到完成,renderThumb 既不 resolve 也不 reject——串行循环
   * 就卡死在第一个模型上(实测卡 55s+ 无任何回调)。
   * 挪到视口外而不是 display:none,后者同样会让它停止渲染。
   */
  const canvas = document.createElement('canvas');
  canvas.width = R;
  canvas.height = R;
  canvas.style.cssText = 'position:fixed;left:-99999px;top:0;pointer-events:none;opacity:0';
  document.body.appendChild(canvas);

  /*
   * preserveDrawingBuffer 必须开:WebGL 的 drawing buffer 默认在合成后即被清空,
   * 读出来的是空白(实测产出 1156 字节的全透明 PNG,而正常缩略图 12~31KB),
   * 而且空白图一旦进了缓存就再也不会重渲染,用户永远看到黑框。
   * autoStart 同时为 true:关掉的话纹理加载要拖到超时才收尾。
   */
  const app = new PIXI.Application({
    view: canvas,
    backgroundAlpha: 0,
    width: R,
    height: R,
    autoStart: true,
    preserveDrawingBuffer: true,
  });

  let model: Live2dModelLike | null = null;
  try {
    model = await Live2DModel.from(modelUrl(entry), { autoInteract: false });
    app.stage.addChild(model as unknown as import('pixi.js').DisplayObject);
    model.anchor.set(0.5, 0.5);
    const { h } = fitToHeight(model, R * 0.98);
    model.x = R / 2;
    model.y = h / 2 + (R - h) / 2;
    app.render();
    // 首帧纹理可能还没全部上传,等一拍再渲一次,避免缩略图糊或缺件
    await new Promise((r) => setTimeout(r, 300));
    app.render();

    // WebGL canvas 拿不到 2d context,要把它画进另一张 2d canvas 才能读像素
    const probe = document.createElement('canvas');
    probe.width = R;
    probe.height = R;
    const pctx = probe.getContext('2d');
    if (!pctx) throw new Error('缩略图裁剪失败:拿不到 2d context');
    pctx.drawImage(canvas, 0, 0);
    const px = pctx.getImageData(0, 0, R, R).data;
    const box = opaqueBounds(px, R, R);
    if (!box) throw new Error('缩略图疑似空白(无非透明像素)');

    // 从包围盒顶部取正方形:头总在最上面,这对立绘/Q版/兽型都成立
    const side = Math.min(box.w, box.h);
    const sx = box.x + (box.w - side) / 2;
    const sy = box.y;

    const out = document.createElement('canvas');
    out.width = S;
    out.height = S;
    const octx = out.getContext('2d');
    if (!octx) throw new Error('缩略图导出失败:拿不到 2d context');
    octx.drawImage(probe, sx, sy, side, side, 0, 0, S, S);

    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
    if (!blob) throw new Error('缩略图导出失败');
    // 全透明 PNG 压出来只有 1KB 出头。宁可这次失败重来,也不要把空白图存进缓存
    // ——缓存命中后就再也不会重渲染了。
    if (blob.size < MIN_THUMB_BYTES) throw new Error(`缩略图疑似空白(${blob.size}B)`);
    return blob;
  } finally {
    model?.destroy();
    app.destroy(false, { children: true });
    canvas.remove();
  }
}

/**
 * 载入模型,并把目录里没被 model3.json 引用的表情补进 settings。
 *
 * 不改用户的文件:`Live2DModel.from` 除了 URL 也接受一个 JSON 对象当 settings
 * (只要带 `url` 好让它解析相对路径),我们在内存里加一份 `Expressions` 就够了。
 * `ExpressionManager` 只在 `settings.expressions` 存在时才创建,所以这一步是
 * 「能不能切表情」的开关。
 */
export async function loadModel(entry: string, unlinkedExpressions: string[] = []): Promise<Live2dModelLike> {
  const { Live2DModel } = await loadRuntime();
  const url = modelUrl(entry);
  if (!unlinkedExpressions.length) return Live2DModel.from(url, { autoInteract: false });

  let src: Model3Source;
  try {
    src = (await (await fetch(url)).json()) as Model3Source;
  } catch {
    return Live2DModel.from(url, { autoInteract: false }); // 读不到就按原样走,别因为表情丢了整个模型
  }
  const refs = (src.FileReferences ??= {});
  refs.Expressions = [
    ...(refs.Expressions ?? []),
    // 名字去掉 .exp3.json 后缀,直接作为表情名
    ...unlinkedExpressions.map((f) => ({ Name: f.replace(/\.exp3\.json$/i, ''), File: f })),
  ];
  src.url = url;
  return Live2DModel.from(src, { autoInteract: false });
}

/**
 * 命中掩码:模型没声明 HitAreas 时的兜底。
 *
 * VTuber 模型普遍不写 HitAreas(靠面捕驱动,没有点击概念),`hitTest` 于是永远
 * 返回空数组,点了毫无反应。但也不能退化成「整个 canvas 都算命中」——canvas 是
 * 矩形,那样会把底下的发送按钮和状态栏一起挡住。
 *
 * 折中:载入后按当前姿态抽一次像素,把非透明处记成掩码,点击时查表。模型会呼吸、
 * 会摆动,轮廓有几像素出入,对「点没点到角色身上」这个判断无所谓。
 */
export interface HitMask {
  data: Uint8Array;
  w: number;
  h: number;
}

/** pixi v6 把 extract 挪进了 plugins,直接用 `renderer.extract` 会吃一条废弃警告 */
export interface PixelSource {
  plugins?: { extract?: { pixels(): Uint8Array | Uint8ClampedArray } };
  extract?: { pixels(): Uint8Array | Uint8ClampedArray };
}

export function buildHitMask(renderer: PixelSource, w: number, h: number): HitMask | null {
  try {
    const extract = renderer.plugins?.extract ?? renderer.extract;
    if (!extract) return null;
    const px = extract.pixels();
    if (!px || px.length < w * h * 4) return null;
    const data = new Uint8Array(w * h);
    let opaque = 0;
    for (let i = 0; i < w * h; i++) {
      if ((px[i * 4 + 3] ?? 0) > 8) {
        data[i] = 1;
        opaque++;
      }
    }
    return opaque ? { data, w, h } : null; // 全透明说明抽早了,当作没有
  } catch {
    return null;
  }
}

/** 查掩码。x/y 是 canvas 局部 CSS 坐标,ratio 是 canvas 物理像素与 CSS 像素之比。 */
export function maskHit(mask: HitMask, x: number, y: number, ratio: number): boolean {
  const px = Math.round(x * ratio);
  const py = Math.round(y * ratio);
  if (px < 0 || py < 0 || px >= mask.w || py >= mask.h) return false;
  return mask.data[py * mask.w + px] === 1;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * 让视线跟着鼠标。
 *
 * 不能用 `model.focus(x, y)`:它内部走 `atan2` 把坐标转成**方向角**,只取方向
 * 不取距离,幅度永远拉满。实测鼠标沿屏幕横扫一圈,targetX 在正中间从 -1 直接
 * 跳到 +1,中间一个过渡值都没有——脸只有「朝左」「朝右」两个姿态,看起来就像
 * 反应迟钝、往回滑不跟手。
 *
 * 改成按「鼠标离角色多远」线性给值:以角色中心为原点,半个屏幕为满幅度,
 * 近处小幅度、远处才拉满,中间连续。
 */
/**
 * 单轴归一。两侧各按自己那边的可用空间算,否则角色贴在右下角时,
 * 左边一下就饱和、右边那几十像素怎么移都只有零点几的幅度——看着就是「往右不转」。
 * 下限兜底:紧贴边缘时可用空间可能只剩几十像素,不加限制会敏感到抖。
 */
const AXIS_MIN_RANGE = 240;

export function axisRatioForTest(pos: number, center: number, min: number, max: number): number {
  return axisRatio(pos, center, min, max);
}

function axisRatio(pos: number, center: number, min: number, max: number): number {
  const span = pos < center ? Math.max(center - min, AXIS_MIN_RANGE) : Math.max(max - center, AXIS_MIN_RANGE);
  return clamp((pos - center) / span, -1, 1);
}

/**
 * 挑下一个要切的表情下标。
 *
 * 不能用库的 `expression()`(无参 = setRandomExpression):表情是懒加载的,
 * 未加载时 `expressions[i]` 是 undefined,而初始 `currentExpression` 也是
 * undefined,它的筛选条件 `expressions[i] !== currentExpression` 于是把所有
 * 候选全排除,直接返回 false 什么都不做——表现为点了半天偶尔才换一次表情。
 * 显式传下标走 setExpression,它会主动 await 加载,第一次点击就能生效。
 */
export function nextExpressionIndex(count: number, current: number): number {
  if (count <= 0) return -1;
  if (count === 1) return 0;
  const i = Math.floor(Math.random() * count);
  return i === current ? (i + 1) % count : i; // 不重复上一个,否则看着像没反应
}

/** 视线回正。鼠标离开窗口时用,免得视线僵在最后那个方向上不动。 */
export function focusReset(model: Live2dModelLike): void {
  model.internalModel.focusController?.focus(0, 0);
}

export function focusFromPointer(model: Live2dModelLike, clientX: number, clientY: number, rect: DOMRect): void {
  const fc = model.internalModel.focusController;
  if (!fc) return;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  fc.focus(
    axisRatio(clientX, cx, 0, window.innerWidth),
    // 屏幕 y 向下为正,而 ParamAngleY 正值是抬头,要反过来
    -axisRatio(clientY, cy, 0, window.innerHeight),
  );
}
