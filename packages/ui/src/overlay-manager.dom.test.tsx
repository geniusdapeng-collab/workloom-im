// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dialog, OverlayManager } from "./overlays";
import { acquireModalDocumentState } from "./modal-document-state";

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
});
