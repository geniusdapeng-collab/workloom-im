import {
  cloneElement,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import { Button, Overlay, type ButtonVariant, type OverlayProps } from "./components.js";
import { Icon } from "./icons.js";
import { useManagedSurface } from "./managed-surface.js";
import { acquireModalDocumentState, restoreOverlayFocus } from "./modal-document-state.js";
import { activateOverlayLayer, isTopOverlayLayer } from "./overlay-stack.js";

export { OverlayManager, type OverlayManagerProps } from "./overlay-manager.js";

export type DialogProps = Omit<OverlayProps, "kind">;

/** 标准模态对话框，复用唯一 Overlay 的焦点、Esc、inert 与滚动锁实现。 */
export function Dialog(props: DialogProps) {
  return <Overlay {...props} kind="dialog" />;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: Extract<ButtonVariant, "primary" | "danger">;
  confirming?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  dismissOnBackdrop?: boolean;
  dismissOnEscape?: boolean;
}

/**
 * 对需要人类裁决的动作提供统一确认边界。默认把焦点放在取消按钮，避免误操作。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel = "确认",
  cancelLabel = "取消",
  confirmVariant = "primary",
  confirming = false,
  onConfirm,
  onClose,
  dismissOnBackdrop = true,
  dismissOnEscape = true,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const safeClose = () => {
    if (!confirming) onClose();
  };

  return (
    <Overlay
      open={open}
      title={title}
      description={description}
      onClose={safeClose}
      role="alertdialog"
      initialFocusRef={cancelRef}
      closeDisabled={confirming}
      dismissOnBackdrop={dismissOnBackdrop && !confirming}
      dismissOnEscape={dismissOnEscape && !confirming}
      footer={(
        <>
          <Button ref={cancelRef} onClick={safeClose} disabled={confirming}>{cancelLabel}</Button>
          <Button variant={confirmVariant} onClick={onConfirm} busy={confirming}>{confirmLabel}</Button>
        </>
      )}
    >
      {children ?? <p className="wl-confirm-dialog__message">请确认是否继续此操作。</p>}
    </Overlay>
  );
}

export type DrawerProps = Omit<OverlayProps, "kind">;

/** 侧边任务详情或辅助操作；导航本身不应放入临时抽屉之外的第二套体系。 */
export function Drawer(props: DrawerProps) {
  return <Overlay {...props} kind="drawer" />;
}

export type SheetProps = Omit<OverlayProps, "kind" | "side">;

/** 移动端底部操作面板，复用 Overlay 的焦点圈定、Esc 和焦点恢复。 */
export function Sheet(props: SheetProps) {
  return <Overlay {...props} kind="sheet" />;
}

export interface PopoverProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  children: ReactNode;
  triggerLabel?: string;
  title?: string;
  /** 面板内可见关闭按钮的名称；非模态浮层也必须给出可见出口（Esc / 点击外部之外）。 */
  closeLabel?: string;
  placement?: "start" | "end";
  disabled?: boolean;
  dismissOnEscape?: boolean;
  dismissOnOutside?: boolean;
}

/** 非阻断浮动工具；保留触发按钮焦点，Esc 只关闭当前最上层。 */
export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  triggerLabel = "打开更多选项",
  title,
  closeLabel = "关闭",
  placement = "start",
  disabled = false,
  dismissOnEscape = true,
  dismissOnOutside = true,
  className = "",
  ...props
}: PopoverProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverSurface = useManagedSurface<HTMLDivElement>({
    open,
    kind: "popover",
    onDismiss: () => onOpenChange(false),
    modal: false,
    dismissOnEscape,
    restoreFocusOnClose: true,
    returnFocusRef: triggerRef,
  });

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onPointerDown = (event: PointerEvent) => {
      if (!dismissOnOutside || rootRef.current?.contains(event.target as Node)) return;
      onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [dismissOnOutside, onOpenChange, open]);

  return (
    <div {...props} ref={rootRef} className={`wl-popover wl-popover--${placement} ${className}`.trim()}>
      <Button
        ref={triggerRef}
        variant="quiet"
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        {trigger}
      </Button>
      {open && (
        <div {...popoverSurface} className="wl-popover__surface" id={id} role="dialog" aria-label={title ?? triggerLabel}>
          <div className="wl-popover__header">
            {title && <strong className="wl-popover__title">{title}</strong>}
            <Button
              variant="quiet"
              className="wl-popover__close"
              aria-label={closeLabel}
              title={closeLabel}
              onClick={() => onOpenChange(false)}
            >
              <Icon name="close" />
            </Button>
          </div>
          <div className="wl-popover__body">{children}</div>
        </div>
      )}
    </div>
  );
}

