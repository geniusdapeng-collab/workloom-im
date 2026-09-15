import {
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import { IconButton, Select } from "./forms";
import { Icon } from "./icons";
import { clientChineseText } from "./language";
import {
  isNavigationActive,
  NAVIGATION_GROUP_LABELS,
  NAVIGATION_GROUP_ORDER,
  type IconName,
  type NavigationEntry,
} from "./navigation";

export interface TopContextBarProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  context?: ReactNode;
  actions?: ReactNode;
}

export function TopContextBar({
  eyebrow,
  title,
  description,
  leading,
  context,
  actions,
  className = "",
  ...props
}: TopContextBarProps) {
  return (
    <header {...props} className={`wl-top-context-bar ${className}`.trim()}>
      {leading && <div className="wl-top-context-bar__leading">{leading}</div>}
      <div className="wl-top-context-bar__copy">
        {eyebrow && <div className="wl-top-context-bar__eyebrow">{eyebrow}</div>}
        <h1 className="wl-top-context-bar__title">{title}</h1>
        {description && <div className="wl-top-context-bar__description">{description}</div>}
      </div>
      {context && <div className="wl-top-context-bar__context">{context}</div>}
      {actions && <div className="wl-top-context-bar__actions">{actions}</div>}
    </header>
  );
}

function focusByOffset<T extends { disabled?: boolean }>(
  items: readonly T[],
  currentIndex: number,
  offset: number,
  focus: (item: T) => void,
) {
  if (items.length === 0) return;
  for (let count = 1; count <= items.length; count += 1) {
    const next = (currentIndex + offset * count + items.length) % items.length;
    const item = items[next];
    if (item && !item.disabled) {
      focus(item);
      return;
    }
  }
}

export interface SideNavigationProps extends HTMLAttributes<HTMLElement> {
  entries: readonly NavigationEntry[];
  activeCapabilityId?: string;
  activeRoute?: string;
  onNavigate: (entry: NavigationEntry) => void;
  disabledCapabilityIds?: ReadonlySet<string>;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  header?: ReactNode;
  /** 搜索、收藏、最近使用等仍属于左侧导航的辅助区。 */
  beforeGroups?: ReactNode;
  /** 单个导航项的附加动作，例如收藏；不得承载第二套页面导航。 */
  renderItemAction?: (entry: NavigationEntry) => ReactNode;
  footer?: ReactNode;
  label?: string;
  collapseLabel?: string;
  expandLabel?: string;
}

