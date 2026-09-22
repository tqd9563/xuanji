/**
 * 看板娘本体:右下(或左下)常驻的 Live2D 角色 + 气泡。
 *
 * 关闭态什么都不渲染,也不 import pixi——默认关闭时零成本(见 lib/live2d-render.ts)。
 * canvas 一律 pointer-events:none:它是个矩形,吃了事件就会挡住底下真实 UI;
 * 点击命中在文档级做像素判定,只有真打到角色身上才拦截。
 */
import { useEffect, useRef, useState } from 'react';

import { type Live2dState } from '@/lib/live2d';
import {
  buildHitMask,
  fitToHeight,
  focusFromPointer,
  loadModel,
  loadRuntime,
  maskHit,
  readCaps,
  type HitMask,
  type Live2dModelLike,
  type PixelSource,
} from '@/lib/live2d-render';

/** pixi Application 里本组件用到的那部分 */
interface PixiApp {
  view: HTMLCanvasElement;
  renderer: { resize(w: number, h: number): void };
  stage: { addChild(x: unknown): void };
  destroy(removeView: boolean, opts: { children: boolean }): void;
}

interface Entry {
  name: string;
  entry: string;
  unlinkedExpressions?: string[];
}

type Kind = 'done' | 'ask' | 'fail' | 'chat' | 'poke';

const LINES: Record<Kind, [string, string][]> = {
  done: [['完成', '会话跑完了。']],
  ask: [['待输入', '有个会话在等你确认。']],
  fail: [['中断', '有个会话退出了。']],
  chat: [
    ['', '要不要清一清没合的分支?'],
    ['', '歇会儿吧。'],
    ['', '记得 commit。'],
  ],
  poke: [
    ['', '诶——别戳啦。'],
    ['', '干嘛呀？'],
  ],
};

const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)] as T;

/**
 * 点到角色身上了吗。
 * 优先用模型自己声明的命中区(能分辨头/身体);没声明就查像素掩码——
 * 绝不退化成「整个 canvas 都算」,那会把底下的 UI 一起挡掉。
 */
function hitsModel(
  model: Live2dModelLike,
  view: HTMLCanvasElement,
  rect: DOMRect,
  clientX: number,
  clientY: number,
  mask: HitMask | null,
): boolean {
  const lx = clientX - rect.left;
  const ly = clientY - rect.top;
  if ((model.hitTest(lx, ly) || []).length > 0) return true;
  if (!mask) return false;
  return maskHit(mask, lx, ly, rect.width ? view.width / rect.width : 1);
}

/**
 * 状态由上层(App)传入而非自己 useLive2d:设置面板与本组件在同一个页面里,
 * 各自读 localStorage 的话改了设置这边不会重渲染(storage 事件只跨标签页触发)。
 */
export function Live2dStage({ state }: { state: Live2dState }) {
  return state.enabled ? <Stage state={state} /> : null;
}