export interface TooltipChildProps {
  "aria-describedby"?: string;
}

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement<TooltipChildProps>;
  placement?: "top" | "bottom";
}

/** Tooltip 只作补充说明，触发元素仍必须拥有自己的可访问名称。 */
export function Tooltip({ content, children, placement = "top" }: TooltipProps) {
  const id = useId();
  const describedBy = [children.props["aria-describedby"], id].filter(Boolean).join(" ");
  return (
    <span className={`wl-tooltip wl-tooltip--${placement}`}>
      {cloneElement(children, { "aria-describedby": describedBy })}
      <span className="wl-tooltip__surface" role="tooltip" id={id}>{content}</span>
    </span>
  );
}

export type ToastTone = "success" | "info" | "warning" | "danger";

const TOAST_TITLES: Readonly<Record<ToastTone, string>> = {
  success: "操作已完成",
  info: "状态已更新",
  warning: "请注意",
  danger: "操作未完成",
};

export interface ToastProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  tone?: ToastTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}

/** 非阻断通知；错误使用 alert，其余使用礼貌播报，并始终允许落地持久反馈。 */
export function Toast({
  tone = "info",
  title,
  children,
  action,
  onDismiss,
  dismissLabel = "关闭通知",
  className = "",
  ...props
}: ToastProps) {
  return (
    <section
      {...props}
      className={`wl-toast wl-toast--${tone} ${className}`.trim()}
      role={tone === "danger" ? "alert" : "status"}
      aria-live={tone === "danger" ? "assertive" : "polite"}
    >
      <div className="wl-toast__copy">
        <strong>{title ?? TOAST_TITLES[tone]}</strong>
        {children && <div>{children}</div>}
      </div>
      {action && <div className="wl-toast__action">{action}</div>}
      {onDismiss && <Button variant="quiet" onClick={onDismiss} aria-label={dismissLabel}>关闭</Button>}
    </section>
  );
}

export interface FullscreenSurfaceProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  active: boolean;
  onActiveChange: (active: boolean) => void;
  children: ReactNode;
  label?: string;
  enterLabel?: string;
  exitLabel?: string;
  controls?: ReactNode;
  exitOnEscape?: boolean;
}

/** 统一全屏表面；F11 可由应用壳映射到 onActiveChange，Esc 永远先退出最上层全屏。 */
export function FullscreenSurface({
  active,
  onActiveChange,
  children,
  label = "全屏内容",
  enterLabel = "进入全屏",
  exitLabel = "退出全屏",
  controls,
  exitOnEscape = true,
  className = "",
  ...props
}: FullscreenSurfaceProps) {
  const surfaceRef = useRef<HTMLElement>(null);
  const layerId = useId();
  const changeRef = useRef(onActiveChange);
  changeRef.current = onActiveChange;

  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const deactivateLayer = activateOverlayLayer(layerId);
    const releaseDocumentState = acquireModalDocumentState(document, []);
    queueMicrotask(() => surfaceRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !exitOnEscape || !isTopOverlayLayer(layerId)) return;
      event.preventDefault();
      changeRef.current(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      deactivateLayer();
      releaseDocumentState();
      restoreOverlayFocus(previous);
    };
  }, [active, exitOnEscape, layerId]);

  return (
    <section
      {...props}
      ref={surfaceRef}
      className={`wl-fullscreen-surface ${active ? "wl-fullscreen-surface--active" : ""} ${className}`.trim()}
      role="region"
      aria-label={label}
      tabIndex={-1}
      data-fullscreen={active || undefined}
    >
      <div className="wl-fullscreen-surface__controls">
        {controls}
        <Button variant="secondary" onClick={() => onActiveChange(!active)}>{active ? exitLabel : enterLabel}</Button>
      </div>
      <div className="wl-fullscreen-surface__body">{children}</div>
    </section>
  );
}