export function SideNavigation({
  entries,
  activeCapabilityId,
  activeRoute,
  onNavigate,
  disabledCapabilityIds,
  collapsed = false,
  onCollapsedChange,
  header,
  beforeGroups,
  renderItemAction,
  footer,
  label = "主导航",
  collapseLabel = "收起主导航",
  expandLabel = "展开主导航",
  className = "",
  ...props
}: SideNavigationProps) {
  const navigationId = useId();
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const orderedEntries = NAVIGATION_GROUP_ORDER.flatMap((group) => (
    entries.filter((entry) => entry.group === group).sort((left, right) => left.order - right.order)
  ));

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, entry: NavigationEntry) => {
    const currentIndex = orderedEntries.findIndex((item) => item.capabilityId === entry.capabilityId);
    const focusEntry = (target: NavigationEntry) => itemRefs.current[target.capabilityId]?.focus();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusByOffset(orderedEntries.map((item) => ({ ...item, disabled: disabledCapabilityIds?.has(item.capabilityId) })), currentIndex, 1, (target) => itemRefs.current[target.capabilityId]?.focus());
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusByOffset(orderedEntries.map((item) => ({ ...item, disabled: disabledCapabilityIds?.has(item.capabilityId) })), currentIndex, -1, (target) => itemRefs.current[target.capabilityId]?.focus());
    } else if (event.key === "Home") {
      event.preventDefault();
      const target = orderedEntries.find((item) => !disabledCapabilityIds?.has(item.capabilityId));
      if (target) focusEntry(target);
    } else if (event.key === "End") {
      event.preventDefault();
      const target = [...orderedEntries].reverse().find((item) => !disabledCapabilityIds?.has(item.capabilityId));
      if (target) focusEntry(target);
    }
  };

  return (
    <nav {...props} className={`wl-side-navigation ${collapsed ? "wl-side-navigation--collapsed" : ""} ${className}`.trim()} aria-label={label}>
      {(header || onCollapsedChange) && (
        <div className="wl-side-navigation__header">
          {header && <div className="wl-side-navigation__brand">{header}</div>}
          {onCollapsedChange && (
            <IconButton
              icon="chevron"
              label={collapsed ? expandLabel : collapseLabel}
              aria-expanded={!collapsed}
              aria-controls={`${navigationId}-groups`}
              className="wl-side-navigation__toggle"
              onClick={() => onCollapsedChange(!collapsed)}
            />
          )}
        </div>
      )}
      <div className="wl-side-navigation__groups" id={`${navigationId}-groups`}>
        {beforeGroups && !collapsed && <div className="wl-side-navigation__before-groups">{beforeGroups}</div>}
        {NAVIGATION_GROUP_ORDER.map((group) => {
          const groupEntries = orderedEntries.filter((entry) => entry.group === group);
          if (groupEntries.length === 0) return null;
          return (
            <section className="wl-side-navigation__group" aria-labelledby={`${navigationId}-${group}`} key={group}>
              <h2 id={`${navigationId}-${group}`} className={collapsed ? "wl-visually-hidden" : "wl-side-navigation__group-label"}>
                {NAVIGATION_GROUP_LABELS[group]}
              </h2>
              <div className="wl-side-navigation__items">
                {groupEntries.map((entry) => {
                  const clientTitle = clientChineseText(entry.title, "未命名页面");
                  const active = activeCapabilityId
                    ? activeCapabilityId === entry.capabilityId
                    : Boolean(activeRoute && isNavigationActive(entry, activeRoute));
                  const disabled = disabledCapabilityIds?.has(entry.capabilityId) ?? false;
                  const action = !collapsed && renderItemAction?.(entry);
                  return (
                    <div className="wl-side-navigation__item-row" key={entry.capabilityId}>
                      <button
                        type="button"
                        className={`wl-side-navigation__item ${active ? "wl-side-navigation__item--active" : ""}`.trim()}
                        aria-current={active ? "page" : undefined}
                        aria-label={collapsed ? clientTitle : undefined}
                        title={collapsed ? clientTitle : undefined}
                        disabled={disabled}
                        ref={(node) => { itemRefs.current[entry.capabilityId] = node; }}
                        onClick={() => onNavigate(entry)}
                        onKeyDown={(event) => handleKeyDown(event, entry)}
                      >
                        <Icon name={entry.icon} />
                        <span className={collapsed ? "wl-visually-hidden" : "wl-side-navigation__item-label"}>{clientTitle}</span>
                      </button>
                      {action && <div className="wl-side-navigation__item-action">{action}</div>}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      {footer && <div className="wl-side-navigation__footer">{footer}</div>}
    </nav>
  );
}

/** PRD 标准短名；复用 SideNavigation，不维护第二套导航实现。 */
export function SideNav(props: SideNavigationProps) {
  return <SideNavigation {...props} />;
}

export interface SectionNavigationItem {
  id: string;
  label: string;
  badge?: string | number;
  disabled?: boolean;
}

export interface SectionNavigationProps extends Omit<HTMLAttributes<HTMLElement>, "onSelect"> {
  items: readonly SectionNavigationItem[];
  activeId: string;
  onSelect: (item: SectionNavigationItem) => void;
  label?: string;
}

/**
 * PC 页内分区导航。它固定出现在内容左侧，替代重复的顶部横向页签；上下方向键、
 * Home/End 与主侧栏保持一致，行业包只能投影条目，不能复制导航实现。
 */
export function SectionNavigation({ items, activeId, onSelect, label = "页面分区", className = "", ...props }: SectionNavigationProps) {
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, item: SectionNavigationItem) => {
    const currentIndex = items.findIndex((candidate) => candidate.id === item.id);
    const focusItem = (target: SectionNavigationItem) => itemRefs.current[target.id]?.focus();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusByOffset(items, currentIndex, 1, focusItem);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusByOffset(items, currentIndex, -1, focusItem);
    } else if (event.key === "Home") {
      event.preventDefault();
      const target = items.find((candidate) => !candidate.disabled);
      if (target) focusItem(target);
    } else if (event.key === "End") {
      event.preventDefault();
      const target = [...items].reverse().find((candidate) => !candidate.disabled);
      if (target) focusItem(target);
    }
  };
  return (
    <nav {...props} className={`wl-section-navigation ${className}`.trim()} aria-label={label}>
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            ref={(node) => { itemRefs.current[item.id] = node; }}
            className={`wl-section-navigation__item ${active ? "wl-section-navigation__item--active" : ""}`.trim()}
            aria-current={active ? "page" : undefined}
            disabled={item.disabled}
            onClick={() => onSelect(item)}
            onKeyDown={(event) => handleKeyDown(event, item)}
          >
            <span className="wl-section-navigation__label">{item.label}</span>
            {item.badge !== undefined && <span className="wl-section-navigation__badge" aria-label={`${item.badge} 项`}>{item.badge}</span>}
          </button>
        );
      })}
    </nav>
  );
}

export interface BottomTabItem {
  id: string;
  label: string;
  icon: IconName;
  badge?: string | number;
  badgeLabel?: string;
  disabled?: boolean;
}

export interface BottomTabsProps extends Omit<HTMLAttributes<HTMLElement>, "onSelect"> {
  items: readonly BottomTabItem[];
  activeId?: string;
  onSelect: (item: BottomTabItem) => void;
  label?: string;
}

export function BottomTabs({ items, activeId, onSelect, label = "主导航", className = "", ...props }: BottomTabsProps) {
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, item: BottomTabItem) => {
    const currentIndex = items.findIndex((candidate) => candidate.id === item.id);
    const focusItem = (target: BottomTabItem) => itemRefs.current[target.id]?.focus();
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusByOffset(items, currentIndex, 1, focusItem);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusByOffset(items, currentIndex, -1, focusItem);
    } else if (event.key === "Home") {
      event.preventDefault();
      const target = items.find((candidate) => !candidate.disabled);
      if (target) focusItem(target);
    } else if (event.key === "End") {
      event.preventDefault();
      const target = [...items].reverse().find((candidate) => !candidate.disabled);
      if (target) focusItem(target);
    }
  };

  return (
    <nav {...props} className={`wl-bottom-tabs ${className}`.trim()} aria-label={label}>
      <div className="wl-bottom-tabs__items">
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <button
              type="button"
              className={`wl-bottom-tabs__item ${active ? "wl-bottom-tabs__item--active" : ""}`.trim()}
              aria-current={active ? "page" : undefined}
              aria-label={item.badge !== undefined ? `${item.label}，${item.badgeLabel ?? `${item.badge} 项提醒`}` : undefined}
              disabled={item.disabled}
              key={item.id}
              ref={(node) => { itemRefs.current[item.id] = node; }}
              onClick={() => onSelect(item)}
              onKeyDown={(event) => handleKeyDown(event, item)}
            >
              <span className="wl-bottom-tabs__icon"><Icon name={item.icon} />{item.badge !== undefined && <span className="wl-bottom-tabs__badge" aria-hidden>{item.badge}</span>}</span>
              <span className="wl-bottom-tabs__label">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export interface AppShellProps extends HTMLAttributes<HTMLDivElement> {
  topBar?: ReactNode;
  sideNavigation?: ReactNode;
  bottomTabs?: ReactNode;
  auxiliary?: ReactNode;
  navigationMode?: "responsive" | "side" | "bottom" | "none";
  mainId?: string;
  mainLabel?: string;
  auxiliaryLabel?: string;
  skipLabel?: string;
  children: ReactNode;
}

export function AppShell({
  topBar,
  sideNavigation,
  bottomTabs,
  auxiliary,
  navigationMode = "responsive",
  mainId = "wl-main-content",
  mainLabel = "主要内容",
  auxiliaryLabel = "辅助面板",
  skipLabel = "跳到主要内容",
  children,
  className = "",
  ...props
}: AppShellProps) {
  return (
    <div {...props} className={`wl-app-shell ${className}`.trim()} data-navigation-mode={navigationMode}>
      <a className="wl-skip-link" href={`#${mainId}`}>{skipLabel}</a>
      {sideNavigation && <div className="wl-app-shell__side">{sideNavigation}</div>}
      {topBar && <div className="wl-app-shell__top">{topBar}</div>}
      <main className="wl-app-shell__main" id={mainId} aria-label={mainLabel} tabIndex={-1}>{children}</main>
      {auxiliary && <aside className="wl-app-shell__auxiliary" aria-label={auxiliaryLabel}>{auxiliary}</aside>}
      {bottomTabs && <div className="wl-app-shell__bottom">{bottomTabs}</div>}
    </div>
  );
}

export interface SplitViewProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  primary: ReactNode;
  secondary: ReactNode;
  direction?: "horizontal" | "vertical";
  primaryPercent?: number;
  label?: string;
  primaryLabel?: string;
  secondaryLabel?: string;
  stackOnNarrow?: boolean;
}

