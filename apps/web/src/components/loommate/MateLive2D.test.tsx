// @vitest-environment jsdom
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Live2DHandle, MateGesture, MateMood } from "./MateLive2D";

type Props = { size: number; modelUrl?: string; frame?: "bust" | "full"; mood?: MateMood; gesture?: MateGesture; onReady?: (handle: Live2DHandle) => void };
type LipEvent = { type: "start" | "boundary" | "end"; text?: string; charIndex?: number };

const runtime = vi.hoisted(() => ({
  applications: [] as Array<{ view: HTMLCanvasElement; destroy: ReturnType<typeof vi.fn>; children: unknown[] }>,
  renderers: [] as Array<{ view: HTMLCanvasElement; destroy: ReturnType<typeof vi.fn>; screen: { width: number; height: number }; render: ReturnType<typeof vi.fn>; context: { isLost: boolean; extensions: { loseContext?: { loseContext: ReturnType<typeof vi.fn<() => void>> } } } }>,
  createModel: vi.fn(),
  lipListeners: new Set<(event: LipEvent) => void>(),
  offLip: vi.fn(),
  raf: new Map<number, FrameRequestCallback>(),
  nextRaf: 0,
}));

vi.mock("pixi.js", () => {
  class Container {
    children: FakeModel[] = [];
    addChild(model: FakeModel) { this.children.push(model); }
    removeChild(model: FakeModel) { this.children = this.children.filter((child) => child !== model); }
    destroy(options?: { children?: boolean }) {
      if (options?.children) for (const child of this.children) child.destroy(options);
      this.children = [];
    }
  }
  class Renderer {
    view = document.createElement("canvas");
    screen = { width: 0, height: 0 };
    context = { isLost: false, extensions: { loseContext: { loseContext: vi.fn<() => void>() } } as { loseContext?: { loseContext: ReturnType<typeof vi.fn<() => void>> } } };
    render = vi.fn();
    resize = vi.fn((width: number, height: number) => { this.screen = { width, height }; });
    destroy = vi.fn(() => { this.context.extensions.loseContext?.loseContext(); this.view.remove(); });
    constructor(options?: { width?: number; height?: number }) {
      this.screen = { width: options?.width ?? 0, height: options?.height ?? 0 };
      runtime.renderers.push(this);
    }
  }
  class Application {
    renderer = new Renderer();
    stage = new Container();
    view = this.renderer.view;
    get children() { return this.stage.children; }
    render = () => this.renderer.render(this.stage);
    destroy = vi.fn((_removeView: boolean, options?: { children?: boolean }) => {
      this.stage.destroy(options);
      this.renderer.destroy();
    });
    constructor() { runtime.applications.push(this); }
  }
  return { Application, Container, Renderer };
});

vi.mock("../../voice/VoiceEngine", () => ({
  VoiceEngine: {
    onLipSync: (listener: (event: LipEvent) => void) => {
      runtime.lipListeners.add(listener);
      return () => { runtime.offLip(); runtime.lipListeners.delete(listener); };
    },
  },
}));

