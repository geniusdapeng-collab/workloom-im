import {
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

interface OverlayEnvironment {
  backgroundElement: HTMLDivElement | null;
  portalElement: HTMLDivElement | null;
}

const OverlayEnvironmentContext = createContext<OverlayEnvironment | null>(null);

/** 供共享浮层内部选择唯一 portal 与需要 inert 的应用背景。 */
export function useOverlayEnvironment(): OverlayEnvironment | null {
  return useContext(OverlayEnvironmentContext);
}

export interface OverlayManagerProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  children: ReactNode;
  /** Toast 统一进入不会抢焦点的顶部安全区。 */
  toasts?: ReactNode;
  toastLabel?: string;
}

/**
 * 应用级唯一浮层宿主。Dialog/Drawer/Sheet 会把内容送到 portalElement，并只将
 * backgroundElement 设为 inert；多层 Esc 顺序由共享浮层栈保证。
 */
export function OverlayManager({
  children,
  toasts,
  toastLabel = "操作通知",
  className = "",
  ...props
}: OverlayManagerProps) {
  const [backgroundElement, setBackgroundElement] = useState<HTMLDivElement | null>(null);
  const [portalElement, setPortalElement] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ backgroundElement, portalElement }), [backgroundElement, portalElement]);

  return (
    <OverlayEnvironmentContext.Provider value={value}>
      <div {...props} className={`wl-overlay-manager ${className}`.trim()}>
        <div className="wl-overlay-manager__background" ref={setBackgroundElement}>{children}</div>
        <div className="wl-overlay-manager__portal" ref={setPortalElement} />
        <div className="wl-toast-viewport" role="region" aria-label={toastLabel} aria-live="polite" aria-relevant="additions text">
          {toasts}
        </div>
      </div>
    </OverlayEnvironmentContext.Provider>
  );
}