/** 响应式双区布局；窄屏默认按主区、次区顺序堆叠，两个区均允许内容收缩。 */
export function SplitView({
  primary,
  secondary,
  direction = "horizontal",
  primaryPercent = 60,
  label = "分栏内容",
  primaryLabel = "主要区域",
  secondaryLabel = "辅助区域",
  stackOnNarrow = true,
  className = "",
  style,
  ...props
}: SplitViewProps) {
  const safePrimaryPercent = Math.min(80, Math.max(20, Number.isFinite(primaryPercent) ? primaryPercent : 60));
  const splitStyle = { ...style, "--wl-split-primary": `${safePrimaryPercent}%` } as CSSProperties;
  return (
    <div
      {...props}
      className={`wl-split-view wl-split-view--${direction} ${className}`.trim()}
      style={splitStyle}
      role="group"
      aria-label={label}
      data-stack-on-narrow={stackOnNarrow || undefined}
    >
      <section className="wl-split-view__primary" aria-label={primaryLabel}>{primary}</section>
      <section className="wl-split-view__secondary" aria-label={secondaryLabel}>{secondary}</section>
    </div>
  );
}

export interface WorkspaceOption {
  id: string;
  name: string;
  group?: string;
  disabled?: boolean;
}

export interface WorkspaceSwitcherProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  workspaces: readonly WorkspaceOption[];
  value?: string;
  onValueChange: (workspaceId: string) => void;
  label?: string;
  description?: string;
  emptyLabel?: string;
  disabled?: boolean;
  selectName?: string;
}

