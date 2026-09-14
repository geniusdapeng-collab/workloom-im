import {
  AsyncState,
  composeNavigation,
  isNavigationActive,
  navigationEntriesFromBundle,
  requiredNavigationPermissions,
  type BundleNavigationSlot,
  type NavigationEntry,
} from "@workloom/ui";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router";
import { ensureDemoLogin, trpc } from "../lib/trpc";
import { hydrateDisplayTerminology } from "../lib/display";
import {
  NAV_ENTRIES,
  navigationForPermissions,
  navigationPermissions,
} from "./NavMenu";

type AccessStatus = "loading" | "ready" | "error";

interface NavigationAccessValue {
  entries: readonly NavigationEntry[];
  knownEntries: readonly NavigationEntry[];
  status: AccessStatus;
  bundleStatus: "loading" | "ready" | "unconfigured" | "error";
  bundle: ActiveBundleUi | null;
  identityKey: string;
  reload: () => void;
}

export interface ActiveBundleUi {
  bundleId: string;
  bundleName: string;
  bundleVersion: string;
  integrityDigest: string | null;
  ui: {
    terminology: Record<string, string>;
    navigation: { slots: BundleNavigationSlot[] };
    home: { widgets: Array<{ slot: string; component: string; clients: Array<"pc" | "b-mobile" | "c-mobile">; props: Record<string, unknown> }> };
    welcome?: { system: string[]; keywords: string[] };
    objects: string[];
    workflows: string[];
  };
}

const UNPRIVILEGED_ENTRIES = navigationForPermissions(new Set<string>());
const NavigationAccessContext = createContext<NavigationAccessValue>({
  entries: UNPRIVILEGED_ENTRIES,
  knownEntries: NAV_ENTRIES,
  status: "loading",
  bundleStatus: "loading",
  bundle: null,
  identityKey: "anonymous",
  reload: () => undefined,
});

