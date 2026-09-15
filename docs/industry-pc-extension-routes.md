# B 端 PC 行业页面扩展契约

行业专属页面只能放在 `apps/web/src/extensions/**`，不得修改受管的 `App.tsx`、导航或基础页面。基座会自动发现名为 `routes.ts` 或 `routes.tsx` 的扩展模块。

扩展模块必须导出 `industryRoutes` 数组：

```tsx
import type { IndustryRouteDefinition } from "../shell/IndustryRoutes";
import Orders from "./orders/Orders";

export const industryRoutes = [
  { path: "/orders", capabilityId: "hotel.orders", element: <Orders /> },
] satisfies readonly IndustryRouteDefinition[];
```

发布行业包时，还必须在 Bundle 的 PC 导航槽位声明相同 `capabilityId`、覆盖该页面地址的 `route`，并显式声明至少一项 `permissions`。页面是否可达以服务端验证后的当前 Bundle 和实时 `navigationPermissions` 为准；本地扩展声明不能授予权限。

基座会拒绝以下情况，并对整组行业扩展失败关闭：

- 使用 `workloom.*` 基座能力命名空间；
- 覆盖基座、登录、接入或开发诊断地址；
- 查询串、锚点、通配符、路径穿越、首段动态参数等危险地址；
- 两个声明产生相同匹配模式；
- 页面元素无效，或本地路径与服务端 Bundle 导航路径不一致。
- Bundle 导航槽位没有显式服务端权限。

行业详情页可使用 `/orders/:orderId` 形式，并与 `/orders` 导航槽位共用同一能力。接口读写仍必须使用服务端权限过程和围栏；页面可见不等于动作获权。
