// @vitest-environment jsdom
import { act, type RefObject, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dialog, OverlayManager } from "./overlays";
import { acquireModalDocumentState } from "./modal-document-state";
import { useManagedSurface } from "./managed-surface";

function NestedDialogHarness() {
  const [outerOpen, setOuterOpen] = useState(false);
  const [innerOpen, setInnerOpen] = useState(false);
  const outerActionRef = useRef<HTMLButtonElement>(null);
  const innerActionRef = useRef<HTMLButtonElement>(null);
  return (
    <OverlayManager>
      <button id="open-outer" type="button" onClick={() => setOuterOpen(true)}>打开外层对话框</button>
      <Dialog open={outerOpen} title="外层决策" onClose={() => setOuterOpen(false)} initialFocusRef={outerActionRef}>
        <button id="open-inner" ref={outerActionRef} type="button" onClick={() => setInnerOpen(true)}>继续打开内层确认</button>
        <Dialog open={innerOpen} title="内层确认" onClose={() => setInnerOpen(false)} initialFocusRef={innerActionRef}>
          <button id="inner-action" ref={innerActionRef} type="button">确认当前事项</button>
        </Dialog>
      </Dialog>
    </OverlayManager>
  );
}

function InlineModalSurface({ open, onClose, returnFocusRef }: { open: boolean; onClose: () => void; returnFocusRef: RefObject<HTMLElement | null> }) {
  const actionRef = useRef<HTMLButtonElement>(null);
  const surface = useManagedSurface<HTMLDivElement>({
    open,
    kind: "navigation-drawer",
    onDismiss: onClose,
    modal: true,
    initialFocusRef: actionRef,
    returnFocusRef,
  });
  if (!open) return null;
  return (
    <div {...surface} id="inline-surface" role="dialog" aria-modal="true" aria-label="移动主导航">
      <button id="inline-first" ref={actionRef} type="button">第一个操作</button>
      <button id="inline-last" type="button" onClick={onClose}>关闭导航</button>
    </div>
  );
}

function InlineModalHarness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <OverlayManager>
      <main id="inline-background">工作区内容</main>
      {!open && <button id="open-inline" ref={triggerRef} type="button" onClick={() => setOpen(true)}>打开移动主导航</button>}
      <InlineModalSurface open={open} onClose={() => setOpen(false)} returnFocusRef={triggerRef} />
    </OverlayManager>
  );
}

function AssistantSurface({ open, onClose, onOpenDialog }: { open: boolean; onClose: () => void; onOpenDialog: () => void }) {
  const surface = useManagedSurface<HTMLDivElement>({
    open,
    kind: "assistant-companion",
    onDismiss: onClose,
  });
  if (!open) return null;
  return (
    <aside {...surface} id="assistant-surface" aria-label="随身助手">
      <button id="open-assistant-dialog" type="button" onClick={onOpenDialog}>打开确认</button>
    </aside>
  );
}

function MixedSurfaceHarness() {
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <OverlayManager>
      <button id="page-action" type="button">页面操作</button>
      <AssistantSurface open={assistantOpen} onClose={() => setAssistantOpen(false)} onOpenDialog={() => setDialogOpen(true)} />
      <Dialog open={dialogOpen} title="高风险确认" onClose={() => setDialogOpen(false)}>
        <button id="dialog-action" type="button">确认执行</button>
      </Dialog>
    </OverlayManager>
  );
}

let container: HTMLDivElement;
let root: Root;

async function click(selector: string) {
  const element = document.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`测试按钮不存在：${selector}`);
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

async function escape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
}

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.style.overflow = "auto";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<NestedDialogHarness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.style.overflow = "";
});

describe("统一浮层宿主的真实嵌套行为", () => {
  it("两层 Dialog 的 Esc 只关闭顶层，并逐层恢复焦点与背景锁", async () => {
    const originalTrigger = document.querySelector<HTMLButtonElement>("#open-outer")!;
    originalTrigger.focus();
    await click("#open-outer");

    const background = document.querySelector<HTMLElement>(".wl-overlay-manager__background")!;
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.activeElement?.id).toBe("open-inner");
    expect(background.hasAttribute("inert")).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");

    await click("#open-inner");
    const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
    expect(dialogs).toHaveLength(2);
    expect(document.activeElement?.id).toBe("inner-action");
    expect(dialogs[0]?.parentElement?.hasAttribute("inert")).toBe(true);

    await escape();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.activeElement?.id).toBe("open-inner");
    expect(background.hasAttribute("inert")).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");

    await escape();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    expect(document.activeElement).toBe(originalTrigger);
    expect(background.hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).toBe("auto");
  });

  it("引用计数允许外层先释放而不会提前解除 inert 或 body lock", () => {
    const target = document.createElement("main");
    document.body.append(target);
    const releaseOuter = acquireModalDocumentState(document, [target]);
    const releaseInner = acquireModalDocumentState(document, [target]);
    releaseOuter();
    expect(target.hasAttribute("inert")).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    releaseInner();
    expect(target.hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).toBe("auto");
    target.remove();
  });

  it("应用背景内的自制阻断表面只锁定外部分支，并圈定焦点后恢复触发点", async () => {
    await act(async () => root.render(<InlineModalHarness />));
    const trigger = document.querySelector<HTMLButtonElement>("#open-inline")!;
    trigger.focus();
    await click("#open-inline");

    const surface = document.querySelector<HTMLElement>("#inline-surface")!;
    const background = document.querySelector<HTMLElement>("#inline-background")!;
    expect(surface.dataset.wlManagedSurface).toBe("navigation-drawer");
    expect(surface.hasAttribute("inert")).toBe(false);
    expect(background.hasAttribute("inert")).toBe(true);
    expect(document.activeElement?.id).toBe("inline-first");
    expect(document.body.style.overflow).toBe("hidden");

    document.querySelector<HTMLButtonElement>("#inline-last")!.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      await Promise.resolve();
    });
    expect(document.activeElement?.id).toBe("inline-first");

    await escape();
    expect(document.querySelector("#inline-surface")).toBeNull();
    expect(background.hasAttribute("inert")).toBe(false);
    expect(document.activeElement?.id).toBe("open-inline");
  });

  it("常驻助手与确认框共用 LIFO 栈，Esc 每次只关闭最上层", async () => {
    await act(async () => root.render(<MixedSurfaceHarness />));
    await click("#open-assistant-dialog");
    expect(document.querySelector("#assistant-surface")).not.toBeNull();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);

    await escape();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    expect(document.querySelector("#assistant-surface")).not.toBeNull();

    await escape();
    expect(document.querySelector("#assistant-surface")).toBeNull();
  });
});
