import {
  type ButtonHTMLAttributes,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  useId,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.js";
import type { IconName } from "./navigation.js";
import { useManagedSurface } from "./managed-surface.js";
import { useOverlayEnvironment } from "./overlay-manager.js";

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

export type BannerAlertLevel = "alert" | "warn" | "info";

export interface BannerAlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  level: BannerAlertLevel;
  children: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  action?: ReactNode;
}

const BANNER_ALERT_ICONS: Record<BannerAlertLevel, IconName> = {
  alert: "brake",
  warn: "warning",
  info: "radar",
};

/**
 * 三端共享告警条。正文与图标组成一个可收缩但不会塌陷的区域；动作空间不足时
 * 自动换到下一行，避免侧栏/缩放场景中按钮把正文挤成单字窄列。
 */
export function BannerAlert({
  level,
  children,
  actionLabel,
  onAction,
  action,
  className = "",
  ...props
}: BannerAlertProps) {
  const actionContent = action ?? (actionLabel ? (
    <Button variant="quiet" onClick={onAction} className="wl-banner-alert__action">
      {actionLabel}
    </Button>
  ) : null);
  return (
    <div
      {...props}
      className={`wl-banner-alert wl-banner-alert--${level} ${className}`.trim()}
      role={props.role ?? (level === "alert" ? "alert" : "status")}
      aria-live={props["aria-live"] ?? (level === "alert" ? "assertive" : "polite")}
    >
      <div className="wl-banner-alert__body">
        <Icon name={BANNER_ALERT_ICONS[level]} size={16} className="wl-banner-alert__icon" />
        <div className="wl-banner-alert__copy">{children}</div>
      </div>
      {actionContent && <div className="wl-banner-alert__actions">{actionContent}</div>}
    </div>
  );
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
  const overlayEnvironment = useOverlayEnvironment();
  const titleId = useId();
  const descriptionId = useId();
  const surface = useManagedSurface<HTMLDivElement>({
    open,
    kind,
    onDismiss: onClose,
    modal: true,
    dismissOnEscape,
    initialFocusRef,
  });

  if (!open) return null;
  if (typeof document === "undefined") return null;
  if (overlayEnvironment && !overlayEnvironment.portalElement) return null;
  return createPortal(
    <div className={`wl-overlay wl-overlay--${kind} wl-overlay--${side}`} onPointerDown={(event) => event.target === event.currentTarget && dismissOnBackdrop && onClose()}>
      <div
        {...surface}
        className="wl-overlay__panel"
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <header className="wl-overlay__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <Button variant="quiet" onClick={onClose} disabled={closeDisabled} aria-label={closeLabel} title={closeLabel}><Icon name="close" /></Button>
        </header>
        <div className="wl-overlay__body">{children}</div>
        {footer && <footer className="wl-overlay__footer">{footer}</footer>}
      </div>
    </div>,
    overlayEnvironment?.portalElement ?? document.body,
  );
}
