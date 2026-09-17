interface InertSnapshot {
  count: number;
  hadInert: boolean;
  ariaHidden: string | null;
}

interface DocumentModalState {
  count: number;
  bodyOverflow: string;
  targets: Map<Element, InertSnapshot>;
}

const modalStates = new WeakMap<Document, DocumentModalState>();

/**
 * 引用计数式背景锁。嵌套浮层无论按何顺序卸载，都不会提前恢复 body 滚动或
 * 背景可交互状态；最后一个阻断浮层退出时才精确恢复原属性。
 */
export function acquireModalDocumentState(documentRef: Document, targets: readonly Element[]): () => void {
  let state = modalStates.get(documentRef);
  if (!state) {
    state = {
      count: 0,
      bodyOverflow: documentRef.body.style.overflow,
      targets: new Map(),
    };
    modalStates.set(documentRef, state);
  }
  if (state.count === 0) {
    state.bodyOverflow = documentRef.body.style.overflow;
    documentRef.body.style.overflow = "hidden";
  }
  state.count += 1;

  const uniqueTargets = [...new Set(targets)];
  for (const target of uniqueTargets) {
    const snapshot = state.targets.get(target);
    if (snapshot) {
      snapshot.count += 1;
      continue;
    }
    state.targets.set(target, {
      count: 1,
      hadInert: target.hasAttribute("inert"),
      ariaHidden: target.getAttribute("aria-hidden"),
    });
    target.setAttribute("inert", "");
    target.setAttribute("aria-hidden", "true");
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = modalStates.get(documentRef);
    if (!current) return;
    for (const target of uniqueTargets) {
      const snapshot = current.targets.get(target);
      if (!snapshot) continue;
      snapshot.count -= 1;
      if (snapshot.count > 0) continue;
      if (!snapshot.hadInert) target.removeAttribute("inert");
      if (snapshot.ariaHidden === null) target.removeAttribute("aria-hidden");
      else target.setAttribute("aria-hidden", snapshot.ariaHidden);
      current.targets.delete(target);
    }
    current.count = Math.max(0, current.count - 1);
    if (current.count === 0) {
      documentRef.body.style.overflow = current.bodyOverflow;
      modalStates.delete(documentRef);
    }
  };
}

export function restoreOverlayFocus(element: HTMLElement | null): void {
  if (!element || element.isConnected === false) return;
  queueMicrotask(() => element.focus());
}
