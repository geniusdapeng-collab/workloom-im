import { clientChineseText } from "./language.js";

export type WorkLoomClient = "b-pc" | "b-mobile" | "c-mobile";
export type NavigationGroup = "today" | "collaboration" | "operations" | "trust" | "automation" | "organization" | "mine";

export type IconName =
  | "home" | "tasks" | "report" | "service" | "approval" | "ledger"
  | "rules" | "exam" | "memory" | "night" | "model" | "skills"
  | "team" | "workspace" | "inbox" | "account" | "partner" | "more"
  | "executive" | "customize" | "configuration" | "assembly" | "agents" | "developer"
  | "menu" | "close" | "reset" | "search" | "notice" | "chevron"
  | "chat" | "ticket" | "star" | "history"
  | "warning" | "check" | "error" | "edit" | "lock" | "pin"
  | "book" | "phone" | "play" | "copy" | "like" | "dislike"
  | "gift" | "cart" | "radar" | "send" | "package" | "experiment"
  | "lightning" | "medal" | "rocket" | "puzzle" | "folder" | "palette"
  | "celebrate" | "question" | "brake" | "circle" | "document";

export interface NavigationEntry {
  capabilityId: string;
  route: string;
  legacyRoutes?: readonly string[];
  title: string;
  group: NavigationGroup;
  icon: IconName;
  clients: readonly WorkLoomClient[];
  /** 服务端返回的权限标识；产品路由必须显式声明，禁止“已登录即 broad-read”。 */
  permission?: string;
  /** 行业包可声明多个权限，必须全部由服务端授予；permission 保留给旧基座条目。 */
  permissions?: readonly string[];
  source: "base" | `bundle:${string}`;
  order: number;
}

export const NAVIGATION_GROUP_LABELS: Readonly<Record<NavigationGroup, string>> = {
  today: "今日",
  collaboration: "协作",
  operations: "经营",
  trust: "信任治理",
  automation: "自动化",
  organization: "组织管理",
  mine: "我的",
};

export const NAVIGATION_GROUP_ORDER: readonly NavigationGroup[] = [
  "today", "collaboration", "operations", "trust", "automation", "organization", "mine",
];