export function NavigationAccessProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<readonly NavigationEntry[]>(UNPRIVILEGED_ENTRIES);
  const [knownEntries, setKnownEntries] = useState<readonly NavigationEntry[]>(NAV_ENTRIES);
  const [status, setStatus] = useState<AccessStatus>("loading");
  const [bundleStatus, setBundleStatus] = useState<NavigationAccessValue["bundleStatus"]>("loading");
  const [bundle, setBundle] = useState<ActiveBundleUi | null>(null);
  const [identityKey, setIdentityKey] = useState("anonymous");
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const onIdentityChanged = () => reload();
    window.addEventListener("workloom:identity-changed", onIdentityChanged);
    return () => window.removeEventListener("workloom:identity-changed", onIdentityChanged);
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    // 切换身份/工作区时先清空上一行业的投影，避免短暂串用旧术语。
    hydrateDisplayTerminology({});
    setStatus("loading");
    setBundleStatus("loading");
    void (async () => {
      try {
        await ensureDemoLogin();
        const member = await trpc.members.me.query() as {
          identity: { role: string; workspaceId?: string; memberNo?: string };
          capabilities: Record<string, boolean | number>;
        };
        let bundleEntries: NavigationEntry[] = [];
        let grantedPermissions: string[] = [];
        let activeBundle: ActiveBundleUi | null = null;
        let nextBundleStatus: NavigationAccessValue["bundleStatus"] = "unconfigured";
        try {
          const projection = await trpc.bundles.currentUi.query() as
            | ({ configured: false; reason: string })
            | ({ configured: true; grantedPermissions: string[] } & ActiveBundleUi);
          if (projection.configured) {
            activeBundle = projection;
            hydrateDisplayTerminology(projection.ui.terminology);
            bundleEntries = navigationEntriesFromBundle(projection.bundleId, projection.ui.navigation.slots);
            grantedPermissions = projection.grantedPermissions;
            nextBundleStatus = "ready";
          }
        } catch (error) {
          console.error("行业界面投影加载失败", error);
          nextBundleStatus = "error";
        }
        if (cancelled) return;
        const permissions = navigationPermissions({
          role: member.identity.role,
          capabilities: member.capabilities,
        }, grantedPermissions);
        setKnownEntries(composeNavigation({ client: "b-pc", bundleEntries }));
        setEntries(navigationForPermissions(permissions, bundleEntries));
        setBundle(activeBundle);
        setBundleStatus(nextBundleStatus);
        setIdentityKey(`${member.identity.workspaceId ?? "workspace"}:${member.identity.memberNo ?? "member"}`);
        setStatus("ready");
      } catch (error) {
        console.error("导航权限加载失败", error);
        if (!cancelled) {
          setEntries(UNPRIVILEGED_ENTRIES);
          setKnownEntries(NAV_ENTRIES);
          setBundle(null);
          setBundleStatus("error");
          setIdentityKey("anonymous");
          setStatus("error");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [revision]);

  const value = useMemo(
    () => ({ entries, knownEntries, status, bundleStatus, bundle, identityKey, reload }),
    [entries, knownEntries, status, bundleStatus, bundle, identityKey, reload],
  );
  return <NavigationAccessContext.Provider value={value}>{children}</NavigationAccessContext.Provider>;
}

export function useNavigationAccess(): NavigationAccessValue {
  return useContext(NavigationAccessContext);
}

/** 同一权限结果同时约束左侧入口和直达深链，避免隐藏导航后仍可误入无权页面。 */
export function NavigationAccessBoundary({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { entries, knownEntries, status, reload } = useNavigationAccess();
  const target = knownEntries.find((entry) => isNavigationActive(entry, pathname));

  if (!target || requiredNavigationPermissions(target).length === 0) return <>{children}</>;
  if (status === "loading") {
    return <AsyncState status="loading" title="正在确认访问范围" description="正在读取当前工作区的角色与版本能力。" />;
  }
  if (status === "error") {
    return <AsyncState status="error" title="暂时无法确认访问权限" description="为避免误入敏感页面，系统暂未打开此入口。" onRetry={reload} />;
  }
  if (!entries.some((entry) => entry.capabilityId === target.capabilityId)) {
    return (
      <AsyncState
        status="forbidden"
        title="当前身份不能访问此页面"
        description="该入口受工作区角色或版本能力限制。如需使用，请联系管理员调整权限或版本。"
        action={<Link to="/" className="wl-button wl-button--secondary">返回经营首页</Link>}
      />
    );
  }
  return <>{children}</>;
}

/** 编译进基座示例的行业页面仍须由当前 Bundle 显式安装，直达深链也不能绕过。 */
export function NavigationCapabilityBoundary({ capabilityId, children }: { capabilityId: string; children: ReactNode }) {
  const { entries, knownEntries, status, bundleStatus, reload } = useNavigationAccess();
  if (status === "loading" || bundleStatus === "loading") {
    return <AsyncState status="loading" title="正在确认行业能力" description="正在读取当前工作区已安装的行业界面。" />;
  }
  if (status === "error" || bundleStatus === "error") {
    return <AsyncState status="error" title="行业界面未能安全加载" description="系统没有使用默认行业兜底。请重试，或联系管理员重新发布行业包。" onRetry={reload} />;
  }
  if (!knownEntries.some((entry) => entry.capabilityId === capabilityId)) {
    return <AsyncState status="empty" title="当前工作区未安装此能力" description="该页面属于行业包，只有当前行业包明确声明后才会开放。" action={<Link to="/" className="wl-button wl-button--secondary">返回经营首页</Link>} />;
  }
  if (!entries.some((entry) => entry.capabilityId === capabilityId)) {
    return <AsyncState status="forbidden" title="当前身份不能访问此页面" description="该行业能力受工作区角色限制，请联系管理员调整权限。" action={<Link to="/" className="wl-button wl-button--secondary">返回经营首页</Link>} />;
  }
  return <>{children}</>;
}
