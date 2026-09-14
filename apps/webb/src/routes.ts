import { composeNavigation, type BottomTabItem } from "@workloom/ui";

/** 移动端一级入口使用共享 BottomTabs 契约；id 即现有语义路由，不引入第二套路由状态。 */
export const B_MOBILE_PRIMARY_TABS = [
  { id: "/", label: "今日", icon: "home" },
  { id: "/inbox", label: "待办", icon: "inbox" },
  { id: "/tasks", label: "任务", icon: "tasks" },
  { id: "/operations", label: "经营", icon: "report" },
  { id: "/account", label: "我的", icon: "account" },
] as const satisfies readonly BottomTabItem[];

/** B 端移动生产壳实际承载的语义路由；新增基座入口必须先完成页面再进入导航。 */
export const B_MOBILE_SUPPORTED_ROUTES = new Set([
  "/",
  "/inbox",
  "/approvals",
  "/tasks",
  "/operations",
  "/reports",
  "/executive",
  "/events",
  "/exams",
  "/memory",
  "/night",
  "/models",
  "/guardrails",
  "/skills",
  "/agents",
  "/members",
  "/account",
]);

export function isBMobileRoute(pathname: string): boolean {
  return B_MOBILE_SUPPORTED_ROUTES.has(pathname);
}

export function unsupportedBaseBMobileRoutes(): string[] {
  return composeNavigation({ client: "b-mobile" })
    .map((entry) => entry.route)
    .filter((route) => !B_MOBILE_SUPPORTED_ROUTES.has(route));
}
