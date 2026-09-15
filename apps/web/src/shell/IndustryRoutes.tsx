import {
  AsyncState,
  BASE_NAVIGATION,
  isNavigationActive,
  requiredNavigationPermissions,
  type NavigationEntry,
} from "@workloom/ui";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { Link } from "react-router";
import { useNavigationAccess } from "./NavigationAccess";

/**
 * B 端 PC 行业页面的唯一扩展契约。
 *
 * 行业仓把声明放在 extensions 目录任意层级的 routes.ts(x)；受管 App 与导航不允许被复制修改。
 * capabilityId 必须同时出现在服务端验证后的当前 Bundle 导航投影中，客户端声明本身不授予权限。
 */
export interface IndustryRouteDefinition {
  path: string;
  capabilityId: string;
  element: ReactElement;
}

interface IndustryRouteModule {
  industryRoutes?: unknown;
}

export interface IndustryRouteRegistry {
  routes: readonly IndustryRouteDefinition[];
  error: Error | null;
}

const CAPABILITY_ID = /^[a-z0-9][a-z0-9-]{1,31}\.[a-z0-9][a-z0-9.-]{1,95}$/;
const FIXED_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const PARAM_SEGMENT = /^:[a-z][A-Za-z0-9]*$/;
const NON_INDUSTRY_ROUTE_ROOTS = ["/login", "/activate", "/invite", "/onboarding", "/dev"] as const;

const PROTECTED_ROUTE_ROOTS = new Set(
  [...BASE_NAVIGATION.flatMap((entry) => [entry.route, ...(entry.legacyRoutes ?? [])]), ...NON_INDUSTRY_ROUTE_ROOTS]
    .map((route) => route.split("/")[1])
    .filter((segment): segment is string => Boolean(segment)),
);

function routeShape(path: string): string {
  return path.split("/").map((segment) => segment.startsWith(":") ? ":" : segment).join("/");
}

/** 校验具体路由模式；不接受查询、通配或首段参数，避免吞掉其他产品页面。 */
export function validateIndustryRoutePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !path.startsWith("/") || path === "/" || path.endsWith("/")) {
    throw new Error("行业扩展路由必须是无尾斜杠的绝对路径");
  }
  if (path.includes("//") || path.includes("?") || path.includes("#") || path.includes("*") || path.includes(".")) {
    throw new Error(`行业扩展路由包含不受支持的地址语法：${path}`);
  }
  const segments = path.slice(1).split("/");
  if (!segments[0] || !FIXED_SEGMENT.test(segments[0])) {
    throw new Error(`行业扩展路由首段必须是小写语义名称：${path}`);
  }
  if (!segments.every((segment) => FIXED_SEGMENT.test(segment) || PARAM_SEGMENT.test(segment))) {
    throw new Error(`行业扩展路由片段不符合契约：${path}`);
  }
  if (PROTECTED_ROUTE_ROOTS.has(segments[0])) {
    throw new Error(`行业扩展路由不得覆盖基座地址：${path}`);
  }
}

export function validateIndustryCapabilityId(capabilityId: unknown): asserts capabilityId is string {
  if (typeof capabilityId !== "string" || !CAPABILITY_ID.test(capabilityId) || capabilityId.startsWith("workloom.")) {
    throw new Error("行业扩展能力必须使用非 workloom 的行业命名空间");
  }
}

/**
 * 汇总所有行业模块。任一模块不合法时整组扩展失败关闭，避免只加载一半造成导航与页面错配。
 */
export function buildIndustryRouteRegistry(modules: Readonly<Record<string, unknown>>): IndustryRouteRegistry {
  try {
    const routes: IndustryRouteDefinition[] = [];
    const seenShapes = new Map<string, string>();
    for (const [modulePath, value] of Object.entries(modules).sort(([left], [right]) => left.localeCompare(right))) {
      const module = value as IndustryRouteModule | null;
      if (!module || !Array.isArray(module.industryRoutes)) {
        throw new Error(`行业扩展模块必须导出 industryRoutes 数组：${modulePath}`);
      }
      for (const candidate of module.industryRoutes) {
        if (!candidate || typeof candidate !== "object") {
          throw new Error(`行业扩展路由声明不是对象：${modulePath}`);
        }
        const definition = candidate as Partial<IndustryRouteDefinition>;
        validateIndustryRoutePath(definition.path);
        validateIndustryCapabilityId(definition.capabilityId);
        if (!isValidElement(definition.element)) {
          throw new Error(`行业扩展路由缺少有效页面元素：${definition.path}`);
        }
        const shape = routeShape(definition.path);
        const existing = seenShapes.get(shape);
        if (existing) {
          throw new Error(`行业扩展路由重复：${existing} 与 ${definition.path}`);
        }
        seenShapes.set(shape, definition.path);
        routes.push(definition as IndustryRouteDefinition);
      }
    }
    return { routes, error: null };
  } catch (error) {
    return {
      routes: [],
      error: error instanceof Error ? error : new Error("行业扩展路由校验失败"),
    };
  }
}