/** 基座页面导航唯一注册表。行业页面通过 bundle 条目合并，不能修改这里的基础语义。 */
export const BASE_NAVIGATION: readonly NavigationEntry[] = [
  { capabilityId: "workloom.today", route: "/", legacyRoutes: ["/p0"], title: "经营首页", group: "today", icon: "home", clients: ["b-pc", "b-mobile"], permission: "today.read", source: "base", order: 10 },
  { capabilityId: "workloom.inbox", route: "/inbox", legacyRoutes: ["/p28"], title: "统一待办", group: "today", icon: "inbox", clients: ["b-pc", "b-mobile"], permission: "inbox.read", source: "base", order: 20 },
  { capabilityId: "workloom.tasks", route: "/tasks", legacyRoutes: ["/p1", "/p2"], title: "任务中心", group: "collaboration", icon: "tasks", clients: ["b-pc", "b-mobile"], permission: "tasks.read", source: "base", order: 10 },
  { capabilityId: "workloom.approvals", route: "/approvals", legacyRoutes: ["/p4"], title: "审批中心", group: "collaboration", icon: "approval", clients: ["b-pc", "b-mobile"], permission: "approvals.read", source: "base", order: 20 },
  { capabilityId: "workloom.reports", route: "/reports", legacyRoutes: ["/p3"], title: "经营报告", group: "operations", icon: "report", clients: ["b-pc", "b-mobile"], permission: "reports.read", source: "base", order: 10 },
  { capabilityId: "workloom.service-front", route: "/service", legacyRoutes: ["/p22"], title: "服务前台", group: "operations", icon: "service", clients: ["b-pc"], permission: "service.read", source: "base", order: 20 },
  { capabilityId: "workloom.executive", route: "/executive", legacyRoutes: ["/p21"], title: "老板视图", group: "operations", icon: "executive", clients: ["b-pc", "b-mobile"], permission: "executive.read", source: "base", order: 30 },
  { capabilityId: "workloom.guardrails", route: "/guardrails", legacyRoutes: ["/p5"], title: "围栏规则", group: "trust", icon: "rules", clients: ["b-pc", "b-mobile"], permission: "guardrails.read", source: "base", order: 10 },
  { capabilityId: "workloom.ledger", route: "/events", legacyRoutes: ["/event-ledger"], title: "事件账本", group: "trust", icon: "ledger", clients: ["b-pc", "b-mobile"], permission: "ledger.read", source: "base", order: 20 },
  { capabilityId: "workloom.exams", route: "/exams", legacyRoutes: ["/p24"], title: "考试院", group: "trust", icon: "exam", clients: ["b-pc", "b-mobile"], permission: "eval.read", source: "base", order: 30 },
  { capabilityId: "workloom.memory", route: "/memory", legacyRoutes: ["/p23"], title: "组织记忆", group: "trust", icon: "memory", clients: ["b-pc", "b-mobile"], permission: "memory.read", source: "base", order: 40 },
  { capabilityId: "workloom.night", route: "/night", legacyRoutes: ["/p9"], title: "夜班中心", group: "automation", icon: "night", clients: ["b-pc", "b-mobile"], permission: "night.read", source: "base", order: 10 },
  { capabilityId: "workloom.models", route: "/models", legacyRoutes: ["/model-routing"], title: "模型路由", group: "automation", icon: "model", clients: ["b-pc", "b-mobile"], permission: "models.read", source: "base", order: 20 },
  { capabilityId: "workloom.skills", route: "/skills", legacyRoutes: ["/p6"], title: "技能中心", group: "automation", icon: "skills", clients: ["b-pc", "b-mobile"], permission: "skills.read", source: "base", order: 30 },
  { capabilityId: "workloom.workspaces", route: "/workspaces", title: "公司与工作区", group: "organization", icon: "workspace", clients: ["b-pc"], permission: "workspace.manage", source: "base", order: 10 },
  { capabilityId: "workloom.customize", route: "/customize", legacyRoutes: ["/p26"], title: "定制中心", group: "organization", icon: "customize", clients: ["b-pc"], permission: "workspace.manage", source: "base", order: 20 },
  { capabilityId: "workloom.configuration", route: "/configuration", legacyRoutes: ["/p27"], title: "配置录入", group: "organization", icon: "configuration", clients: ["b-pc"], permission: "workspace.manage", source: "base", order: 30 },
  { capabilityId: "workloom.assembly", route: "/assembly", legacyRoutes: ["/p7"], title: "行业包中心", group: "organization", icon: "assembly", clients: ["b-pc"], permission: "assembly.read", source: "base", order: 40 },
  { capabilityId: "workloom.agents", route: "/agents", legacyRoutes: ["/p8"], title: "数字员工", group: "organization", icon: "agents", clients: ["b-pc", "b-mobile"], permission: "agents.read", source: "base", order: 50 },
  { capabilityId: "workloom.members", route: "/members", legacyRoutes: ["/p30"], title: "成员管理", group: "organization", icon: "team", clients: ["b-pc", "b-mobile"], permission: "members.read", source: "base", order: 60 },
  { capabilityId: "workloom.partners", route: "/partners", legacyRoutes: ["/p31"], title: "伙伴授权", group: "organization", icon: "partner", clients: ["b-pc"], permission: "partners.read", source: "base", order: 70 },
  { capabilityId: "workloom.account", route: "/account", legacyRoutes: ["/p29"], title: "个人与偏好", group: "mine", icon: "account", clients: ["b-pc", "b-mobile"], permission: "account.read", source: "base", order: 10 },
];

export interface ComposeNavigationOptions {
  client: WorkLoomClient;
  permissions?: ReadonlySet<string>;
  bundleEntries?: readonly NavigationEntry[];
}

export interface BundleNavigationSlot {
  /** 组合产品中由服务端验真后写入；单 Bundle 响应可省略并回退到顶层 bundleId。 */
  sourceBundleId?: string;
  capabilityId: string;
  route: string;
  title: string;
  group: string;
  icon: string;
  clients: readonly ("pc" | "b-mobile" | "c-mobile")[];
  permissions?: readonly string[];
}