function Stage({ state }: { state: Live2dState }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef<Live2dModelLike | null>(null);
  const appRef = useRef<PixiApp | null>(null);
  const genRef = useRef(0);
  const tapGroupRef = useRef<string | null>(null);
  const hasExprRef = useRef(false);
  const maskRef = useRef<HitMask | null>(null);
  const [bubble, setBubble] = useState<{ tag: string; text: string; kind: Kind } | null>(null);
  const [failed, setFailed] = useState(false);
  const hideRef = useRef<number | undefined>(undefined);
  const talkRef = useRef(state.talk);
  talkRef.current = state.talk;

  const say = useRef((kind: Kind, ms = 5200) => {
    if (talkRef.current === 'mute') return;
    const [tag, text] = pick(LINES[kind]);
    setBubble({ tag, text, kind });
    window.clearTimeout(hideRef.current);
    hideRef.current = window.setTimeout(() => setBubble(null), ms);
    const m = modelRef.current;
    if (!m) return;
    const g = tapGroupRef.current;
    if (g) {
      try {
        m.motion(g);
      } catch {
        /* 动作播放失败不影响说话 */
      }
    }
    // 没有动作组的模型(VTuber 模型常态)靠表情给反馈;两者都有就一起来
    if (hasExprRef.current) {
      try {
        void m.expression();
      } catch {
        /* 同上 */
      }
    }
  }).current;

  /*
   * 装载模型。用 generation 计数守卫:StrictMode 下 effect 会跑两遍
   * (mount → unmount → mount),两次的异步加载会交错完成;若只用局部 alive 标志,
   * 先发起的那次仍可能在被清理后去写 modelRef/appRef 或重复 destroy 同一个
   * pixi app,表现为看板娘整块消失(实测踩到)。
   * 每次进入 effect 递增 generation,异步恢复后先对表,不是自己这一代就地清理退出。
   */
  useEffect(() => {
    const gen = ++genRef.current;
    let localApp: PixiApp | null = null;
    let localModel: Live2dModelLike | null = null;
    let localCanvas: HTMLCanvasElement | null = null;

    const disposeLocal = (): void => {
      localModel?.destroy();
      localModel = null;
      localApp?.destroy(false, { children: true });
      localApp = null;
      localCanvas?.remove();
      localCanvas = null;
    };

    void (async () => {
      let list: Entry[] = [];
      try {
        const d = (await (await fetch('/api/live2d/models')).json()) as { models?: Entry[] };
        list = d.models ?? [];
      } catch {
        if (genRef.current === gen) setFailed(true);
        return;
      }
      if (genRef.current !== gen) return;
      const target = list.find((m) => m.name === state.model) ?? list[0];
      if (!target) {
        if (genRef.current === gen) setFailed(true);
        return;
      }
      try {
        const { PIXI } = await loadRuntime();
        if (genRef.current !== gen || !hostRef.current) return;

        localCanvas = document.createElement('canvas');
        localCanvas.style.display = 'block';
        localCanvas.style.pointerEvents = 'none';
        hostRef.current.appendChild(localCanvas);
        localApp = new PIXI.Application({
          view: localCanvas,
          backgroundAlpha: 0,
          autoStart: true,
          width: 260,
          height: 340,
          resolution: window.devicePixelRatio || 1,
          autoDensity: true,
          // 命中掩码要把画面像素读回来。WebGL 默认合成后就清空 drawing buffer,
          // 不保留的话读出来整片透明(缩略图那边踩过同一个坑)。
          preserveDrawingBuffer: true,
        }) as unknown as PixiApp;

        localModel = await loadModel(target.entry, target.unlinkedExpressions ?? []);
        if (genRef.current !== gen) {
          disposeLocal();
          return;
        }

        localApp.stage.addChild(localModel);
        localModel.anchor.set(0.5, 0.5);
        const { w, h } = fitToHeight(localModel, state.size);
        localApp.renderer.resize(w, h);
        localModel.x = w / 2;
        localModel.y = h / 2;

        modelRef.current = localModel;
        appRef.current = localApp;
        const caps = readCaps(localModel);
        tapGroupRef.current = caps.tapGroup;
        hasExprRef.current = caps.expressions > 0;
        // 没声明 HitAreas 的模型要靠像素掩码才点得着。等一帧,首帧纹理可能还没上屏。
        maskRef.current = null;
        if (!caps.hasHitAreas) {
          window.setTimeout(() => {
            if (genRef.current !== gen || !localApp) return;
            const view = localApp.view;
            maskRef.current = buildHitMask(localApp.renderer as PixelSource, view.width, view.height);
          }, 400);
        }
        setFailed(false);
        window.setTimeout(() => {
          if (genRef.current === gen) say('done');
        }, 700);
      } catch {
        disposeLocal();
        if (genRef.current === gen) setFailed(true);
      }
    })();

    return () => {
      genRef.current += 1; // 让进行中的异步全部作废
      if (modelRef.current === localModel) modelRef.current = null;
      if (appRef.current === localApp) appRef.current = null;
      disposeLocal();
    };
  }, [state.model, state.size, say]);

  /* 视线跟随 + 像素级点击。canvas 不吃事件,所以都挂在 document 上。 */
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const m = modelRef.current;
      const app = appRef.current;
      if (!m || !app) return;
      const r = app.view.getBoundingClientRect();
      focusFromPointer(m, e.clientX, e.clientY, r.width, r.height);
      const inBox = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      const on = inBox && hitsModel(m, app.view, r, e.clientX, e.clientY, maskRef.current);
      if (hostRef.current) hostRef.current.style.cursor = on ? 'pointer' : '';
    };
    const onDown = (e: PointerEvent): void => {
      const m = modelRef.current;
      const app = appRef.current;
      if (!m || !app) return;
      const r = app.view.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      if (!hitsModel(m, app.view, r, e.clientX, e.clientY, maskRef.current)) return;
      e.preventDefault();
      e.stopPropagation();
      say('poke', 2600);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [say]);

  /* 闲聊 */
  useEffect(() => {
    if (state.talk !== 'chat') return;
    const tick = (): number =>
      window.setTimeout(
        () => {
          say('chat');
          timer = tick();
        },
        14000 + Math.random() * 12000,
      );
    let timer = tick();
    return () => window.clearTimeout(timer);
  }, [state.talk, say]);

  useEffect(() => () => window.clearTimeout(hideRef.current), []);

  if (failed) return null; // 模型没配好不该在界面上留一块空白

  const left = state.side === 'left';
  return (
    <div
      className={`l2d-stage${left ? ' l2d-left' : ''}`}
      ref={hostRef}
      data-l2d-side={state.side}
      aria-hidden="true"
    >
      {bubble && (
        <div className={`l2d-bubble l2d-on${bubble.kind === 'ask' ? ' l2d-warn' : bubble.kind === 'fail' ? ' l2d-bad' : ''}`}>
          {bubble.tag && <span className="l2d-tag">{bubble.tag}</span>}
          <span className="l2d-txt">{bubble.text}</span>
        </div>
      )}
    </div>
  );
}
