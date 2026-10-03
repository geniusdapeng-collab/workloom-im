import * as PIXI from "pixi.js";

export interface MateWebGLSurface {
  view: HTMLCanvasElement;
  sourceView: HTMLCanvasElement;
  stage: PIXI.Container;
  render: () => void;
  destroy: () => void;
}

interface SharedRenderer {
  renderer: PIXI.Renderer;
  sourceView: HTMLCanvasElement;
  users: number;
}

let sharedRenderer: SharedRenderer | null = null;

/**
 * pixi-live2d-display 0.4 的 Cubism 4 shader 是全局单例，不能跨多个 WebGL context。
 * 同一文档用一个离屏 renderer；每个角色仍拥有自己的模型、容器与逐帧画布。
 * https://github.com/guansss/pixi-live2d-display/issues/82
 */
export function createMateWebGLSurface(size: number): MateWebGLSurface {
  if (!Number.isFinite(size) || size <= 0) throw new Error("数字人画布尺寸无效");
  const pixels = Math.ceil(size);
  const view = document.createElement("canvas");
  view.width = pixels;
  view.height = pixels;
  const context = view.getContext("2d");
  if (!context) throw new Error("数字人画布不支持逐帧合成");
  const stage = new PIXI.Container();

  if (!sharedRenderer) {
    const renderer = new PIXI.Renderer({
      width: pixels, height: pixels, resolution: 1,
      backgroundAlpha: 0, antialias: true,
      preserveDrawingBuffer: true,
    });
    const sourceView = renderer.view as HTMLCanvasElement;
    sourceView.dataset.avatarWebglSource = "true";
    sourceView.hidden = true;
    sourceView.setAttribute("aria-hidden", "true");
    sourceView.style.pointerEvents = "none";
    document.body.appendChild(sourceView);
    sharedRenderer = { renderer, sourceView, users: 0 };
  }
  const owner = sharedRenderer;
  // 只在更大的角色加入时扩容；不同尺寸逐帧切换不会反复重分配 framebuffer。
  if (owner.renderer.screen.width < pixels || owner.renderer.screen.height < pixels) {
    owner.renderer.resize(Math.max(owner.renderer.screen.width, pixels), Math.max(owner.renderer.screen.height, pixels));
  }
  owner.users += 1;
  let disposed = false;

  return {
    view, sourceView: owner.sourceView, stage,
    render: () => {
      if (disposed) return;
      owner.renderer.render(stage, { clear: true });
      context.clearRect(0, 0, pixels, pixels);
      // 同步 canvas 合成，不做 getImageData/readPixels，也不让另一角色覆盖本帧。
      context.drawImage(owner.sourceView, 0, 0, pixels, pixels, 0, 0, pixels, pixels);
    },
    destroy: () => {
      if (disposed) return;
      disposed = true;
      try { stage.destroy({ children: true }); }
      finally {
        view.remove();
        owner.users -= 1;
        if (owner.users === 0) {
          if (sharedRenderer === owner) sharedRenderer = null;
          // Pixi 6 的 destroy 无条件调用 loseContext；已经丢失的 context 无须再触发一次。
          if (owner.renderer.context.isLost) delete owner.renderer.context.extensions.loseContext;
          owner.renderer.destroy(true);
        }
      }
    },
  };
}
