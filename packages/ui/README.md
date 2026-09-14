# @workloom/ui

WorkLoom IM 唯一维护的三端 UI 基座。它提供共享语义令牌、内容排版安全规则、中文显示边界、基础控件、状态反馈和三端应用壳。

## 使用约束

- B 端 PC、B 端移动和 C 端移动必须依赖同一个已发布版本。
- 行业仓只能通过 Bundle 的品牌白名单、术语、投影和扩展槽表达差异。
- 禁止复制本包源码、基础 token、导航、Dialog、Drawer、Toast、状态组件或图标实现。
- 未知后端字段默认不得呈现；只有授权诊断界面可显式显示内部字段名。

## 引入

```ts
import "@workloom/ui/tokens.css";
import "@workloom/ui/content-safety.css";
import "@workloom/ui/components.css";
```

CSS 必须按上述顺序引入。组件不依赖 `react-router`；导航、路由切换、状态持久化和权限过滤均由调用方通过属性与回调注入。

## 基础 API

| 范围 | 导出 | 接入约束 |
| --- | --- | --- |
| 操作与表单 | `Button`、`IconButton`、`Link`、`Input`、`Select`、`Combobox`、`Textarea`、`Checkbox`、`Radio`、`Switch`、`Badge`、`Tag`、`Avatar` | 表单控件必须传中文 `label`；纯图标操作必须传可访问名称；新窗口链接自动补安全属性 |
| 弹层 | `Dialog`、`ConfirmDialog`、`Drawer`、`Sheet`、`Popover`、`Tooltip`、`Toast`、`OverlayManager`、`FullscreenSurface` | 三端根节点必须各有且仅有一个 `OverlayManager`；阻断浮层统一包含焦点圈定、恢复、Esc、背景 inert 与引用计数滚动锁 |
| 运行状态 | `AsyncState`、`EmptyState`、`ErrorState`、`DemoBanner`、`OfflineState`、`PermissionState`、`Skeleton`、`Progress` | 错误、无权限和离线不可伪装为空数据；动态文案必须使用用户可理解的中文 |
| 导航与框架 | `TopContextBar`、`SideNav`（`SideNavigation` 兼容名）、`BottomTabs`、`AppShell`、`Grid`、`ResizablePanel`、`SplitView`、`WorkspaceSwitcher` | PC 使用左侧导航，移动端使用底部导航；不得再叠加第二套顶部主导航 |
| 协作与数据 | `Confidence`、`Delta`、`Table`、`FilterBar`、`Timeline`、`Chart`、`ExportDialog` 及既有治理模式 | 颜色不得成为唯一状态编码；图表必须带读屏数据表；导出继续受账号权限约束 |
| 导航数据 | `BASE_NAVIGATION`、`composeNavigation`、`navigationEntriesFromBundle` | 行业页面只能通过已验证的行业包导航槽加入，组件不读取行业硬编码 |

## 表单示例

```tsx
import { Input, Select, Switch } from "@workloom/ui";

<Input
  label="企业完整名称"
  description="请输入营业执照上的完整中文名称"
  error={errors.companyName}
  value={companyName}
  onChange={(event) => setCompanyName(event.currentTarget.value)}
/>
<Select label="经营行业" value={industry} onChange={(event) => setIndustry(event.currentTarget.value)}>
  <option value="service">客户服务</option>
</Select>
<Switch label="启用夜班运行" checked={nightShift} onChange={(event) => setNightShift(event.currentTarget.checked)} />
```

标签、说明、错误与控件会自动建立 ARIA 关联。长中文允许自然换行，正文和交互文字使用共享 `--wl-text-body`，触控环境的操作目标不小于 `--wl-touch-target`。

## 三端应用壳示例

```tsx
import { AppShell, BottomTabs, SideNavigation, TopContextBar } from "@workloom/ui";

<AppShell
  topBar={<TopContextBar title="今日经营" description="数字员工正在处理 3 项任务" />}
  sideNavigation={(
    <SideNavigation
      entries={navigationEntries}
      activeRoute={pathname}
      onNavigate={(entry) => navigate(entry.route)}
    />
  )}
  bottomTabs={(
    <BottomTabs
      items={mobileTabs}
      activeId={activeTabId}
      onSelect={(item) => navigate(item.id)}
    />
  )}
>
  {page}
</AppShell>
```

`navigationMode="responsive"` 在宽视口呈现侧边导航，在窄视口和 200% 缩放下切换到底部导航。`SideNavigation` 支持上下方向键、Home、End；`BottomTabs` 支持左右方向键、Home、End。

## 可调面板与确认动作

```tsx
<ResizablePanel
  title="任务详情"
  size={panelSize}
  collapsed={panelCollapsed}
  onSizeChange={setPanelSize}
  onCollapsedChange={setPanelCollapsed}
>
  {taskDetail}
</ResizablePanel>

<ConfirmDialog
  open={confirmingPublish}
  title="确认发布围栏规则"
  confirmLabel="确认发布"
  confirmVariant="danger"
  onConfirm={publishRule}
  onClose={() => setConfirmingPublish(false)}
/>
```

`ResizablePanel` 是受控组件，调用方负责按租户与用户保存 `size` 和 `collapsed`。拖拽手柄同时支持方向键、Home、End；Enter 恢复 `defaultSize`，双击也可恢复原始大小。

## 浮层宿主

```tsx
import { OverlayManager } from "@workloom/ui";

createRoot(rootElement).render(
  <OverlayManager toasts={toastItems}>
    <App />
  </OverlayManager>,
);
```

`OverlayManager` 是三端根节点能力，不是行业页面容器。多层 Dialog/Drawer/Sheet 共用后进先出的 Esc 栈；内层关闭前不会提前解除背景 `inert` 或 `body` 滚动锁，关闭后焦点逐层回到触发位置。Popover 与 FullscreenSurface 也加入同一 Esc 顺序，但 Popover 不把页面背景设为阻断状态。

## 可访问性与内容安全

- 所有动态容器均允许收缩，标题、正文、按钮和导航标签可换行，不依赖固定画布。
- 纯图标操作必须使用 `IconButton`，装饰图标由共享 `Icon` 自动对辅助技术隐藏。
- 200% 缩放进入响应式布局；移动触控目标至少 44px，可调面板手柄扩大到 20px。
- 动效遵循 `prefers-reduced-motion`；未知底层字段继续由中文显示边界拦截，不得把原始键名作为兜底。

发布由 WorkLoom IM 的 `ui-v*` 稳定标签触发。现有行业仓通过机器人升级 PR 消费，新行业脚手架读取 `sync/base-capabilities.json` 的稳定版本。
