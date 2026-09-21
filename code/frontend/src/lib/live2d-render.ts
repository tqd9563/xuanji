/**
 * Live2D 渲染:pixi + Cubism Core 的装载与模型操作。
 *
 * pixi 约 460KB,全部走动态 import——看板娘默认关闭,关着就一个字节都不该下载。
 * Cubism Core 不在 npm(Live2D 专有许可,但官方 RedistributableFiles.txt 允许随产品
 * 再分发),所以随前端放在 public/live2d/ 下,用时挂 <script> 引入。
 */

/** pixi-live2d-display 的模型实例。它没有导出可用的公开类型,这里按用到的成员收窄。 */
export interface Live2dModelLike {
  anchor: { set(x: number, y: number): void };
  scale: { set(v: number): void; x: number };
  width: number;
  height: number;
  x: number;
  y: number;
  internalModel: {
    settings: {
      motions?: Record<string, unknown[]>;
      hitAreas?: { Name?: string; name?: string }[];
    };
  };
  focus(x: number, y: number): void;
  motion(group: string): void;
  hitTest(x: number, y: number): string[];
  destroy(): void;
}

export interface Live2dRuntime {
  PIXI: typeof import('pixi.js');
  Live2DModel: {
    from(url: string, opts?: { autoInteract?: boolean }): Promise<Live2dModelLike>;
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
  /** 可用于点击反馈的动作组,没有则点了不该有动作 */
  tapGroup: string | null;
}

/** 从「命中区名字 + 动作组」归纳能力,两种来源(已加载的模型 / 裸 model3.json)共用 */
export function capsFrom(hitNames: string[], motionGroups: Record<string, unknown[]>): ModelCaps {
  const groups = Object.keys(motionGroups);
  return {
    head: hitNames.some((h) => /head/i.test(h)),
    body: hitNames.some((h) => /body/i.test(h)),
    motions: groups.reduce((a, g) => a + (motionGroups[g]?.length ?? 0), 0),
    tapGroup: groups.find((g) => /^tap/i.test(g)) ?? groups.find((g) => !/^idle$/i.test(g)) ?? null,
  };
}

export function readCaps(model: Live2dModelLike): ModelCaps {
  const st = model.internalModel.settings;
  return capsFrom(
    (st.hitAreas ?? []).map((h) => h.Name ?? h.name ?? ''),
    (st.motions ?? {}) as Record<string, unknown[]>,
  );
}

/** model3.json 的原始结构(未经 pixi 规范化,字段是大写开头的) */
interface Model3Json {
  FileReferences?: { Motions?: Record<string, unknown[]> };
  HitAreas?: { Name?: string }[];
}

export function capsFromModel3(raw: unknown): ModelCaps {
  const j = (raw ?? {}) as Model3Json;
  return capsFrom(
    (j.HitAreas ?? []).map((h) => h.Name ?? ''),
    j.FileReferences?.Motions ?? {},
  );
}

/**
 * 只读 model3.json 判断能力(几 KB),不加载整个模型。
 * 早先这里走 pixi 完整加载一遍 4.7MB 的模型,只为显示一行「可戳身体 · 10 个动作」,
 * 解析把主线程占满,连带把已命中缓存的缩略图也堵住——实测三张图要等 29.5 秒,
 * 而 IndexedDB 单次读取只要 6ms。
 */
export async function fetchCaps(entry: string): Promise<ModelCaps> {
  const r = await fetch(modelUrl(entry));
  if (!r.ok) throw new Error(`model3.json ${r.status}`);
  return capsFromModel3(await r.json());
}

/** 能力的中文摘要,显示在设置里,让用户选之前就知道会失去什么 */
export function describeCaps(c: ModelCaps): string {
  const bits: string[] = [];
  if (c.head) bits.push('可摸头');
  if (c.body) bits.push('可戳身体');
  if (!c.head && !c.body) bits.push('无点击反应');
  bits.push(`${c.motions} 个动作`);
  if (!c.tapGroup) bits.push('仅待机动作');
  return bits.join(' · ');
}

/** 模型文件地址。后端 /live2d/* 直读 ~/.xuanji/live2d。 */
export function modelUrl(entry: string): string {
  return `/live2d/${entry.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * 离屏渲染一张头部缩略图。Node 端没有 WebGL,这件事只能在浏览器里做,
 * 所以渲染一次就缓存进 IndexedDB(见 lib/live2d.ts)。
 *
 * headTop/headFrac 描述「头部在全身高里的位置与占比」——各家模型构图不同,
 * 兽型/Q 版的头会比立绘型低且大,给了默认值也允许按模型调。
 */
export async function renderThumb(
  entry: string,
  opts: { size?: number; headTop?: number; headFrac?: number } = {},
): Promise<Blob> {
  const S = opts.size ?? 160;
  const headTop = opts.headTop ?? 0.02;
  const headFrac = opts.headFrac ?? 0.32;
  const { PIXI, Live2DModel } = await loadRuntime();

  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  /*
   * autoStart 必须为 true:没有 ticker 驱动时,模型的纹理加载要拖到超时才收尾,
   * 实测每张缩略图要 60~80 秒(Hiyori@81s → Mao@160s → Wanko@222s),
   * 开着 ticker 后是十秒级。渲完即 destroy,不会长期占用。
   */
  const app = new PIXI.Application({ view: canvas, backgroundAlpha: 0, width: S, height: S, autoStart: true });
  let model: Live2dModelLike | null = null;
  try {
    model = await Live2DModel.from(modelUrl(entry), { autoInteract: false });
    app.stage.addChild(model as unknown as import('pixi.js').DisplayObject);
    model.anchor.set(0.5, 0.5);
    model.scale.set(1);
    const natH = model.height || 1;
    const s = S / (natH * headFrac);
    model.scale.set(s);
    model.x = S / 2;
    model.y = S / 2 - (headTop + headFrac / 2 - 0.5) * natH * s;
    app.render();
    // 首帧纹理可能还没全部上传,等一拍再渲一次,避免缩略图糊或缺件
    await new Promise((r) => setTimeout(r, 250));
    app.render();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('缩略图导出失败');
    return blob;
  } finally {
    model?.destroy();
    app.destroy(false, { children: true });
  }
}

/** 视口坐标 -> canvas 局部坐标。focus() 收的是局部坐标,直接喂 clientX 会被 clamp 成死盯一角。 */
export function focusFromPointer(model: Live2dModelLike, clientX: number, clientY: number, w: number, h: number): void {
  model.focus((clientX / window.innerWidth) * w, (clientY / window.innerHeight) * h);
}
