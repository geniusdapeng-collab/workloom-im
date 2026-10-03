# B 端 PC 行业页面扩展契约

行业专属页面只能放在 `apps/web/src/extensions/**`，不得修改受管的 `App.tsx`、导航或基础页面。基座会自动发现名为 `routes.ts` 或 `routes.tsx` 的扩展模块。

扩展模块必须导出 `industryRoutes` 数组：

```tsx
import type { IndustryRouteDefinition } from "../shell/IndustryRoutes";
import Orders from "./orders/Orders";

export const industryRoutes = [
  {
    path: "/orders",
    legacyPaths: ["/p10"],
    capabilityId: "hotel.orders",
    element: <Orders />,
  },
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

`legacyPaths` 只用于把历史非基座地址通过 `Navigate replace` 重定向到语义主路由。别名进入与主路由相同的服务端能力权限边界，不能单独配置页面或权限；查询参数与锚点会被保留。动态别名必须与主路由使用完全相同的参数名，例如 `/p10/:orderId` 可映射到 `/orders/:orderId`。任何别名都不得占用 `/p1`、`/p4`、`/p6`、`/p8` 等基座地址，也不得占用登录、接入或开发诊断地址。

装配器的「界面状态用例」检查使用当前 PC 的真实页面登记。公共 `Routes` 与登记生成器共同消费 `App.tsx` 的 `BASE_ROUTE_REGISTRY`；行业页面从 PC 同一份 `INDUSTRY_ROUTE_REGISTRY` 取得，并在生成时验证实际导入的 React 页面元素。任一行业模块缺失、页面元素无效或路由匹配模式冲突，都不会产出部分登记。

开发或 CI 修改 PC 源码后，先运行 `pnpm -C apps/web pages:registry`，再提交生成的 `apps/web/src/projections/pc-page-registry.json` 与源码。此登记属于本产品的工具产物，包含整个 PC 源码树的摘要；各行业仓必须生成自己的文件，不能复制另一个行业的登记。登记缺失、损坏、过期或不属于当前产品时，装配检查失败并拒绝激活。仅运行后端测试或数据库初始化也可以消费已提交登记，不需要在服务端启动 Vite 或 React。

`pnpm -C apps/web build` 会自动重新生成来源登记，并把最终入口 HTML、脚本和样式摘要绑定到 `apps/web/dist/pc-page-registry.json`。正式载荷必须携带当前源码和这一份真实构建登记。生产运行时只读取静态登记，并核验源码、构建文件内容与文件清单；没有生产构建登记时不会回退开发登记。登记生成器仅使用构建依赖，在隔离进程内运行，有递归拒绝和 45 秒硬超时；这些构建依赖不进入装配运行时。

用例的 `page` 可引用真实语义路径（包括详情路由模式），或真实路由的历史编号，如 `p13`。`ui/cases.json` 的 `pages` 数组只用于说明，不能自行登记页面。行业用例还必须同时满足本 Bundle 的行业命名空间、相同能力标识、覆盖该页面地址的 PC 导航、非空权限以及本 Bundle 自有权限清单。`b-mobile` 导航、相似路径前缀或其他行业的历史编号都不能授予 PC 页面。

例如，已有公共 `p2` 用例可以继续校验；`hotel.orders` 页面只有当前酒店 Bundle 声明对应 PC 导航和权限时才可校验；第三行业草稿可以复用公共装配能力，但复制酒店的 `p13` 用例或权限不能获得酒店页面。未知页面、缺少权限或不可核验的登记会在激活前失败，工作区行业、档案和激活事件保持原状态。行业包的资产摘要、发布状态及 Ed25519 验签仍由现有 Bundle 验证链独立执行。
