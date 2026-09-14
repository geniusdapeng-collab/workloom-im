/** PC 导航组装：基座入口来自 @workloom/ui，行业入口只接受服务端验证后的 Bundle 投影。 */
import { composeNavigation, type NavigationEntry } from "@workloom/ui";

export const NAV_ENTRIES = composeNavigation({
  client: "b-pc",
});

const AUTHENTICATED_READ_PERMISSIONS = [
  "approvals.read",
  "service.read",
  "executive.read",
  "guardrails.read",
  "ledger.read",
  "eval.read",
  "memory.read",
  "models.read",
  "skills.read",
  "assembly.read",
  "agents.read",
] as const;

export interface NavigationIdentity {
  role: string;
  capabilities: Readonly<Record<string, boolean | number>>;
}

/**
 * 导航权限只消费服务端 members.me 下发的身份与版本能力，不从 pathname 或前端按钮反推。
 * 服务端仍是最终权限边界；这里负责在用户点击前隐藏明确无权入口。
 */
export function navigationPermissions(
  { role, capabilities }: NavigationIdentity,
  bundlePermissions: readonly string[] = [],
): ReadonlySet<string> {
  const permissions = new Set<string>(AUTHENTICATED_READ_PERMISSIONS);
  if (capabilities.nightShift === true) permissions.add("night.read");
  if (role === "owner" || role === "manager") {
    permissions.add("workspace.manage");
    permissions.add("members.read");
  }
  if (role === "owner") permissions.add("partners.read");
  for (const permission of bundlePermissions) permissions.add(permission);
  return permissions;
}

export function navigationForPermissions(
  permissions: ReadonlySet<string>,
  bundleEntries: readonly NavigationEntry[] = [],
): NavigationEntry[] {
  return composeNavigation({
    client: "b-pc",
    permissions,
    bundleEntries,
  });
}

/** 兼容旧服务端卡片中的 /p* 深链，但浏览器最终只呈现语义地址。 */
export function canonicalNavigationPath(path: string, bundleEntries: readonly NavigationEntry[] = []): string {
  if (path.startsWith("/p8/agent/")) return `/agents/${path.slice("/p8/agent/".length)}`;
  const entry = [...NAV_ENTRIES, ...bundleEntries].find((candidate) => candidate.legacyRoutes?.some((legacy) => (
    path === legacy || path.startsWith(`${legacy}/`) || path.startsWith(`${legacy}?`) || path.startsWith(`${legacy}#`)
  )));
  if (!entry) return path;
  const legacy = entry.legacyRoutes?.find((candidate) => (
    path === candidate || path.startsWith(`${candidate}/`) || path.startsWith(`${candidate}?`) || path.startsWith(`${candidate}#`)
  ));
  return legacy ? `${entry.route}${path.slice(legacy.length)}` : path;
}