class FakeModel {
  width = 500;
  height = 700;
  x = 0;
  y = 0;
  scale = { set: vi.fn() };
  anchor = { set: vi.fn() };
  internalModel = { coreModel: { setParamFloat: vi.fn() }, on: vi.fn(), off: vi.fn() };
  expression = vi.fn(() => Promise.resolve(true));
  motion = vi.fn(() => Promise.resolve(true));
  update = vi.fn();
  focus = vi.fn();
  destroy = vi.fn();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("MateLive2D startup and renderer ownership", () => {
  let container: HTMLDivElement;
  let root: Root;
  let MateLive2D: ComponentType<Props>;
  let importGate: ReturnType<typeof deferred<void>> | null;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    runtime.applications.length = 0;
    runtime.renderers.length = 0;
    runtime.createModel.mockReset().mockImplementation(() => Promise.resolve(new FakeModel()));
    runtime.offLip.mockReset();
    runtime.lipListeners.clear();
    runtime.raf.clear();
    runtime.nextRaf = 0;
    importGate = null;
    vi.doMock("pixi-live2d-display", () => importGate
      ? importGate.promise.then(() => ({ Live2DModel: { from: runtime.createModel } }))
      : { Live2DModel: { from: runtime.createModel } });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((type) => (type === "2d"
      ? { drawImage: vi.fn(), clearRect: vi.fn() } : {}) as RenderingContext);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++runtime.nextRaf;
      runtime.raf.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { runtime.raf.delete(id); });
    window.history.replaceState({}, "", "/");
    Object.assign(window, { Live2D: {}, Live2DCubismCore: {} });
    for (const key of ["__loommateLive2D", "__loommateLive2DReady", "__loommateStep", "__loommateSay", "__loommateExercise", "__loommateTelemetry", "__loommateL2DErr"]) Reflect.deleteProperty(window, key);
    document.head.querySelectorAll('script[src*="/live2d/"]').forEach((script) => script.remove());
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    ({ MateLive2D } = await import("./MateLive2D"));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock("pixi-live2d-display");
  });

  async function render(props: Partial<Props> = {}) {
    await act(async () => root.render(<MateLive2D size={400} {...props} />));
  }

  function scripts() { return [...document.head.querySelectorAll<HTMLScriptElement>('script[src*="/live2d/"]')]; }
  function mode() { return container.querySelector('[data-render-mode]')?.getAttribute("data-render-mode"); }
  function ready() { return container.querySelector('[data-avatar-ready]')?.getAttribute("data-avatar-ready"); }
  async function settleCore(script: HTMLScriptElement, success = true, expose = true) {
    if (success && expose) {
      if (script.src.includes("live2dcubismcore")) Object.assign(window, { Live2DCubismCore: {} });
      else window.Live2D = {};
    }
    await act(async () => script.dispatchEvent(new Event(success ? "load" : "error")));
    await act(async () => vi.dynamicImportSettled());
  }
  async function unmountView() { await act(async () => root.render(null)); }

  it("renders the real-backend contract and applies an initial gesture after loading", async () => {
    const model = new FakeModel();
    runtime.createModel.mockResolvedValue(model);
    const onReady = vi.fn();
    await render({ gesture: "handup", onReady });
    expect(mode()).toBe("live2d-webgl");
    expect(ready()).toBe("true");
    expect(model.motion).toHaveBeenCalledWith("TapBody");
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(window.__loommateTelemetry?.gestureCount).toBe(1);
  });

  it("preserves the canvas and model when only the caller callback changes", async () => {
    const first = vi.fn();
    const second = vi.fn();
    await render({ onReady: first });
    const canvas = container.querySelector("canvas");
    await render({ onReady: second });
    expect(container.querySelector("canvas")).toBe(canvas);
    expect(runtime.createModel).toHaveBeenCalledTimes(1);
    expect(runtime.renderers[0]!.destroy).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("uses the latest callback when loading finishes after a caller rerender", async () => {
    const load = deferred<FakeModel>();
    runtime.createModel.mockReturnValue(load.promise);
    const first = vi.fn();
    const latest = vi.fn();
    await render({ onReady: first });
    await render({ onReady: latest });
    await act(async () => load.resolve(new FakeModel()));
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(runtime.renderers).toHaveLength(1);
    expect(runtime.createModel).toHaveBeenCalledTimes(1);
  });

  it("waits for Cubism 4 when Cubism 2 is already present", async () => {
    Reflect.deleteProperty(window, "Live2DCubismCore");
    await render();
    expect(runtime.createModel).not.toHaveBeenCalled();
    expect(scripts().map((script) => new URL(script.src).pathname)).toEqual(["/live2d/live2dcubismcore.min.js"]);
    await settleCore(scripts()[0]!);
    expect(ready()).toBe("true");
  });

  it("does not reload Cubism 4 while loading a missing Cubism 2", async () => {
    Reflect.deleteProperty(window, "Live2D");
    await render();
    expect(scripts().map((script) => new URL(script.src).pathname)).toEqual(["/live2d/live2d.min.js"]);
    await settleCore(scripts()[0]!);
    expect(ready()).toBe("true");
  });

  it("shares core requests across simultaneous renderers and cancels both while waiting", async () => {
    Reflect.deleteProperty(window, "Live2D");
    Reflect.deleteProperty(window, "Live2DCubismCore");
    await act(async () => root.render(<><MateLive2D size={300} /><MateLive2D size={400} /></>));
    expect(scripts()).toHaveLength(2);
    await settleCore(scripts()[0]!);
    expect(runtime.createModel).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[data-render-mode="live2d-loading"]')).toHaveLength(2);
    await unmountView();
    await settleCore(scripts()[1]!);
    expect(runtime.createModel).not.toHaveBeenCalled();
    await render();
    expect(runtime.createModel).toHaveBeenCalledTimes(1);
    expect(ready()).toBe("true");
  });

  it("can retry a failed core load on a later mount", async () => {
    Reflect.deleteProperty(window, "Live2D");
    Reflect.deleteProperty(window, "Live2DCubismCore");
    await render();
    const failed = scripts().find((script) => script.src.includes("live2dcubismcore"))!;
    const core2 = scripts().find((script) => !script.src.includes("live2dcubismcore"))!;
    await settleCore(core2);
    await settleCore(failed, false);
    expect(mode()).toBe("vector2d");
    await unmountView();
    await render();
    const retry = scripts().find((script) => script !== failed && script.src.includes("live2dcubismcore"));
    expect(retry).toBeDefined();
    await settleCore(retry!);
    expect(mode()).toBe("live2d-webgl");
  });

  it("treats an executed core without its global runtime as a loading failure", async () => {
    Reflect.deleteProperty(window, "Live2D");
    Reflect.deleteProperty(window, "Live2DCubismCore");
    await render();
    for (const script of scripts()) await settleCore(script, true, false);
    expect(mode()).toBe("vector2d");
    expect(runtime.createModel).not.toHaveBeenCalled();
    expect((window as unknown as { __loommateL2DErr?: string }).__loommateL2DErr).toMatch(/core|runtime|运行时/i);
  });

  it("ends a stalled core load with an animated fallback within 15 seconds", async () => {
    Reflect.deleteProperty(window, "Live2D");
    Reflect.deleteProperty(window, "Live2DCubismCore");
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(mode()).toBe("vector2d");
    expect(ready()).toBe("true");
    expect((window as unknown as { __loommateL2DErr?: string }).__loommateL2DErr).toMatch(/超时|timeout/i);
    expect(runtime.renderers).toHaveLength(0);
  });

  it("ends a stalled model load, releases its canvas, and destroys a model that arrives later", async () => {
    const load = deferred<FakeModel>();
    runtime.createModel.mockReturnValue(load.promise);
    const onReady = vi.fn();
    await render({ onReady });
    const application = runtime.renderers[0]!;
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(mode()).toBe("vector2d");
    expect(application.destroy).toHaveBeenCalledTimes(1);
    const fallbackHandle = onReady.mock.calls[0]?.[0];
    const late = new FakeModel();
    await act(async () => load.resolve(late));
    expect(late.destroy).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady.mock.calls[0]?.[0]).toBe(fallbackHandle);
    expect(window.__loommateTelemetry?.backend).toBe("vector2d");
  });

  it("destroys a pending model resolved after unmount without installing listeners or globals", async () => {
    const load = deferred<FakeModel>();
    runtime.createModel.mockReturnValue(load.promise);
    const onReady = vi.fn();
    await render({ onReady });
    await unmountView();
    const late = new FakeModel();
    await act(async () => load.resolve(late));
    expect(late.destroy).toHaveBeenCalledTimes(1);
    expect(runtime.renderers[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(runtime.lipListeners.size).toBe(0);
    expect(window.__loommateLive2D).toBeUndefined();
  });

  it("does not resurrect a disposed renderer when its initial expression finishes later", async () => {
    const expression = deferred<boolean>();
    const model = new FakeModel();
    model.expression.mockReturnValue(expression.promise);
    runtime.createModel.mockResolvedValue(model);
    const onReady = vi.fn();
    await render({ mood: "happy", onReady });
    await unmountView();
    await act(async () => expression.resolve(true));
    expect(onReady).not.toHaveBeenCalled();
    expect(runtime.lipListeners.size).toBe(0);
    expect(model.internalModel.on).not.toHaveBeenCalled();
    expect(window.__loommateLive2DReady).toBeUndefined();
    expect(window.__loommateExercise).toBeUndefined();
    expect(runtime.raf.size).toBe(0);
  });

  it("does not allocate a PIXI application if the plugin import finishes after unmount", async () => {
    importGate = deferred<void>();
    await render();
    expect(runtime.renderers).toHaveLength(0);
    await unmountView();
    await act(async () => importGate!.resolve());
    expect(runtime.renderers).toHaveLength(0);
    expect(runtime.createModel).not.toHaveBeenCalled();
  });

  it("keeps a replacement renderer's probes when an old expression resolves", async () => {
    const expression = deferred<boolean>();
    const oldModel = new FakeModel();
    oldModel.expression.mockReturnValue(expression.promise);
    const replacement = new FakeModel();
    runtime.createModel.mockResolvedValueOnce(oldModel).mockResolvedValueOnce(replacement);
    const onReady = vi.fn();
    await render({ mood: "happy", onReady });
    await render({ modelUrl: "/live2d/custom/model3.json", onReady });
    const handle = window.__loommateLive2D;
    const telemetry = window.__loommateTelemetry;
    await act(async () => expression.resolve(true));
    expect(window.__loommateLive2D).toBe(handle);
    expect(window.__loommateTelemetry).toBe(telemetry);
    expect(telemetry?.modelUrl).toBe("/live2d/custom/model3.json");
    expect(runtime.lipListeners.size).toBe(1);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(runtime.renderers[1]!.destroy).not.toHaveBeenCalled();
  });

  it("publishes a ready renderer's handle and telemetry together when expressions finish out of order", async () => {
    const expression = deferred<boolean>();
    const slow = new FakeModel();
    slow.expression.mockReturnValue(expression.promise);
    runtime.createModel.mockResolvedValueOnce(slow).mockResolvedValueOnce(new FakeModel());
    await act(async () => root.render(<div><MateLive2D key="first" size={400} mood="happy" /></div>));
    await act(async () => root.render(<div><MateLive2D key="first" size={400} mood="happy" /><MateLive2D key="second" size={300} modelUrl="/live2d/custom/model3.json" /></div>));
    expect(window.__loommateTelemetry?.modelUrl).toBe("/live2d/custom/model3.json");
    await act(async () => expression.resolve(true));
    await act(async () => window.__loommateExercise?.());
    expect(window.__loommateTelemetry?.modelUrl).toBe("/live2d/mao/Mao.model3.json");
    expect(window.__loommateTelemetry?.lipStarts).toBe(1);
    expect(container.querySelectorAll('[data-avatar-ready="true"]')).toHaveLength(2);
  });

  it("shares one WebGL renderer and releases it only after the final independent surface", async () => {
    const first = new FakeModel();
    const second = new FakeModel();
    runtime.createModel.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await act(async () => root.render(<div><MateLive2D key="first" size={400} /></div>));
    await act(async () => root.render(<div><MateLive2D key="first" size={400} /><MateLive2D key="second" size={320} /></div>));
    const secondCanvas = container.querySelectorAll("canvas")[1];
    expect(runtime.renderers).toHaveLength(1);
    expect(runtime.createModel).toHaveBeenCalledTimes(2);
    await act(async () => root.render(<div><MateLive2D key="second" size={320} /></div>));
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.destroy).not.toHaveBeenCalled();
    expect(container.querySelector("canvas")).toBe(secondCanvas);
    expect(runtime.renderers[0]!.destroy).not.toHaveBeenCalled();
    await unmountView();
    expect(second.destroy).toHaveBeenCalledTimes(1);
    expect(runtime.renderers[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(document.querySelector("canvas[data-avatar-webgl-source]")).toBeNull();
    await render();
    expect(runtime.renderers).toHaveLength(2);
    expect(ready()).toBe("true");
  });

  it("ends both shared instances after loss of their real WebGL source", async () => {
    await act(async () => root.render(<div><MateLive2D key="first" size={400} /></div>));
    await act(async () => root.render(<div><MateLive2D key="first" size={400} /><MateLive2D key="second" size={320} /></div>));
    await act(async () => runtime.renderers[0]!.view.dispatchEvent(new Event("webglcontextlost")));
    expect(container.querySelectorAll('[data-render-mode="vector2d"][data-avatar-ready="true"]')).toHaveLength(2);
    expect(runtime.renderers[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(runtime.lipListeners.size).toBe(2);
  });

  it("does not write a replacement renderer's telemetry after an old prop gesture resolves", async () => {
    const pendingMotion = deferred<boolean>();
    const oldModel = new FakeModel();
    oldModel.motion.mockReturnValue(pendingMotion.promise);
    runtime.createModel.mockResolvedValueOnce(oldModel).mockResolvedValueOnce(new FakeModel());
    await render();
    await render({ gesture: "handup" });
    await render({ modelUrl: "/live2d/custom/model3.json", gesture: null });
    const telemetry = window.__loommateTelemetry;
    expect(telemetry?.gestureCount).toBe(0);
    await act(async () => pendingMotion.resolve(true));
    expect(window.__loommateTelemetry).toBe(telemetry);
    expect(telemetry?.gestureCount).toBe(0);
  });

  it("restores the surviving ready renderer's probes after removing the current owner", async () => {
    const firstReady = vi.fn();
    const secondReady = vi.fn();
    await act(async () => root.render(<div><MateLive2D key="first" size={400} onReady={firstReady} /></div>));
    const firstHandle = firstReady.mock.calls[0]?.[0];
    const firstTelemetry = window.__loommateTelemetry;
    await act(async () => root.render(<div><MateLive2D key="first" size={400} onReady={firstReady} /><MateLive2D key="second" size={320} onReady={secondReady} /></div>));
    expect(window.__loommateLive2D).toBe(secondReady.mock.calls[0]?.[0]);
    await act(async () => root.render(<div><MateLive2D key="first" size={400} onReady={firstReady} /></div>));
    expect(window.__loommateLive2D).toBe(firstHandle);
    expect(window.__loommateLive2DReady?.()).toBe(true);
    expect(window.__loommateTelemetry).toBe(firstTelemetry);
    await act(async () => window.__loommateExercise?.());
    expect(firstTelemetry?.lipStarts).toBe(1);
  });

  it("does not lose an already lost WebGL context again while releasing it", async () => {
    await render();
    const renderer = runtime.renderers[0]!;
    const lose = renderer.context.extensions.loseContext!.loseContext;
    renderer.context.isLost = true;
    await act(async () => renderer.view.dispatchEvent(new Event("webglcontextlost")));
    expect(mode()).toBe("vector2d");
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
    expect(lose).not.toHaveBeenCalled();
  });

  it("switches to the animated fallback after WebGL context loss", async () => {
    await render();
    const application = runtime.renderers[0]!;
    await act(async () => application.view.dispatchEvent(new Event("webglcontextlost")));
    expect(mode()).toBe("vector2d");
    expect(ready()).toBe("true");
    expect(application.destroy).toHaveBeenCalledTimes(1);
    expect(runtime.lipListeners.size).toBe(1);
  });

  it("preserves diagnostics and releases the renderer after an explicit model load failure", async () => {
    runtime.createModel.mockRejectedValue(new Error("synthetic model response 503"));
    await render();
    expect(mode()).toBe("vector2d");
    expect(runtime.renderers[0]!.destroy).toHaveBeenCalledTimes(1);
    expect((window as unknown as { __loommateL2DErr?: string }).__loommateL2DErr).toContain("synthetic model response 503");
  });

  it("releases only its own probes on normal unmount and cancels exercise timers", async () => {
    await render();
    const handle = window.__loommateLive2D;
    await act(async () => window.__loommateExercise?.());
    await unmountView();
    expect(window.__loommateLive2D).toBeUndefined();
    expect(window.__loommateLive2DReady).toBeUndefined();
    expect(window.__loommateTelemetry).toBeUndefined();
    expect(runtime.offLip).toHaveBeenCalledTimes(1);
    expect(runtime.raf.size).toBe(0);
    const calls = runtime.createModel.mock.calls.length;
    handle?.gesture("handup");
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(runtime.createModel).toHaveBeenCalledTimes(calls);
    expect(runtime.lipListeners.size).toBe(0);
  });

  it("drives the safe renderer without allocating WebGL resources", async () => {
    window.history.replaceState({}, "", "/?render=vector2d");
    const onReady = vi.fn();
    await render({ onReady });
    await act(async () => window.__loommateExercise?.());
    expect(mode()).toBe("vector2d");
    expect(ready()).toBe("true");
    expect(window.__loommateTelemetry?.mouthPeak).toBeGreaterThan(0);
    expect(window.__loommateTelemetry?.gestureCount).toBeGreaterThan(0);
    expect(runtime.renderers).toHaveLength(0);
    expect(onReady).toHaveBeenCalledTimes(1);
    await unmountView();
    expect(runtime.lipListeners.size).toBe(0);
    expect(window.__loommateExercise).toBeUndefined();
  });

  function installAudio(play = vi.fn(() => Promise.resolve())) {
    const audio = { play, pause: vi.fn(), onended: null as (() => void) | null, onerror: null as (() => void) | null };
    const ctx = {
      sampleRate: 48_000, destination: {}, close: vi.fn(() => Promise.resolve()),
      createMediaElementSource: () => ({ connect: vi.fn() }),
      createAnalyser: () => ({ frequencyBinCount: 256, fftSize: 0, smoothingTimeConstant: 0, connect: vi.fn(), getByteTimeDomainData: vi.fn(), getByteFrequencyData: vi.fn() }),
    };
    vi.stubGlobal("Audio", function () { return audio; });
    vi.stubGlobal("AudioContext", function () { return ctx; });
    return { audio, ctx };
  }

  it("stops its audio analysis stream and closes the context when unmounted", async () => {
    const { audio, ctx } = installAudio();
    await render();
    await act(async () => window.__loommateLive2D!.speakWithAudio("/synthetic.wav"));
    expect(audio.play).toHaveBeenCalledTimes(1);
    await unmountView();
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(runtime.raf.size).toBe(0);
  });

  it("closes audio resources after playback rejection while retaining the visual renderer", async () => {
    const { ctx } = installAudio(vi.fn(() => Promise.reject(new Error("synthetic audio rejected"))));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await render();
    await act(async () => window.__loommateLive2D!.speakWithAudio("/synthetic.wav"));
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(mode()).toBe("live2d-webgl");
    expect(runtime.lipListeners.size).toBe(1);
  });
});
