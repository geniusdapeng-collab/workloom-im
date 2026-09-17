import {
  type AnchorHTMLAttributes,
  type CSSProperties,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Badge } from "./components";
import { clientStatusLabel } from "./language";

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  external?: boolean;
  newWindowLabel?: string;
}

/** 原生链接语义；新窗口链接自动补安全属性和中文读屏提示。 */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({
  external = false,
  newWindowLabel = "在新窗口打开",
  target,
  rel,
  children,
  className = "",
  ...props
}, ref) {
  const opensNewWindow = external || target === "_blank";
  const safeRel = opensNewWindow
    ? [...new Set(`${rel ?? ""} noopener noreferrer`.trim().split(/\s+/))].join(" ")
    : rel;
  return (
    <a
      {...props}
      ref={ref}
      target={external ? "_blank" : target}
      rel={safeRel}
      className={`wl-link ${className}`.trim()}
    >
      {children}
      {opensNewWindow && <span className="wl-visually-hidden">（{newWindowLabel}）</span>}
    </a>
  );
});

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
  onRemove?: () => void;
  removeLabel?: string;
  disabled?: boolean;
}

/** 可移除标签使用真实按钮；只读标签不伪装成可点击控件。 */
export function Tag({
  tone = "neutral",
  onRemove,
  removeLabel = "移除此标签",
  disabled = false,
  children,
  className = "",
  ...props
}: TagProps) {
  return (
    <span {...props} className={`wl-tag wl-tag--${tone} ${className}`.trim()}>
      <span className="wl-tag__label">{children}</span>
      {onRemove && (
        <button type="button" className="wl-tag__remove" onClick={onRemove} disabled={disabled} aria-label={removeLabel}>
          <span aria-hidden>×</span>
        </button>
      )}
    </span>
  );
}

export type StatusChipTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface StatusChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  status: string;
  label?: string;
  tone?: StatusChipTone;
}

const SUCCESS_STATUSES = new Set(["done", "closed", "delivered", "success", "passed", "active", "已完成", "已发送", "已通过", "正式运行"]);
const WARNING_STATUSES = new Set(["created", "assigned", "processing", "pending", "waiting", "review", "已受理", "处理中", "等待中", "待审核"]);
const DANGER_STATUSES = new Set(["failed", "error", "blocked", "rejected", "失败", "已阻断", "已拒绝"]);

export function statusChipTone(status: string): StatusChipTone {
  const normalized = status.trim().toLowerCase();
  if (SUCCESS_STATUSES.has(normalized)) return "success";
  if (WARNING_STATUSES.has(normalized)) return "warning";
  if (DANGER_STATUSES.has(normalized)) return "danger";
  return "info";
}

/** 状态码统一先中文化；未知底层值不会原样泄露到客户端。 */
export function StatusChip({ status, label, tone, className = "", ...props }: StatusChipProps) {
  const safeLabel = label ?? clientStatusLabel(status);
  return <Badge {...props} tone={tone ?? statusChipTone(status)} className={`wl-status-chip ${className}`.trim()}>{safeLabel}</Badge>;
}

export type AvatarSize = "small" | "medium" | "large";

export interface AvatarProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  name: string;
  src?: string;
  size?: AvatarSize;
  imageAlt?: string;
}

export function avatarInitials(name: string): string {
  const normalized = name.trim().replace(/\s+/g, "");
  return Array.from(normalized).slice(0, 2).join("") || "人";
}

/** 姓名始终提供可访问名称；图片缺失时使用稳定中文首字回退。 */
export function Avatar({
  name,
  src,
  size = "medium",
  imageAlt,
  className = "",
  ...props
}: AvatarProps) {
  const safeName = name.trim() || "未命名用户";
  return (
    <span {...props} className={`wl-avatar wl-avatar--${size} ${className}`.trim()} role="img" aria-label={safeName}>
      {src
        ? <img src={src} alt={imageAlt ?? ""} loading="lazy" />
        : <span aria-hidden>{avatarInitials(safeName)}</span>}
    </span>
  );
}

export interface GridProps extends HTMLAttributes<HTMLDivElement> {
  minItemWidth?: number | string;
  columns?: number;
  gap?: number | string;
  children: ReactNode;
}

function cssLength(value: number | string): string {
  return typeof value === "number" ? `${Math.max(0, value)}px` : value;
}

/** 自动换列的内容栅格；所有轨道使用 minmax(0, 1fr) 防止长中文撑破容器。 */
export function Grid({
  minItemWidth = "16rem",
  columns,
  gap = "var(--wl-space-4)",
  children,
  className = "",
  style,
  ...props
}: GridProps) {
  const safeColumns = columns === undefined ? undefined : Math.max(1, Math.floor(columns));
  const gridStyle = {
    ...style,
    "--wl-grid-min": cssLength(minItemWidth),
    "--wl-grid-columns": safeColumns ? String(safeColumns) : undefined,
    "--wl-grid-gap": cssLength(gap),
  } as CSSProperties;
  return <div {...props} className={`wl-grid ${safeColumns ? "wl-grid--fixed" : ""} ${className}`.trim()} style={gridStyle}>{children}</div>;
}
