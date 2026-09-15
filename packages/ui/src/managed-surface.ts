import { type RefObject, useEffect, useId, useRef } from "react";
import { acquireModalDocumentState, restoreOverlayFocus } from "./modal-document-state";
import { useOverlayEnvironment } from "./overlay-manager";
import { activateOverlayLayer, isTopOverlayLayer } from "./overlay-stack";

export type ManagedSurfaceKind =
  | "dialog"
  | "drawer"
  | "sheet"
  | "navigation-drawer"
  | "assistant-rail"
  | "assistant-companion"
  | "welcome";

export interface ManagedSurfaceOptions {
  open: boolean;
  kind: ManagedSurfaceKind;
  onDismiss: () => void;
  /** 阻断表面会锁定背景、圈定焦点并在关闭后恢复原焦点。 */
  modal?: boolean;
  dismissOnEscape?: boolean;
  trapFocus?: boolean;
  focusOnOpen?: boolean;
  restoreFocusOnClose?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** 触发器在表面打开时会被条件卸载时，关闭后从新挂载的触发器恢复焦点。 */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export interface ManagedSurfaceBindings<T extends HTMLElement> {
  ref: RefObject<T | null>;
  tabIndex: -1 | undefined;
  "data-wl-managed-surface": ManagedSurfaceKind;
  "data-wl-surface-modal": "true" | "false";
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => (
    !element.hasAttribute("hidden")
    && !element.hasAttribute("inert")
    && element.getAttribute("aria-hidden") !== "true"
    && getComputedStyle(element).display !== "none"
    && getComputedStyle(element).visibility !== "hidden"
  ));
}

/**
 * 找出当前表面之外应被 inert 的分支。表面若位于应用背景内部，逐层锁定兄弟
 * 分支而不是把其祖先整体 inert，避免自制全屏层把自己一并禁用。
 */
function outsideTargets(surface: HTMLElement, boundary: HTMLElement | null): Element[] {
  const targets = new Set<Element>();
  let branch: Element = surface;
  let parent = branch.parentElement;
  const stop = boundary?.contains(surface) ? boundary : surface.ownerDocument.body;

  while (parent) {
    for (const sibling of Array.from(parent.children)) {
      if (sibling !== branch && !sibling.contains(surface)) targets.add(sibling);
    }
    if (parent === stop || parent === surface.ownerDocument.body) break;
    branch = parent;
    parent = parent.parentElement;
  }
  return [...targets];
}

/**
 * 统一管理 Dialog、Drawer、移动导航、欢迎仪式与常驻 AI 表面：所有表面进入同一
 * 后进先出栈；阻断表面额外复用同一套 inert、滚动锁、焦点圈定和焦点恢复。
 */
export function useManagedSurface<T extends HTMLElement>({
  open,
  kind,
  onDismiss,
  modal = false,
  dismissOnEscape = true,
  trapFocus = modal,
  focusOnOpen = modal,
  restoreFocusOnClose = modal,
  initialFocusRef,
  returnFocusRef,
}: ManagedSurfaceOptions): ManagedSurfaceBindings<T> {
  const surfaceRef = useRef<T>(null);
  const layerId = useId();
  const environment = useOverlayEnvironment();
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    if (environment && (!environment.backgroundElement || !environment.portalElement)) return;
    const surface = surfaceRef.current;
    if (!surface) return;

    const previous = surface.ownerDocument.activeElement instanceof HTMLElement
      ? surface.ownerDocument.activeElement
      : null;
    const deactivateLayer = activateOverlayLayer(layerId);
    let releaseDocumentState: () => void = () => undefined;

    if (modal) {
      const targets = environment?.backgroundElement?.contains(surface)
        ? [
          ...outsideTargets(surface, environment.backgroundElement),
          ...(environment.portalElement
            ? Array.from(environment.portalElement.children).filter((element) => !element.contains(surface))
            : []),
        ]
        : [
          ...(environment?.backgroundElement ? [environment.backgroundElement] : outsideTargets(surface, null)),
          ...(environment?.portalElement
            ? Array.from(environment.portalElement.children).filter((element) => !element.contains(surface))
            : []),
        ];
      releaseDocumentState = acquireModalDocumentState(surface.ownerDocument, targets);
    }

    if (focusOnOpen) {
      queueMicrotask(() => {
        if (!surface.isConnected) return;
        const preferred = initialFocusRef?.current;
        (preferred && surface.contains(preferred) ? preferred : (focusableElements(surface)[0] ?? surface)).focus();
      });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopOverlayLayer(layerId)) return;
      if (event.key === "Escape" && dismissOnEscape) {
        event.preventDefault();
        event.stopPropagation();
        dismissRef.current();
        return;
      }
      if (event.key !== "Tab" || !trapFocus) return;
      const items = focusableElements(surface);
      if (items.length === 0) {
        event.preventDefault();
        surface.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = surface.ownerDocument.activeElement;
      if (event.shiftKey && (active === first || active === surface || !surface.contains(active))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !surface.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
    };
    surface.ownerDocument.addEventListener("keydown", onKeyDown);
    return () => {
      surface.ownerDocument.removeEventListener("keydown", onKeyDown);
      deactivateLayer();
      releaseDocumentState();
      if (restoreFocusOnClose) {
        if (returnFocusRef) {
          queueMicrotask(() => restoreOverlayFocus(returnFocusRef.current ?? previous));
        } else {
          restoreOverlayFocus(previous);
        }
      }
    };
  }, [dismissOnEscape, environment, focusOnOpen, initialFocusRef, kind, layerId, modal, open, restoreFocusOnClose, returnFocusRef, trapFocus]);

  return {
    ref: surfaceRef,
    tabIndex: modal ? -1 : undefined,
    "data-wl-managed-surface": kind,
    "data-wl-surface-modal": modal ? "true" : "false",
  };
}
