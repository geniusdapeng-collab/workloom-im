import {
  type ButtonHTMLAttributes,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import { acquireModalDocumentState, restoreOverlayFocus } from "./modal-document-state";
import { useOverlayEnvironment } from "./overlay-manager";
import { activateOverlayLayer, isTopOverlayLayer } from "./overlay-stack";

export type ButtonVariant = "primary" | "secondary" | "danger" | "quiet";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  busy?: boolean;
  busyLabel?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "secondary", busy = false, busyLabel = "处理中…", disabled, children, className = "", ...props }, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type={props.type ?? "button"}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`wl-button wl-button--${variant} ${className}`.trim()}
    >
      {busy ? busyLabel : children}
    </button>
  );
});

export function Card({ className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <section {...props} className={`wl-card ${className}`.trim()} />;
}

export function Badge({ tone = "neutral", className = "", ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "success" | "warning" | "danger" | "info" }) {
  return <span {...props} className={`wl-badge wl-badge--${tone} ${className}`.trim()} />;
}

export type AsyncStatus = "loading" | "empty" | "error" | "forbidden" | "ready";

export interface AsyncStateProps {
  status: AsyncStatus;
  children?: ReactNode;
  title?: string;
  description?: ReactNode;
  visual?: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  action?: ReactNode;
  className?: string;
}

const STATE_DEFAULTS: Record<Exclude<AsyncStatus, "ready">, [string, string]> = {
  loading: ["正在加载", "请稍候，数据尚未准备完成。"],
  empty: ["暂无数据", "完成相关操作后，内容会显示在这里。"],
  error: ["暂时无法加载", "数据没有被当作空结果处理，请重试或查看诊断信息。"],
  forbidden: ["暂无访问权限", "请联系工作区管理员确认角色和权限范围。"],
};

export function AsyncState({ status, children, title, description, visual, onRetry, retrying, action, className = "" }: AsyncStateProps) {
  if (status === "ready") return <>{children}</>;
  const [defaultTitle, defaultDescription] = STATE_DEFAULTS[status];
  return (
    <div className={`wl-state wl-state--${status} ${className}`.trim()} role={status === "error" ? "alert" : "status"} aria-live={status === "error" ? "assertive" : "polite"}>
      {status === "loading" && <span className="wl-spinner" aria-hidden />}
      {visual && <div className="wl-state__visual" aria-hidden>{visual}</div>}
      <strong>{title ?? defaultTitle}</strong>
      <p>{description ?? defaultDescription}</p>
      {status === "error" && onRetry && <Button onClick={onRetry} busy={retrying}>重新加载</Button>}
      {action}
    </div>
  );
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
}

export interface OverlayProps {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  kind?: "dialog" | "drawer" | "sheet";
  side?: "left" | "right";
  role?: "dialog" | "alertdialog";
  initialFocusRef?: RefObject<HTMLElement | null>;
  closeLabel?: string;
  closeDisabled?: boolean;
  dismissOnBackdrop?: boolean;
  dismissOnEscape?: boolean;
}

export function Overlay({
  open,
  title,
  description,
  children,
  onClose,
  footer,
  kind = "dialog",
  side = "right",
  role = "dialog",
  initialFocusRef,
  closeLabel = "关闭",
  closeDisabled = false,
  dismissOnBackdrop = true,
  dismissOnEscape = true,
}: OverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayEnvironment = useOverlayEnvironment();
  const titleId = useId();
  const descriptionId = useId();
  const stackId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    if (overlayEnvironment && (!overlayEnvironment.backgroundElement || !overlayEnvironment.portalElement)) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const deactivateLayer = activateOverlayLayer(stackId);
    const inerted = overlayEnvironment?.backgroundElement && overlayEnvironment.portalElement
      ? [
        overlayEnvironment.backgroundElement,
        ...Array.from(overlayEnvironment.portalElement.children).filter((element) => !element.contains(panel)),
      ]
      : Array.from(document.body.children).filter((element) => !element.contains(panel));
    const releaseDocumentState = acquireModalDocumentState(document, inerted);
    queueMicrotask(() => {
      if (!panel) return;
      const preferred = initialFocusRef?.current;
      (preferred && panel.contains(preferred) ? preferred : (focusableElements(panel)[0] ?? panel)).focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopOverlayLayer(stackId)) return;
      if (event.key === "Escape" && dismissOnEscape) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = focusableElements(panel);
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      deactivateLayer();
      releaseDocumentState();
      restoreOverlayFocus(previous);
    };
  }, [dismissOnEscape, initialFocusRef, open, overlayEnvironment, stackId]);

  if (!open) return null;
  if (typeof document === "undefined") return null;
  if (overlayEnvironment && !overlayEnvironment.portalElement) return null;
  return createPortal(
    <div className={`wl-overlay wl-overlay--${kind} wl-overlay--${side}`} onPointerDown={(event) => event.target === event.currentTarget && dismissOnBackdrop && closeRef.current()}>
      <div
        ref={panelRef}
        className="wl-overlay__panel"
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="wl-overlay__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <Button variant="quiet" onClick={onClose} disabled={closeDisabled} aria-label={closeLabel}><Icon name="close" /></Button>
        </header>
        <div className="wl-overlay__body">{children}</div>
        {footer && <footer className="wl-overlay__footer">{footer}</footer>}
      </div>
    </div>,
    overlayEnvironment?.portalElement ?? document.body,
  );
}
