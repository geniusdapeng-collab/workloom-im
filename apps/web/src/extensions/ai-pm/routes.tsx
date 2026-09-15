import P25 from "./P25";

/** AI 产品经理示例能力完全由 Bundle 声明和服务端权限投影放行。 */
export const industryRoutes = [{
  path: "/development",
  legacyPaths: ["/p25"],
  capabilityId: "ai-pm.development",
  element: <P25 />,
}] as const;
