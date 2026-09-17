# CNB 迁移收口手册（2026-09-17）

> 背景：九仓从 GitHub 迁到 `cnb.cool/workloom-ai`。基座闸门已落地并全绿；下游仍有三个待办。
> 本文件是收口清单，按顺序执行即可，不需要重新探查。

## 0. 现状（已实测）

| 项 | 状态 |
|---|---|
| 基座 `workloom-im` 闸门 | `static-gate` / `db-gate` 必需且全绿；`ui-gate` 显式 `allowFailure`（15 用例过 14，仅静态视觉基线跨环境差异） |
| 文档 `WORKLOOM_PRODUCT_CONTEXT.md` | 九仓均为 2026-09-17.2，记账已同步 |
| 八仓闸门 PR | 已开（各仓 PR #2），**依赖安装即失败**，根因见 §1 |
| 分支保护 | 未配置（CNB API 需仓库设置权限的令牌，见 §4） |

## 1. 根因：下游 `@workloom/ui` 指向已失效的 GitHub Release tarball

八仓 `pnpm install --frozen-lockfile` 实测报错：

```
ERR_PNPM_FETCH_404 GET https://github.com/geniusdapeng-collab/workloom-im/releases/download/ui-v0.1.1/workloom-ui-0.1.1.tgz
```

即 `@workloom/ui` 的制品仍托管在已封禁的 GitHub 组织。**这是 DEF-P1-0015「下游 CI 既有红灯」的真实根因。**

### 1.1 迁移步骤（成套改，缺一即红）

1. **确定新落脚点**（三选一，推荐 A）：
   - A. 发布到 CNB：在基座跑 `pnpm -C packages/ui build && pnpm -C packages/ui pack`，把 `workloom-ui-<version>.tgz` 作为 CNB Release 附件/制品上传，得到稳定 URL；
   - B. 仓内 vendor：把 tarball 提交到基座 `vendor/ui/`，消费方用 CNB 原始文件 URL；
   - C. 改为 workspace 依赖：把 `packages/ui` 纳入 `sync/base-scope.json` 的 include，三端改用 `workspace:*`——改动最大，但彻底摆脱制品分发。
2. **基座侧同步修改**（缺一即 `ui:governance` / `verify-ui-consumer` 红）：
   - `sync/base-scope.json#registryCapabilities`（`distribution` 字段是代码级契约，改前先改 `sync/base-sync.mjs` 的判定）、`sync/base-capabilities.json`；
   - `sync/{client-foundation,set-ui-version,ui-upgrade-pr}.mjs` 里的 URL 模板与校验；
   - 测试夹具：`sync/base-sync.test.mjs`、`sync/client-foundation.test.mjs`、`sync/set-ui-version.test.mjs`、`sync/ui-upgrade-pr.test.mjs`、`scripts/verify-ui-consumer.test.mjs`。
3. **消费方（8 仓）逐仓改**：`apps/{web,webb,webc}/package.json` + `pnpm-lock.yaml` 里的 tarball URL；`.workloom-client-foundation.json` 的 `uiArtifact.url`；再 `pnpm install` 重建 lock。
4. **回读验证**：每仓 PR 上 `static-gate` 的「依赖安装」必须绿，再跑 `pnpm ui:governance`。

## 2. 仓库标识迁移（与 §1 同一批做）

单独改会红（已实测）：`runtime:deps:verify` 与载荷身份策略把下列文件强绑定，必须一起改：

- `product.manifest.json#repository`、`.workloom-runtime-deps/metadata.json#product.repository`
- `sync/child-repos.json#baseRepo` 与 `children[].repo`
- `.workloom-client-foundation.json`（各仓）
- README / `apps/site/*.html` 的跳转链接（shields.io 徽章图片 URL 不动）
- 夹具：`sync/*.test.mjs`、`scripts/verify-ui-consumer.test.mjs`

## 3. ui-gate 转必需（视觉基线）

1. 在 CNB 环境跑 `pnpm ui:e2e:update`（同一镜像、同一 Playwright 版本）生成基线；
2. 把新基线提交回基座（`tests/ui/` 下的快照）；
3. 把 `.cnb.yml` 里 `.ui-gate` 的 `allowFailure: true` 删除，加入必需检查。

## 4. 分支保护（需要仓库设置权限）

CNB API：`POST /{repo}/-/settings/branch-protections`（本令牌返回 400，疑似缺少设置类 scope）。
在网页 **设置 → 保护分支** 为 `main` 勾选：

- 必须通过合并请求推送（`required_must_push_via_pull_request`）
- 需要通过状态检查（`required_status_checks`）
- 禁止强制推送 / 禁止删除
- 建议：禁止 NPC 批准自己创建的 PR（`forbid_approve_pull_created_by_own_npc`）

必需检查名（CNB 生成）：`cnb/pull_request/pipeline-1(static-gate)`、`cnb/pull_request/pipeline-2(db-gate)`。

## 5. 完成后

- 八个行业仓闸门 PR 转绿并合并；
- 删除临时分支 `ci/cnb-gates`、`chore/cnb-migration-and-ui-gate`、`docs/*`；
- 吊销本轮使用过的 CNB 令牌（已在会话中出现过）。