/** 只发现白名单 extension 目录中的约定文件；默认没有文件时返回空路由，基座行为不变。 */
const discoveredModules = import.meta.glob<IndustryRouteModule>(
  ["../extensions/routes.{ts,tsx}", "../extensions/**/routes.{ts,tsx}"],
  { eager: true },
);

export const INDUSTRY_ROUTE_REGISTRY = buildIndustryRouteRegistry(discoveredModules);

/** 当前本地路由必须与服务端验证后的 Bundle 导航路径一致，不能只碰巧复用能力标识。 */
export function industryRouteMatchesBundle(
  definition: Pick<IndustryRouteDefinition, "path" | "capabilityId">,
  knownEntries: readonly NavigationEntry[],
): boolean {
  const entry = knownEntries.find((candidate) => (
    candidate.capabilityId === definition.capabilityId && candidate.source.startsWith("bundle:")
  ));
  if (!entry) return false;
  const representativePath = definition.path.replace(/:[a-z][A-Za-z0-9]*/g, "示例");
  return isNavigationActive(entry, representativePath);
}

export type IndustryRouteAccess = "unconfigured" | "misconfigured" | "forbidden" | "granted";

/**
 * knownEntries 只来自服务端验过签的 Bundle；grantedEntries 还经过实时 navigationPermissions 过滤。
 * 扩展页必须显式声明权限，不能使用行业导航对全员开放的兼容口径。
 */
export function resolveIndustryRouteAccess(
  definition: Pick<IndustryRouteDefinition, "path" | "capabilityId">,
  knownEntries: readonly NavigationEntry[],
  grantedEntries: readonly NavigationEntry[],
): IndustryRouteAccess {
  const configured = knownEntries.find((entry) => entry.capabilityId === definition.capabilityId);
  if (!configured) return "unconfigured";
  if (
    !configured.source.startsWith("bundle:")
    || requiredNavigationPermissions(configured).length === 0
    || !industryRouteMatchesBundle(definition, knownEntries)
  ) return "misconfigured";
  return grantedEntries.some((entry) => (
    entry.capabilityId === configured.capabilityId && entry.source === configured.source
  )) ? "granted" : "forbidden";
}

export function IndustryRouteBoundary({ definition, children }: {
  definition: Pick<IndustryRouteDefinition, "path" | "capabilityId">;
  children: ReactNode;
}) {
  const { knownEntries, entries, status, bundleStatus, reload } = useNavigationAccess();
  const fallbackRoute = entries[0]?.route ?? "/";

  if (status === "loading" || bundleStatus === "loading") {
    return <AsyncState status="loading" title="正在确认行业能力" description="正在读取当前工作区已安装的行业界面。" />;
  }
  if (status === "error" || bundleStatus === "error") {
    return <AsyncState status="error" title="行业界面未能安全加载" description="系统没有使用默认行业兜底。请重试，或联系管理员重新发布行业包。" onRetry={reload} />;
  }
  const access = resolveIndustryRouteAccess(definition, knownEntries, entries);
  if (access === "unconfigured") {
    return <AsyncState status="empty" title="当前工作区未安装此能力" description="该页面属于行业包，只有当前行业包明确声明后才会开放。" action={<Link to={fallbackRoute} className="wl-button wl-button--secondary">前往可用页面</Link>} />;
  }
  if (access === "misconfigured") {
    return (
      <AsyncState
        status="error"
        title="行业页面配置不一致"
        description="页面地址、能力来源或服务端权限声明与当前工作区已验证的行业导航不一致，系统已停止加载此页面。"
        action={<Link to={fallbackRoute} className="wl-button wl-button--secondary">前往可用页面</Link>}
      />
    );
  }
  if (access === "forbidden") {
    return <AsyncState status="forbidden" title="当前身份不能访问此页面" description="该行业能力受工作区角色限制，请联系管理员调整权限。" action={<Link to={fallbackRoute} className="wl-button wl-button--secondary">前往可用页面</Link>} />;
  }
  return <>{children}</>;
}

export function IndustryRouteLoadFailure() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4" aria-label="行业界面加载失败">
      <AsyncState
        status="error"
        title="行业界面未能安全加载"
        description="行业页面声明未通过基座校验。系统没有加载不完整或冲突的页面，请联系管理员修复行业扩展。"
      />
    </main>
  );
}
