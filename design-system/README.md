# WorkLoom 旧版设计快照（只读、待下线）

> **禁止新接入、禁止复制。** 本目录仅用于旧页面迁移时比对历史视觉；WorkLoom 三端唯一生产事实源已经迁移到 `packages/ui`，并以 `@workloom/ui` 稳定版本发布。

## 历史文件

| 文件 | 当前用途 |
|---|---|
| `design_spec.md` | 历史设计规范和迁移参考 |
| `tokens.web.css` | 历史 B 端令牌快照，不再是事实源 |
| `tokens.webc.css` | 历史 C 端令牌快照，不再是事实源 |
| `components.css` | 历史组件 CSS 快照，不得新增引用 |

## 生产接入

```css
@import "@workloom/ui/tokens.css";
@import "@workloom/ui/content-safety.css";
```

行业仓必须锁定 `sync/base-capabilities.json` 指定的稳定版本；基座仓使用 `workspace:*`。不得把包内容复制回本地样式目录。

静态演示页不再算作 B 端移动生产客户端，也不得作为新功能验收证据。迁移完成后由共享 React/PWA 壳替代。

## 修改与发布

1. 只在 WorkLoom IM 的 `packages/ui` 修改 token、基础组件和交互契约。
2. 在基座完成三端、无障碍、长中文、缩放和视觉回归门禁。
3. 更新稳定版本清单并发布 `ui-v*` 标签。
4. 发布流程为每个现有行业仓创建依赖升级 PR；行业仓 CI 通过后逐仓合并。
5. 新行业通过 `sync/adopt.sh --new-industry` 一次生成并锁定当时最新版的共享 UI 与三端客户端基座；没有稳定版本、独立产品身份或任一真实生产入口时拒绝接入。

## 历史版本

- v1.1（2026-08-26）：旧版快照；已进入迁移期。
- v1.0（2026-08）：旧版快照。