/** 只呈现调用方提供的中文工作区名称；内部 id 仅作为 option value。 */
export function WorkspaceSwitcher({
  workspaces,
  value,
  onValueChange,
  label = "切换工作区",
  description,
  emptyLabel = "暂无可用工作区",
  disabled = false,
  selectName = "workspace",
  className = "",
  ...props
}: WorkspaceSwitcherProps) {
  const groups = new Map<string, WorkspaceOption[]>();
  const ungrouped: WorkspaceOption[] = [];
  for (const workspace of workspaces) {
    if (!workspace.group) ungrouped.push(workspace);
    else groups.set(workspace.group, [...(groups.get(workspace.group) ?? []), workspace]);
  }
  return (
    <div {...props} className={`wl-workspace-switcher ${className}`.trim()}>
      <Select
        label={label}
        description={description}
        name={selectName}
        value={workspaces.length === 0 ? "" : value}
        required
        disabled={disabled || workspaces.length === 0}
        onChange={(event) => onValueChange(event.currentTarget.value)}
      >
        {workspaces.length === 0 && <option value="">{emptyLabel}</option>}
        {ungrouped.map((workspace) => <option value={workspace.id} disabled={workspace.disabled} key={workspace.id}>{workspace.name}</option>)}
        {[...groups.entries()].map(([group, items]) => (
          <optgroup label={group} key={group}>
            {items.map((workspace) => <option value={workspace.id} disabled={workspace.disabled} key={workspace.id}>{workspace.name}</option>)}
          </optgroup>
        ))}
      </Select>
    </div>
  );
}

export type ResizablePanelSide = "left" | "right" | "bottom";

function normalizedPanelBounds(minSize: number, maxSize: number): [number, number] {
  const finiteMin = Number.isFinite(minSize) ? Math.max(0, minSize) : 0;
  const finiteMax = Number.isFinite(maxSize) ? Math.max(0, maxSize) : finiteMin;
  return [Math.min(finiteMin, finiteMax), Math.max(finiteMin, finiteMax)];
}

export function clampPanelSize(size: number, minSize: number, maxSize: number): number {
  const [safeMin, safeMax] = normalizedPanelBounds(minSize, maxSize);
  if (!Number.isFinite(size)) return safeMin;
  return Math.min(safeMax, Math.max(safeMin, Math.round(size)));
}

export function panelSizeForKey(
  key: string,
  currentSize: number,
  minSize: number,
  maxSize: number,
  step: number,
  defaultSize: number,
): number | null {
  const [lowerBound, upperBound] = normalizedPanelBounds(minSize, maxSize);
  if (key === "Home") return lowerBound;
  if (key === "End") return upperBound;
  if (key === "Enter") return clampPanelSize(defaultSize, minSize, maxSize);
  if (key === "ArrowRight" || key === "ArrowUp") return clampPanelSize(currentSize + step, minSize, maxSize);
  if (key === "ArrowLeft" || key === "ArrowDown") return clampPanelSize(currentSize - step, minSize, maxSize);
  return null;
}

