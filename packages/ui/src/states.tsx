import { useId, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { AsyncState, Button } from "./components";
import { IconButton } from "./forms";
import { Icon } from "./icons";

export interface DemoBannerProps extends HTMLAttributes<HTMLElement> {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}

export function DemoBanner({
  title = "当前为演示环境",
  description = "这里的数据仅用于体验，不会影响正式经营数据。",
  action,
  onDismiss,
  dismissLabel = "关闭演示提示",
  className = "",
  ...props
}: DemoBannerProps) {
  return (
    <aside {...props} className={`wl-demo-banner ${className}`.trim()} aria-label="演示环境提示">
      <Icon name="notice" aria-hidden />
      <div className="wl-demo-banner__copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      {action && <div className="wl-demo-banner__action">{action}</div>}
      {onDismiss && <IconButton icon="close" label={dismissLabel} onClick={onDismiss} />}
    </aside>
  );
}

export interface OfflineStateProps {
  title?: string;
  description?: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  action?: ReactNode;
  compact?: boolean;
}

export function OfflineState({
  title = "当前处于离线状态",
  description = "部分数据可能不是最新内容。恢复网络后可重新连接。",
  onRetry,
  retrying = false,
  action,
  compact = false,
}: OfflineStateProps) {
  return (
    <section className={`wl-system-state ${compact ? "wl-system-state--compact" : ""}`} role="status" aria-live="polite">
      <Icon name="history" size={compact ? 20 : 28} aria-hidden />
      <div className="wl-system-state__copy">
        <strong>{title}</strong>
        <div className="wl-system-state__description">{description}</div>
      </div>
      {(onRetry || action) && (
        <div className="wl-system-state__actions">
          {onRetry && <Button onClick={onRetry} busy={retrying}>重新连接</Button>}
          {action}
        </div>
      )}
    </section>
  );
}

export interface PermissionStateProps {
  title?: string;
  description?: ReactNode;
  scope?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}

export function PermissionState({
  title = "暂无访问权限",
  description = "当前账号没有查看或操作此内容的权限。",
  scope,
  action,
  compact = false,
}: PermissionStateProps) {
  return (
    <section className={`wl-system-state ${compact ? "wl-system-state--compact" : ""}`} role="status">
      <Icon name="rules" size={compact ? 20 : 28} aria-hidden />
      <div className="wl-system-state__copy">
        <strong>{title}</strong>
        <div className="wl-system-state__description">{description}</div>
        {scope && <div className="wl-system-state__scope"><span>权限范围：</span>{scope}</div>}
      </div>
      {action && <div className="wl-system-state__actions">{action}</div>}
    </section>
  );
}

export interface EmptyStateProps {
  title?: string;
  description?: ReactNode;
  /** 兼容旧页面命名；新代码优先使用 description。 */
  desc?: ReactNode;
  /** 兼容旧页面命名；新代码优先使用 description。 */
  hint?: ReactNode;
  /** 仅作装饰，不能成为状态的唯一表达。 */
  icon?: ReactNode;
  action?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

/** AsyncState 的空结果语义别名，避免页面把请求失败误画成无数据。 */
export function EmptyState({ title, description, desc, hint, icon, action, actionLabel, onAction, className }: EmptyStateProps) {
  const resolvedAction = action ?? (actionLabel ? <Button variant="primary" onClick={onAction}>{actionLabel}</Button> : undefined);
  return <AsyncState status="empty" title={title} description={description ?? desc ?? hint} visual={icon} action={resolvedAction} className={className} />;
}

export interface ErrorStateProps {
  title?: string;
  description?: string;
  action?: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
}

/** AsyncState 的故障语义别名，默认提供稳定中文文案与可选重试。 */
export function ErrorState({ title, description, action, onRetry, retrying }: ErrorStateProps) {
  return <AsyncState status="error" title={title} description={description} action={action} onRetry={onRetry} retrying={retrying} />;
}

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  count?: number;
  variant?: "text" | "card" | "circle";
  label?: string;
  height?: number | string;
}

export function Skeleton({
  count = 1,
  variant = "text",
  label = "内容正在加载",
  height,
  className = "",
  style,
  ...props
}: SkeletonProps) {
  const safeCount = Number.isFinite(count) ? Math.max(1, Math.min(20, Math.floor(count))) : 1;
  const skeletonStyle = height === undefined
    ? style
    : { ...style, "--wl-skeleton-height": typeof height === "number" ? `${Math.max(1, height)}px` : height } as CSSProperties;
  return (
    <div {...props} className={`wl-skeleton-group ${className}`.trim()} style={skeletonStyle} role="status" aria-label={label} aria-live="polite">
      {Array.from({ length: safeCount }, (_, index) => (
        <span className={`wl-skeleton wl-skeleton--${variant}`} aria-hidden key={index} />
      ))}
    </div>
  );
}

export function progressPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, value / max)) * 100);
}

export interface ProgressProps {
  label: ReactNode;
  value?: number;
  max?: number;
  description?: ReactNode;
  showValue?: boolean;
  valueText?: string;
  tone?: "action" | "success" | "warning" | "danger";
  className?: string;
}

export function Progress({
  label,
  value,
  max = 100,
  description,
  showValue = true,
  valueText,
  tone = "action",
  className = "",
}: ProgressProps) {
  const labelId = useId();
  const descriptionId = useId();
  const effectiveMax = Number.isFinite(max) && max > 0 ? max : 100;
  const hasValue = typeof value === "number" && Number.isFinite(value);
  const percent = hasValue ? progressPercent(value, effectiveMax) : null;
  return (
    <div className={`wl-progress wl-progress--${tone} ${className}`.trim()}>
      <div className="wl-progress__heading">
        <span id={labelId}>{label}</span>
        {showValue && <strong>{valueText ?? (percent === null ? "进行中" : `${percent}%`)}</strong>}
      </div>
      <progress
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        max={effectiveMax}
        value={hasValue ? Math.min(Math.max(value, 0), effectiveMax) : undefined}
      />
      {description && <div className="wl-progress__description" id={descriptionId}>{description}</div>}
    </div>
  );
}
