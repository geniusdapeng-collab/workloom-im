# CNB 迁移收口手册（2026-09-18 更新）

> 背景：九仓从 GitHub 迁到 `cnb.cool/workloom-ai`。
> **UI 制品、仓库标识、九仓闸门均已落地并实测**；本文件记录结果、遗留项与复现命令。

## 0. 现状（已实测）

| 项 | 状态 |
|---|---|
| `@workloom/ui` 制品 | CNB Release 托管：`https://cnb.cool/workloom-ai/workloom-im/-/releases/download/ui-v0.1.1/workloom-ui-0.1.1.tgz`（HTTP 200，91,187 字节，由 `ui-release` 流水线在 CNB 内构建上传） |
| 仓库标识 | 九仓 `product.manifest.json`、`.workloom-runtime-deps/metadata.json`、`.workloom-base-sync.json`、`sync/child-repos.json`、脚本常量与文档链接全部指向 `cnb.cool/workloom-ai` |
| 基座闸门 | 三条**必需**流水线：`static-gate`、`db-gate`、`ui-gate`（Linux 视觉基线已在 CNB 同镜像内重生成） |
| 子仓闸门 | 八仓均已合并 `.cnb.yml`：`static-gate`（安装/产品身份/三端构建）与 `db-gate`（PG17+pgvector/迁移/种子幂等/验链）为**阻断**；`test-gate`（typecheck/主测试/全场景套件）为**显式非阻断**，登记为既有债务 |
| 旧 GitHub Actions | 保留为历史遗留（CNB 上不生效），暂未删除 |

## 1. 遗留项（按优先级）

1. **分支保护（唯一阻塞项）**：CNB API `POST /{repo}/-/settings/branch-protections` 与 `PUT /{slug}/-/settings/pull-request` 用当前令牌均返回 400（令牌缺仓库设置权限）。需要在网页 **设置 → 保护分支** 为 `main` 勾选：必须通过合并请求、需要通过状态检查、禁止强推/删除；或提供带设置权限的令牌后批量配置九仓。
2. **子仓 `test-gate` 转必需**：需逐仓修复既有债务：
   - 套件语义类：`H-14~H-18`（期望 real 模式）、`D-15`（R2 直译）、`H-33`（吊销并集收缩）、`J-01`（巡检正常快照）；
   - 依赖产物类：`apps/webc` 测试无法解析 `@workloom/ui/dist/language`（dist 产物为无扩展名 ESM 导入）——需在 `packages/ui` 构建产物中输出带 `.js` 扩展的导入，或让消费方走 bundler 解析；
   - 类型漂移类：`hyperreality-system`、`workloom` 等仓 `apps/server` 与当前基座 API 不一致（`IntentRuleExtension`、`KbSearchLexicon`、router 参数个数等）。
3. **`.cnb.yml` 是否纳入基座分发**：目前每仓一份、手工维护；建议纳入 `sync/base-scope.json` 受控资产，避免再漂移。
4. **发布链路**：桌面签名/公证 secrets 仍未配置（BLK-B-01-003）；`.github/workflows/*` 在 CNB 上无效，需按需迁移。

## 2. 复现命令（幂等）

发布共享 UI 制品（改 `UI_VERSION` 即换版本；流水线内含构建、打包、Release 资产上传与确认）：

```bash
curl -X POST -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"branch":"main","event":"api_trigger_ui_release"}' \
  https://api.cnb.cool/workloom-ai/workloom-im/-/build/start
```

子仓阻断闸门（PR 事件未触发时的 API 替代路径）：读取目标分支 `.cnb.yml` 并追加：

```yaml
$:
  api_trigger_gates:
    - *static_gate
    - *db_gate
    - *test_gate
```

再 `POST /{repo}/-/build/start`，`config` 传拼接后的 YAML、`event` 传 `api_trigger_gates`。

## 3. 迁移过程留痕（要点）

- **制品**：一次性流水线在 CNB 内 `pnpm -C packages/ui build` + `pnpm pack` → Release 资产上传（`asset-upload-url` → PUT → 确认）；`integrityByVersion["0.1.1"]` 同步为重建产物 `sha512-7OXEtRN…`（原 GitHub 制品已不可获取，按同源码重建）。
- **校验**：`sync/set-ui-version.mjs`、`scripts/verify-ui-consumer.mjs`、`sync/ui-lockfile-integrity.mjs`、`sync/ui-upgrade-pr.mjs` 的规范仓库/主机/路径校验切到 `cnb.cool` 与 `/-/releases/download/`；tamper 夹具保留外域 URL 以继续验证拒收。
- **闸门踩坑**：CNB 用 `sh`(dash) 执行脚本，不支持 `pipefail`；`.cnb.yml` 里写 DB 连接串字面量会被基座秘密扫描拦截，故统一从 `.env` 读取（子仓用安全解析循环，不 `source`，避免注释里的 `<32` 触发重定向）。
- **子仓安装**：`postinstall` 被剥离导致 `packages/industry-contract` 无 `dist` → typecheck 解析失败；已恢复为 `pnpm -C packages/industry-contract build && (node scripts/postinstall-note.js || true)`。
- **子仓种子**：多数仓 `seed.ts` 默认使用 `bundles/hotel` 演示夹具；andromeda 默认 `ai-pm`，其演示数据需要 `BUNDLE_DIR=bundles/hotel`。
- **视觉基线**：在 CNB 同镜像内跑 `pnpm ui:e2e:update` 重生成 Linux 基线并回推分支，随后把 `ui-gate` 由 `allowFailure` 转为必需（实测 4m0s 全绿）。

## 4. 收尾清理

- 临时分支可删除：`feat/cnb-ui-artifact`、`chore/cnb-migration-and-ui-gate`、`ci/cnb-gates`、`ci/ui-baseline-linux`、`ci/ui-gate-required`、`docs/*`；
- 吊销本轮会话中出现过的 CNB 令牌，改用带仓库设置权限的令牌或直接在网页配置保护规则。