export interface ResizablePanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  children: ReactNode;
  side?: ResizablePanelSide;
  size: number;
  defaultSize?: number;
  minSize?: number;
  maxSize?: number;
  step?: number;
  collapsed?: boolean;
  onSizeChange: (size: number) => void;
  onCollapsedChange?: (collapsed: boolean) => void;
  headerActions?: ReactNode;
  panelLabel?: string;
  resizeLabel?: string;
  resizeDescription?: string;
  collapseLabel?: string;
  expandLabel?: string;
}

export function ResizablePanel({
  title,
  children,
  side = "right",
  size,
  defaultSize = 320,
  minSize = 240,
  maxSize = 720,
  step = 24,
  collapsed = false,
  onSizeChange,
  onCollapsedChange,
  headerActions,
  panelLabel = "辅助面板",
  resizeLabel = "调整面板大小",
  resizeDescription = "使用方向键调整大小，Home 和 End 跳到边界，Enter 恢复原始大小。",
  collapseLabel = "收起面板",
  expandLabel = "展开面板",
  className = "",
  style,
  ...props
}: ResizablePanelProps) {
  const titleId = useId();
  const [lowerBound, upperBound] = normalizedPanelBounds(minSize, maxSize);
  const safeSize = clampPanelSize(size, lowerBound, upperBound);
  const safeStep = Number.isFinite(step) ? Math.max(1, step) : 24;
  const panelStyle = { ...style, "--wl-panel-size": `${safeSize}px` } as CSSProperties;
  const vertical = side !== "bottom";
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragCleanupRef.current?.();
    const startPosition = vertical ? event.clientX : event.clientY;
    const startSize = safeSize;
    const direction = side === "left" ? 1 : -1;
    const handleMove = (moveEvent: PointerEvent) => {
      const position = vertical ? moveEvent.clientX : moveEvent.clientY;
      onSizeChange(clampPanelSize(startSize + (position - startPosition) * direction, lowerBound, upperBound));
    };
    const handleUp = () => {
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerup", handleUp);
      document.removeEventListener("pointercancel", handleUp);
      dragCleanupRef.current = null;
    };
    dragCleanupRef.current = handleUp;
    document.addEventListener("pointermove", handleMove);
    document.addEventListener("pointerup", handleUp);
    document.addEventListener("pointercancel", handleUp);
  };

  const handleResizeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = panelSizeForKey(event.key, safeSize, lowerBound, upperBound, safeStep, defaultSize);
    if (next === null) return;
    event.preventDefault();
    onSizeChange(next);
  };

  return (
    <section
      {...props}
      className={`wl-resizable-panel wl-resizable-panel--${side} ${collapsed ? "wl-resizable-panel--collapsed" : ""} ${className}`.trim()}
      style={panelStyle}
      aria-label={panelLabel}
      data-collapsed={collapsed || undefined}
    >
      <header className="wl-resizable-panel__header">
        <h2 className="wl-resizable-panel__title" id={titleId}>{title}</h2>
        {!collapsed && headerActions && <div className="wl-resizable-panel__actions">{headerActions}</div>}
        {onCollapsedChange && (
          <IconButton className="wl-resizable-panel__toggle" icon="chevron" label={collapsed ? expandLabel : collapseLabel} aria-expanded={!collapsed} aria-controls={`${titleId}-body`} onClick={() => onCollapsedChange(!collapsed)} />
        )}
      </header>
      <div className="wl-resizable-panel__body" id={`${titleId}-body`} aria-labelledby={titleId} hidden={collapsed}>{children}</div>
      {!collapsed && (
        <div
          className="wl-resizable-panel__handle"
          role="separator"
          aria-label={resizeLabel}
          aria-description={resizeDescription}
          aria-orientation={vertical ? "vertical" : "horizontal"}
          aria-valuemin={lowerBound}
          aria-valuemax={upperBound}
          aria-valuenow={safeSize}
          aria-valuetext={`${safeSize} 像素`}
          tabIndex={0}
          onDoubleClick={() => onSizeChange(clampPanelSize(defaultSize, lowerBound, upperBound))}
          onPointerDown={handlePointerDown}
          onKeyDown={handleResizeKey}
        />
      )}
    </section>
  );
}