const ICON_NAMES = new Set<IconName>([
  "home", "tasks", "report", "service", "approval", "ledger", "rules", "exam", "memory", "night",
  "model", "skills", "team", "workspace", "inbox", "account", "partner", "more", "executive", "customize",
  "configuration", "assembly", "agents", "developer", "menu", "close", "reset", "search", "notice", "chevron",
  "chat", "ticket", "star", "history", "warning", "check", "error", "edit", "lock", "pin", "book", "phone",
  "play", "copy", "like", "dislike", "gift", "cart", "radar", "send", "package", "experiment", "lightning",
  "medal", "rocket", "puzzle", "folder", "palette", "celebrate", "question", "brake", "circle", "document",
]);

/** 把已由服务端验证的 Bundle UI 槽位转换为三端共享导航；未知分组、图标或命名空间一律拒绝。 */
export function navigationEntriesFromBundle(bundleId: string, slots: readonly BundleNavigationSlot[]): NavigationEntry[] {
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(bundleId)) throw new Error("行业包标识不符合导航契约");
  return slots.map((slot, index) => {
    const sourceBundleId = slot.sourceBundleId ?? bundleId;
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(sourceBundleId)) throw new Error("行业导航来源标识不符合契约");
    if (!slot.capabilityId.startsWith(`${sourceBundleId}.`)) throw new Error(`行业导航能力必须使用 ${sourceBundleId}. 命名空间`);
    if (!NAVIGATION_GROUP_ORDER.includes(slot.group as NavigationGroup)) throw new Error(`行业导航分组不受支持：${slot.group}`);
    if (!ICON_NAMES.has(slot.icon as IconName)) throw new Error(`行业导航图标不受支持：${slot.icon}`);
    const title = clientChineseText(slot.title, "");
    if (!title) throw new Error("行业导航标题必须是通过客户端安全边界的中文名称");
    return {
      capabilityId: slot.capabilityId,
      route: slot.route,
      title,
      group: slot.group as NavigationGroup,
      icon: slot.icon as IconName,
      clients: slot.clients.map((client) => client === "pc" ? "b-pc" : client) as WorkLoomClient[],
      permissions: slot.permissions ?? [],
      source: `bundle:${sourceBundleId}`,
      order: 100 + index,
    };
  });
}

export function requiredNavigationPermissions(entry: NavigationEntry): readonly string[] {
  return [...new Set([...(entry.permissions ?? []), ...(entry.permission ? [entry.permission] : [])])];
}

export function composeNavigation({ client, permissions, bundleEntries = [] }: ComposeNavigationOptions): NavigationEntry[] {
  const all = [...BASE_NAVIGATION, ...bundleEntries];
  const seen = new Set<string>();
  for (const entry of all) {
    if (seen.has(entry.capabilityId)) throw new Error(`导航能力标识重复：${entry.capabilityId}`);
    seen.add(entry.capabilityId);
    if (entry.source.startsWith("bundle:") && !entry.capabilityId.includes(".")) throw new Error(`行业导航缺少命名空间：${entry.capabilityId}`);
    // 基座入口必须逐项授权；行业入口 permissions=[] 是已验 Bundle 对全体本工作区成员的显式声明。
    if (entry.source === "base" && requiredNavigationPermissions(entry).length === 0) {
      throw new Error(`基座导航入口缺少服务端权限标识：${entry.capabilityId}`);
    }
  }
  return all
    .filter((entry) => entry.clients.includes(client))
    .filter((entry) => permissions === undefined || requiredNavigationPermissions(entry).every((permission) => permissions.has(permission)))
    .sort((a, b) => NAVIGATION_GROUP_ORDER.indexOf(a.group) - NAVIGATION_GROUP_ORDER.indexOf(b.group) || a.order - b.order);
}

export function isNavigationActive(entry: NavigationEntry, pathname: string): boolean {
  return [entry.route, ...(entry.legacyRoutes ?? [])].some((route) => (
    route === "/" ? pathname === "/" : pathname === route || pathname.startsWith(`${route}/`)
  ));
}
