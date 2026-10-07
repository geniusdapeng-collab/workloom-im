# WorkLoom 开发协作协议（v2，2026-10-07 修订）

> 生效范围：workloom-im 唯一定义，base-sync 分发各订阅仓只读副本（舰队清单见 `sync/child-repos.json`；新仓由每日舰队扫描自动纳管；隔离副本仓不适用，见 §11）。
> 定位：用 CNB 原生 Issue、保护分支、流水线、锁和 PR，配合 Git 持久化交付状态，完成开发占用、当前 Codex 会话审查实测、集成恢复与真实发布回执。
> 本协议适用默认研发规则；产品所有者对当前任务的明确授权优先。2026-10-07 明确要求当前 Codex 自带模型在提交/发布前完成 review 和实际测试，撤销 CNB/GitHub 等平台 AI 审核、模型代理和 NPC 自动修复；不要求用户逐 PR 点击批准；真实资金、秘密、客户数据与不可逆经营动作仍须单独明确授权。
> 交付器代码：`scripts/delivery/queue-*.mjs`；运行配置：`scripts/delivery/cnb.yml`；持久状态：`automation/delivery-state`。不引入客户业务数据库或新常驻服务。
> 修订记录：2026-09-22 · 新增 §11「隔离副本车道」（growthtest / growthmatrix 双向不同步）；统一任务号书写为 `T-YYYY-MMDD-XXXX` 并同步提交门禁提示。
> 2026-10-07 实际启用补记：十二仓研发机制的准确源码、原生运行与账本回读见根级 `WORKLOOM_PRODUCT_CONTEXT.md` §14.6 及 `docs/development-delivery/2026-10-07-verification.json`。这是研发交付专项快照，不代表行业全量审计；两隔离副本的本仓点名安装例外见 §11。

## 1. 五条硬规则

1. **一任务一开发分支一原 PR**：任务卡为 CNB Issue（标题 `[T-YYYY-MMDD-XXXX]`），开发分支为 `task/T-YYYY-MMDD-XXXX`。交付器可以创建对应的不可修改候选 PR；这是同一任务的机器集成副本，不是新开发任务。
2. **任务号进提交信息**：`<type>(<layer>): <摘要> [T-YYYY-MMDD-XXXX]`，由 `verify-commit-msg.mjs` 校验。
3. **开发占用与等待分开**：独立工作树开发；普通文件重叠只告警。敏感模块开发前取得限时租约，交接或等待 CI/评审前释放。open/WIP/红灯 PR 本身不持锁。
4. **当前 Codex 会话 review/实测与必需检查满足后，由机器串行合并**：正常研发包括协议、CI、迁移和信任要素代码维护，当前会话精读所有变化文件及直接依赖、运行必要测试，再通过 handoff 保存绑定 repo/source/main/policy/完整范围的真实记录；不可修改候选重跑原仓 CI。禁止调用平台 AI 审核/模型/自动修复，不等待用户点击 Approve。平台 PR、状态检查和禁直推/强推保留，取消额外人工计数与管理员批准。`risk/block`、WIP 和真实经营执行/秘密路径不自动交付。`risk/review` 表示加强审查，不能跳过会话 review 和检查。
5. **无真实回执不算完成**：集成回执绑定 source/main/tested SHA；声明的发布还须构建、标签、清单和实际字节摘要回读。Issue 五行回执由交付器生成；缺发布证明不得写成已发布或关闭发布任务。

## 2. 四问（落笔前写进 Issue）

1. 改的是公共机制、平台运营机制，还是行业语义？
2. 是否涉及租户、围栏、审批、事件、回执；修改实现还是执行真实经营动作？
3. 应进入基座、Andromeda 还是行业包；哪些订阅仓受影响？
4. 如何测试、灰度和回滚；是否声明 UI/桌面制品发布？

能根据代码和任务自行确定的事项自主完成。只有不可恢复的破坏性操作、方向性硬矛盾或无法获取的必要信息才需要用户澄清。业务红线 `block > review > auto` 不因研发自动评审而放宽。

## 3. 目录与授权边界

| 类别 | 规则 |
|---|---|
| 禁止 | 子仓扩散 platform-ops/平台秘密；公共层污染行业语义；秘密落盘/外泄；客户原始数据上行；模拟回执伪装真实；Tiger 真实交易未获单独授权 |
| 正常研发加强 Codex 会话审查实测 | 租户/围栏/审批/事件/回执代码，protocol、sync、CI、迁移、共享文档和跨仓公共机制。必须精确绑定审查范围和必需检查，不能以“治理文件”为由永久等待人工点击 |
| 真实经营/破坏性动作 | 资金、实盘、秘密轮换、客户外发或不可逆操作，需要产品所有者单独明确授权；自动研发交付授权不覆盖这些动作 |

代码中实现一个审批功能和用它执行真实转账是不同动作。交付器对 `platform-ops/secrets/`、`secrets/`、`trading/live/`、`broker/live/` 保持硬阻断；当前 Codex 会话必须核对业务授权和租户边界。

凭据只在会话进程或平台原生 CI 环境内使用，禁止进入源码、文件、Git 配置/remote、PR/Issue、日志和 CI 自定义变量。用户会话令牌不能被写入持续执行器；云端只使用 CNB 自动注入的原生代码托管/CI 令牌，不使用模型或 CodeBuddy 凭据。

## 4. 三类互斥与依赖

- **开发租约**：`sync`、`protocol`、`migrations`、`dependencies` 四个敏感范围，以 `queue-model.mjs#sensitiveScopes` 为准。默认 TTL 15 分钟，每 5 分钟续租；owner + generation 必须匹配，过期重领增加 generation，旧 owner 不能续租或释放新租约。一次多范围申请要么全成功，要么全失败。
- **敏感源码正向接纳**：CI 不把“没有其他 holder”当成敏感源码已获准。trusted main 的独立 admission 流水线自动取得 `admission/pr-N` 的 scoped lease，保存准确 head/main、完整文件摘要和正 generation，再立即释放；源 CI 要核对只增 acquire→release→source_admitted 回执。更高的后续 generation 不否定旧源码的历史接纳证明，实际集成仍必须重新领取当前 generation。此接纳使用独立原生锁，会话 review 和等待检查不占住新 PR 的接纳。首装 prepare-install 同时准备这一证明。仅收到脚本而 main 尚无 delivery include、账本尚未初始化时，保留旧敏感重叠规则；显式安装后账本缺失、损坏、权限失败仍拒绝。
- **集成互斥**：所有合并调用进入同一仓级 CNB 原生锁 `workloom-delivery-merge`。创建 `delivery/candidate/**` 保护分支时固定 source SHA；所有人含管理员禁止推送、强推和删除。真实候选 PR 上的 CI 与当前 Codex 会话记录绑定相同 source/main，合并必须回读准确双亲。敏感候选在合并前由执行器强制取得 owner/generation 集成租约，在发出请求前再次核验；开发者未显式领租约也不能绕过此集成围栏。租约只覆盖集成短步骤，成功或未发出请求的失败立即释放，未知写结果先回读。普通 merge 主干进入开发分支，禁止 force/rebase 改写用户历史；语义冲突保存准确诊断，由当前 Codex 会话修复并重做 review/测试；执行器不得派发平台 NPC。
- **发布互斥**：UI/桌面按环境独立排队、固定已合入 SHA/版本，失败保持真实欠项，不能跳过无关代码集成；启动回执不明时先回读构建，不能重复部署。
- **语义依赖**：PR 正文的 `workloom-delivery.depends_on`、平台 blocked_on 与 Codex 会话审查记录中的前置 PR 合并为 DAG。只有真实合入的当前源码才满足前置条件；关闭但未合入不算完成；循环依赖停在相关任务，不堵全仓。
- **普通路径重叠**：只提示协作和后续冲突；不按 PR 编号永久占位。`--strict` 是显式诊断模式。source/target/current-main/merge-base 的新鲜度仍为硬检查。

```bash
node scripts/delivery/queue-runner.mjs lease --repo workloom-ai/workloom-im --owner T-2026-1005-1001 --scopes protocol,sync
# 使用上一步实际返回的 generation 续租/释放，不能手写假回执
node scripts/delivery/queue-runner.mjs lease --repo workloom-ai/workloom-im --action renew --owner T-2026-1005-1001 --scopes protocol,sync --generation '{"protocol":1,"sync":1}'
node scripts/delivery/queue-runner.mjs handoff --repo workloom-ai/workloom-im --pr 123 --depends-on 122 --review-receipt /path/to/actual-review.json
```

数字仅说明命令参数；实际 PR 和 generation 必须来自当前任务的回读。交接前必须用 lease --action release 和实际 owner/generation 显式释放租约；handoff 不按任务号或 ready 自动释放。handoff 只在干净准确源码、现行主干/检查实现和成功本地测试记录成立时保存回执及显式依赖，不把草稿强改为可交付。

## 5. 提交规范（放宽版）

```
<type>(<layer>): <摘要> [T-YYYY-MMDD-XXXX]
```

- `type`：`feat | fix | sync | protocol | exam | docs | test | chore | ci`（`test` 测试类、`ci` 流水线/脚本类）
- `layer`：`base | platform | hotel | video | growth | ecom | tiger | eagle | fox`（按仓库映射，脚本自动推断）
- **豁免**（无需任务号）：`Merge` / `Revert` 提交、`sync(...)` 同步器产出、`chore(ci)`、`rescue:`、`HP-<数字>` 审计批次、`chore(deps)`。
- **过渡期祖父规则**：早于 `2026-09-19T00:00+08:00` 的提交只校验 `type`（存量分支与并行车道不追溯；layer/任务号问题降级为告警）；此后的新提交必须满足 type + layer + 任务号。
- 过渡开关：`PROTOCOL_TASK_ID_OPTIONAL=1` 时只校格式、不强制任务号。
- layer 与目标仓不一致时按**告警**处理（不阻断合并），仅 `type` 非法与缺任务号（过渡期后）属于硬失败。
- body 建议附：四问的 q1/q3 摘要 + Issue 链接。本地 hook 可选（`core.hooksPath`），**CI 才是真闸门**。

## 5.1 任务卡标签体系（CNB 实测上限：每仓 10 个标签）

CNB 每仓**最多 10 个标签**（实测：创建第 11 个返回 201 但不落库），因此采用压缩标签集：

| 标签 | 含义 |
|---|---|
| `t/draft` | 已建卡，四问未答全 |
| `t/doing` | 已派发/已领/执行中（合并原 clarified/dispatched/leased/in-progress） |
| `t/review` | 待当前 Codex 会话 review/实测；真实经营动作另按授权处理 |
| `t/done` | 已合并且有回执 |
| `t/blocked` | 阻塞或取消（须在 Issue 写明原因） |
| `risk/review` | 风险等级：加强会话审查实测（真实经营动作按单独授权） |
| `risk/block` | 风险等级：禁止（红线） |
| `src/human` | 来源：人 |
| `src/auto` | 来源：漂移报告 / 事故 / 考试失败（自动生成） |
| `protocol` | 协议类任务 |

配套：十个订阅仓均已创建这 10 个标签（隔离副本仓不参与纳管，见 §11）；任务集看板按 `t/*` 分列即可（无需 18 个细粒度状态）。

## 6. 交接与恢复

- 触发：上下文将满、任务阶段切换、会话暂停、跨终端接手前。
- 交接单（`protocol/handoff.schema.json` 字段）：`task_id / progress / decisions / open_questions / next_steps / worktree(branch, 未提交摘要) / protocol_version`。
- 存放：Issue 评论（首选）或 `docs/handoffs/H-<日期>-<序号>.json`（随 PR 提交）。
- 恢复顺序：读 Issue 任务卡 → 读最近交接单 → `git log` 对账 → 继续；**交接单与 git/Issue 冲突时以 Issue + 代码为准**。

## 7. 交付器持久化与重试边界

`automation/delivery-state` 保存任务、租约、依赖、尝试、审查、集成与发布回执及只增事件链。普通 fast-forward Git push 是状态 CAS；写响应丢失按 transaction ID 回读，失败不能当完成。CI/评审阶段不持开发租约。

每轮最多普通对齐两条、准备两条候选；主干对齐每组源码/主干最多三次。源码/主干漂移使原会话记录失效；缺 review 或发生红灯、语义冲突时只保存 repairRequired 诊断，不创建付费模型调用，由 Codex 会话修复后重新提交和实测。真实外部合并响应不明暂停后续集成直到正向回读，防止重复写。未就绪、权限错误和构建红灯保留原分支与失败证据，不能降低门禁。

## 10. 实验车道（fox / growth 等深度定制仓）

问题：`workroom-fox` 与 `WorkLoom-growth` 在共享壳之上做了**深度游戏化定制**（fox：3D 汇报舞台 + 实景商业游戏 M2-a；growth：hud/star-ring/P0 的经营游戏化）。这些**不是基座能力**，如果强行与基座保持一致，会被两类机制抹掉或卡死：

1. **普通 base-sync**：若实验路径落在 `include` 内，同步会覆盖；
2. **三端客户端基座升级**：受管根 `apps/{web,webb,webc}` 内的差异，只要不在 `allowedIndustryExtensionPaths` 白名单里，就会被判 `ILLEGAL_INDUSTRY_APP_PATH` / `MANAGED_FILE_MODIFIED` 并 **fail-close**（升级被拒）。

### 10.1 解法：三层资产 + 声明式实验路径 + 双向护栏

| 层 | 内容 | 规则 |
|---|---|---|
| L0 公共能力 | `packages/{base,runtime,shared,db,ui}`、`apps/server/src`、`scripts/**` | 基座唯一下发，禁止实验语义回流 |
| L1 行业语义 | 各行业 bundle / seed / 服务前台 | 经 bundle 槽位注入，可下发 |
| L2 实验语义 | fox 的游戏舞台与赛季引擎、growth 的经营游戏化 | **只在该仓存在**：不下发、不覆盖、不回流（要进基座必须先走提案任务卡） |

实验仓在 `sync/child-repos.json` 里显式声明（`sync/child-repos.json` 是机器可读事实源）：

```json
{
  "repo": "workloom-ai/workroom-fox",
  "lane": "experiment",
  "experimentNote": "为何属于实验语义",
  "experimentPaths": ["apps/web/src/campaign/**", "apps/web/src/components/fox-campaign/**"],
  "industryExtensionPaths": ["apps/*/src/campaign/**", "apps/*/src/components/fox-campaign/**"]
}
```

- `experimentPaths`：实验定制的**实际路径**（护栏据此检查）；
- `industryExtensionPaths`：**仓级扩展白名单**，被 `client-foundation` 合并进全局白名单 → 这些路径在 UI 升级时不再被判分叉、也不会被覆盖；
- 命令：`node scripts/tools/experiment-guard.mjs [--check]` 校验这两件事（每日 cron 自动跑；违规即红）。

### 10.2 实验仓的三条纪律

1. **只增不改基座契约**：可以新增实验目录（并登记进 `experimentPaths`），但不修改 `packages/**`、`apps/server/src/**` 的公共行为；
2. **公共化必须提案**：实验里验证成功的通用交互能力，先写提案任务卡（L2→L1→L0），不得整包搬进基座；
3. **新实验仓接入即声明**：舰队扫描发现新仓 → 纳管时同步填写 `lane/experimentNote/experimentPaths/industryExtensionPaths`，否则护栏会报警（`MISSING_NOTE` / `MISSING_PATHS` / `UI_UPGRADE_WOULD_FAIL`）。

### 10.3 受管文件分叉容差（2026-09-27 新增，解除 fox 波次暂停）

**问题**：实验仓声明的自有路径（`industryExtensionPaths`）如果**同时**出现在稳定客户端基座快照里
（例如 fox 的 `apps/*/src/pages/p0/**`、`apps/*/src/voice/**`），或**已被旧 state 登记成基座受管文件**，
`client-foundation` 会 fail closed（`客户端基座快照不得占用行业扩展路径` /
`state 不得把行业扩展登记成基座受管文件`），波次永久卡住。fox 自 0.1.8 起就停在这里。

**决策（产品所有者指令：解决 fox/tiger 覆盖）**：实验车道引入**受管文件分叉容差**，但不是"放宽校验"，而是**退管迁移**：

| 项 | 规则 |
|---|---|
| 生效范围 | 默认 `lane: experiment` 的仓；**产品分叉仓**可在 `sync/child-repos.json` 显式声明 `tolerateExtensionSnapshotOverlap: true` 获得同一容差（2026-09-30 起，T-2026-0930-0003「仓级扩展路径全链路」）；未声明者（含 tiger 这类行业仓）保持严格 fail closed |
| 触发条件 | 稳定快照占用该仓声明的 `industryExtensionPaths`，或旧 state 已把这类路径登记为受管文件 |
| 动作 | 这些路径**不覆盖、不删除**，从新 state 的 `managedFiles` 移除，并在 `state.retiredManagedForks` 留痕（路径 + 退管版本 + 原因） |
| 代价（必须知情） | 退管路径**从此不再接收基座更新**，由该仓自持；要拿回基座版本需先删除声明并另开迁移任务卡 |
| 门禁一致性 | rollout 把 `lane` 与 `industryExtensionPaths` 写入仓内 `.workloom-ui-governance.json`；仓内自包含门禁（`verify-client-foundation-consumer.mjs`）据此豁免这些路径，不再要求各仓自持一份扩展声明文件 |
| 单一事实源 | 仓级扩展路径只认 `sync/child-repos.json#children[].industryExtensionPaths`；仓内私改该声明会在下一次 rollout fail closed |

**暂停仓恢复步骤**：① 在 `sync/child-repos.json` 把 `uiRolloutWave` 从 `paused` 改回真实波次；
② `node sync/ui-upgrade-pr.mjs --rollout --wave <波次>`（默认按波次顺序，先到先得）；
③ 升级 PR 门禁全绿后合并；④ 确认 `state.retiredManagedForks` 与仓内文件一一对应。

### 10.4 仓级扩展路径全链路（2026-09-30 新增，解除 workloom 波次暂停）

**问题**：§10.3 的分叉容差只对 `lane: experiment` 生效。但 **产品分叉仓**（如 workloom：
2026-09-29 按产品所有者指令把整树复刻为 `WorkLoom-growth@2edea37`，客户端成为"三端壳之上的产品层"）
同样需要它——否则升级会 fail closed（workloom 实测 85 冲突：`MANAGED_FILE_MODIFIED` 19 /
`MANAGED_FILE_DELETED` 6 / `UNTRACKED_MANAGED_FILE` 40 / `ILLEGAL_INDUSTRY_APP_PATH` 20），
而"整包覆盖"又等于替换产品 UI。

**决策（产品所有者指令：完成 loop/客户端收尾）**：把分叉容差从"实验车道专用"升级为
**仓级显式声明**，即「仓级扩展路径全链路」。能力与代价与 §10.3 相同，差别在**适用面与登记要求**：

| 项 | 规则 |
|---|---|
| 生效范围 | `lane: experiment`（§10.3）**或** 在 `sync/child-repos.json` 显式声明 `children[].tolerateExtensionSnapshotOverlap = true` 的产品分叉仓（T-2026-0930-0003 起） |
| 登记要求 | 必须同时给出原因（`clientForkReason` 或 `rolloutResumeNote`，≥20 字，写明产品分叉的事实依据）与非空 `industryExtensionPaths`；该容差与 `uiRolloutWave: paused` 互斥（二选一） |
| 采纳基座版 | 可选 `adoptBaseClientPaths`（同样只允许 `apps/` 前缀、不含 `..`，且不得与扩展路径重叠）：这些路径"既有指纹不可信但不是本仓定制"，升级时**按稳定快照覆盖/重建**——例如 `apps/*/package.json`（必须由基座通道写入 `@workloom/ui` 版本与 lock 完整性）与纯文案代差的页面 |
| 退管留痕 | 与 §10.3 相同：路径从新 state 的 `managedFiles` 移除，记入 `state.retiredManagedForks`（含退管版本与原因），从此不接收基座更新 |
| 单一事实源 | 仍然只认 `sync/child-repos.json`；仓内 `.workloom-client-extensions.json` 仅供本仓自包含门禁参考，不参与 rollout 判定（仓内私改会在下一次 rollout fail closed） |
| 门禁 | `validateChildInventory` 逐条失败闭合（缺理由 / 空扩展路径 / paused 冲突 / 非法路径 / 未开容差却给 adopt 路径）；引擎 `planClientFoundation` 对"扩展路径与采纳路径重叠"抛错 |

**两个实测坑（照抄清单时必看）**：
1. `apps/*/package.json` **不能**放进 `industryExtensionPaths`：扩展路径会被从稳定快照里过滤掉，而
   `materializeUiVersion` 必须读它来写 `@workloom/ui` 版本 → 直接报 `客户端基座缺少 package.json`（硬错）。
2. 它也不能不声明：0.1.1 时代的旧 state 没登记过它，内容又与快照不同 → `UNTRACKED_MANAGED_FILE` 卡死。
   **唯一正解**是上面第 3 行那类「采纳基座版」声明（覆盖它、同时保留 `setUiVersion` 通道）。
   同理，宽口径如 `apps/webb/src/**` 会把必需入口 `apps/webb/src/main.tsx` 过滤掉（`稳定客户端基座缺少真实生产入口`），要用具体文件/子目录。

**首发适用**：`workloom` 24 条扩展路径 + 2 条采纳基座版路径（三端 `package.json`、`apps/webb/src/Auth.tsx`）→
`ready=true`（退管 71 条、更新 5 文件 + 新建 `styles/subtitle.css`）；`WorkLoom-growth` 39 条扩展路径 +
1 条采纳基座版路径（三端 `package.json`）→ `ready=true`（退管 71 条、更新 4 文件 + 新建 `styles/subtitle.css`）。
两仓的声明都可用 `work/tools/simulate-workloom-plan.mjs` 只读复现。
恢复/回滚：删除 `tolerateExtensionSnapshotOverlap`/`adoptBaseClientPaths`（必要时保留 `industryExtensionPaths`）、
`uiRolloutWave` 改回 `paused` 并补 `rolloutPauseNote`，即可回到"挂起"状态。

**UI 消费契约在分叉仓的边界（2026-09-30 补，T-2026-0929-0001 follow-up）**：`UI_CONSUMER_CONTRACT_FAILED`
（中文边界 / 动态值映射 / 文字出口 / 共享组件渲染等）只约束**基座受管面**。对已声明分叉容差的仓，
这些发现降级为 `advisories`（保留在 preflight 报告里可查、可另立产品迁移任务卡），**不再阻断波次推进**——
否则 `targetVersionApplied` 永远为 false，会把 W3B 之后的整条波次链永久卡死（workloom / growth 实测各 207 项）。
非分叉仓不受影响，仍是硬门禁；回滚即删除该降级逻辑。

## 11. 隔离副本车道（isolated：双向不同步，2026-09-22 新增）

**背景**：`workloom-growthtest`（AI超增长·实验版）与 `workloom-growthmatrix`（骇客帝国·实验版）是 2026-09-21 从
`WorkLoom-growth@a6dc89a` 完整复制出来的**激进改造实验副本**，内容暂时与基座拆分：基座内容不直接同步进这两仓，
这两仓的内容也不直接回流基座（产品所有者 2026-09-22 明确指令）。

**与 §10 实验车道的区别**：实验车道仍在同步队列内（拿基座资产、只是实验路径受护栏保护）；隔离副本**完全不在同步队列内**，
既不收也不发。因此二者用不同登记位：

| 车道 | 登记位 | 是否收基座资产 | 是否回流基座 | 纳管/门禁 |
|---|---|---|---|---|
| 实验车道（fox / growth） | `children[].lane = experiment` | 收（实验路径受白名单保护） | 不回流（需提案） | 纳管（10 标签 + 门禁） |
| 隔离副本（growthtest / growthmatrix） | `isolatedRepos[]`（顶层） | **不收** | **不回流** | **不纳管**：扫描跳过、不建扫描卡/纳管 PR、不新增/修改分支保护 |

上表表示默认舰队扫描、纳管和分发行为。2026-10-07 产品所有者点名授权十二项目各自安装并发研发机制，两隔离副本已在各自仓内完成准确 Codex review/实测、普通集成、研发分支保护和原生执行回读；这一单次本仓授权未解除 `none-in-none-out`、未加入 `children`/业务 fanout，也未覆盖冻结全景文档。后续本仓例外仍按明确任务范围单独审查，不能以已装交付器为由下发基座业务资产或回流实验语义。

**机器可读事实源**（`sync/child-repos.json`）：

```json
{
  "repo": "workloom-ai/workloom-growthtest",
  "lane": "isolated",
  "syncPolicy": "none-in-none-out",
  "copiedFrom": "workloom-ai/WorkLoom-growth@a6dc89a",
  "isolatedSince": "2026-09-21",
  "declaredBy": "product-owner",
  "declaredAt": "2026-09-22",
  "note": "为什么隔离 / 解除条件"
}
```

**四条硬规则**：

1. **不进 children**：隔离仓一旦出现在 `children` 里，fanout 会把基座内容推过去；`experiment-guard --check` 会报 `ISOLATED_IN_CHILDREN` 并在基座门禁判红；
2. **不纳管**：`fleet-scan.mjs` 把隔离仓从「新发现 WorkLoom 仓」里剔除（只单列报告）；`provision-protocol.mjs` 默认拒绝为隔离仓建纳管 PR，确需恢复必须由产品所有者明确指令 + 显式传 `--allow-isolated`；
3. **不下发**：`sync/fanout-cnb.mjs` 读取 `isolatedRepos` 并在入口过滤——即使隔离仓被误写进 `children` 也拦下（宁可少同步一个仓，也不把基座内容推给隔离副本）；
4. **不回流**：隔离副本的改造不进入基座、不下发给任何其他仓；其中的通用能力若要公共化，必须另开提案任务卡，按 L2→L1→L0 重新实现与评审。

**解除隔离（回到受控舰队）时的动作**：产品所有者明确指令 → 另开纳管任务卡 → 从 `isolatedRepos` 移除并写入 `children`
（含 `lane` / 波次 / `extraExclude`）→ 跑 `provision-protocol.mjs --allow-isolated` 补齐协议资产与门禁 → 由 fanout 纳入正常波次。
在收到显式指令前，不得以"顺手对齐"为名向这两仓推送任何基座资产。

## 9. 舰队维护与自动化（2026-09-18 新增）

### 9.1 持续执行与人机边界

| 环节 | 执行方式 |
|---|---|
| 原 PR 检查 | 保留各仓原有必需流水线；原配置不能删除/改弱 trusted main 的检查阶段 |
| 会话审查与候选检查 | 当前 Codex 使用自带模型精读并实测，handoff 保存准确 source/main/policy/完整范围及测试结果；候选重新跑原仓 CI。target/API 事件只核对记录，不调用模型 |
| 集成恢复 | `scripts/delivery/cnb.yml` 的目标分支事件与 5 分钟 reconcile cron；与 fanout 独立。旧 `merge-sync-prs.mjs` 只派发，不直接合并 |
| 发布与回执 | 声明 UI/桌面发布时另排队；成功回读标签源码和资产摘要后才能完成相应任务 |
| 资产分发 | 现有 fanout 继续创建受控同步 PR；`.cnb.yml` 只追加交付 include，不覆盖行业流水线/页面/种子。隔离副本排除 |
| 人的职责 | 需求方向、真实经营动作的单独授权、叫停与新 revert PR 回滚；正常研发不等待逐 PR 点击批准 |

当前 Codex 的实际 review/测试记录与原仓必需状态检查必须同时成立。首装先核验安装清单完整闭包、准确 Git/文件字节和强保护账本，完成会话记录与确定性 bootstrap/原仓 CI，再关闭额外人工评审计数及管理员批准；保留强制 PR、状态检查、禁直推/强推/删除等保护。普通 merge 回读准确双亲，当前 main 再 activate 回读记录、资产、保护及准备证明。记录缺失、源码/主干/正文/依赖漂移或 CI 未过即停止；禁止伪造批准、force 或把配置存在当作已上线。

### 9.4 同步 PR

所有同步 PR 与普通代码使用同一 Codex 会话 review/实测、原仓检查和不可修改候选通道，不存在免审白名单。治理资产可自动交付，但必须完整会话审查；含运行时代码时运行相应仓必需测试。源分支保留，只有准确源码已合入才关闭原 PR。不能把“已开同步 PR”写成“已下发完成”。

### 9.5 开发交接契约

PR 正文可附：

```html
<!-- workloom-delivery
{"task_id":"T-2026-1005-1001","ready":true,"depends_on":[],"releases":[]}
-->
```

`ready:false` 保持开发态；WIP 始终不合。旧 PR 未声明 ready 或缺实际会话回执时保持等待；冷却时间不能代替 review、测试或显式交接。发布可声明 `{"kind":"ui","version":"1.2.3"}` 或 desktop；制品构建/签名环境未就绪会留下发布欠项，不生成虚假成功回执。两项声明按各自版本和环境验证。

会话回执使用 schemaVersion=1、provider=codex，保存 repo、number、headSha、mainSha、policyHash、reviewedFiles、reviewedAt、summary、dependsOn、ciPolicyChanges，以及 tests 的真实 command/exitCode/finishedAt/result。每个 CI 变化必须对应当前快照的准确 id 和解释。保存后计算内容摘要；篡改或 tuple 漂移不能复用。会话回执是可信开发者的实际审查声明与一致性证据，并非平台签名身份或平台 AI 批准。CLI 只校验记录，不调用 Codex API 或外部模型；当前会话必须先真正读代码和跑测试，再生成记录。

首次安装记录还绑定当前 PR 正文、ready 和真实依赖。首装替代 PR 只可转移同一固定源码/主干、同一实测和完整范围的记录，保存原记录 id 与来源 PR；再次跑原仓 CI后才普通合并。

### 9.2 工具用法

```bash
# 任务卡：建卡（自动分配 T-YYYY-MMDD-XXXX，打 t/draft）
node scripts/tools/task.mjs new --repo workloom-ai/workloom-hotel --title "修复差评 SLA" \
  --q1 industry --q3 workloom-hotel --q4 "单测+打包门禁；回滚=revert"
# 任务卡：回执 + 关单
node scripts/tools/task.mjs receipt --repo workloom-ai/workloom-hotel --id T-2026-0919-0001 \
  --progress "..." --decisions "..." --next "..." --pr 123 --close

# 舰队扫描：列出组织内所有 WorkLoom 仓，标出未纳管的新仓
node scripts/tools/fleet-scan.mjs                 # 人读报告
node scripts/tools/fleet-scan.mjs --json          # 机器可读
node scripts/tools/fleet-scan.mjs --check         # 有新仓则退出码 1（可做门禁）
node scripts/tools/fleet-scan.mjs --issue --provision   # 开扫描卡 + 自动纳管（cron 用的就是这条）

# 单仓纳管（幂等）：标签 + 分支保护 + 协议资产 + 门禁 stage + PR
node scripts/tools/provision-protocol.mjs --repo workloom-ai/<name> [--dry-run]
# 隔离副本护栏：实验路径 + 隔离登记（含"隔离仓误入 children"检查）
node scripts/tools/experiment-guard.mjs [--check]
```

纳管判定规则（`scripts/tools/fleet-rules.mjs`）：仓库根 `product.manifest.json` 的 `schemaVersion` 以 `workloom.product/` 开头 → WorkLoom 仓；缺失时退化为 `.workloom-base-sync.json` 或 `bundles/*/bundle.json` 的 schema 标记。已纳管集合 = 基座仓 + `sync/child-repos.json` 的 children + `isolatedRepos`（隔离副本计入"已知"，但永不进入纳管/分发通道）。

### 9.3 新仓纳管后的三件事（自动创建 PR，Codex 会话审查实测后交付）

1. 标签体系（10 个）+ `main` 分支保护（强制 PR + 必需状态检查 + 禁强推/删除）；
2. 协议/交付器完整依赖副本 + `.cnb.yml` 追加协议门禁与 trusted-main delivery include；
3. 本仓写入 `sync/child-repos.json`（舰队清单），后续 base-sync 波次照常覆盖。

> 注意：新仓若与既有仓同 `productId`（例如 `WorkLoom-growth` 与 `workloom` 都是 `workloom-ai-acquisition`），说明它是同一产品的第二实例或副本——纳管只保证协议一致，**产品身份（productId/端口/演示工作区）需要人确认后统一**。

> 补充（2026-09-22）：若新仓是**有意与基座拆分的隔离副本**（如 growthtest / growthmatrix），不要纳管——按 §11 写入 `isolatedRepos` 并保持双向不同步；只有产品所有者明确要求回到受控舰队时才重新纳管。

## 8. 落地检查（每周一次，1 分钟）

- 进行中的对话是否都有任务卡？（应 100%）
- 是否存在无 owner/generation 或等待 CI 仍续租的敏感开发占用？（应 0）；普通文件重叠仅为协作提示
- 是否有门禁全绿却超过 24h 未合并的 PR？（应 0——由仓级交付器按 §1/§9.5 审查和集成，或已在 Issue 说明阻塞原因）
- `risk/review` 的正常研发 PR 是否有完整 Codex review/实测与 CI 回执并继续交付（不等待人工点击）？（应「是」）
- 合并是否严格串行？（应「是」）

## 12. 交付排雷机制（MCD v1.0，2026-09-29 新增）

**定位**：本协议解决"别撞车、可交接、门禁全绿"；MCD 解决"问题是否被系统性挖出、修复是否真有断言兜底、验收是否独立"。两者叠加使用，不新造并行流程。

**触发（调用声明）**：命中「排雷 / 排雷式交付 / 系统性排查 / 交付前排查 / 交付体检 / 挖问题 / 问题台账 / 修复排期 / 假修复 / 联动地雷 / MCD / mine-clear」任一意图 → 先读 `docs/MINE-CLEAR-DELIVERY-SPEC.md`，再用 `node scripts/delivery/mine-clear.mjs` 建台账。"独立验收 / 上线前验收"仍走 RDAS v3.1（§6 最低验证标准）。

**五条硬约束**（与 §1 五条硬规则同级）：

1. **一轮排雷/修复 = 一张任务卡 + 一条 `task/T-…` 分支**；台账落 `outputs/mine-clear/<任务号>/`，`ledger.json` 必须随 PR 提交（证据文件可按体量决定是否入库，但断言输出路径必须可追溯）；
2. **无证据不上账**：问题卡必须有 `文件:行号@commit` 与触发路径；断言必须可运行——`node scripts/delivery/mine-clear.mjs gate --ledger <台账>` 是硬闸，判红不得交付；
3. **修复者不自验**：`verified_by ≠ fixed_by`（独立会话/角色），无法满足时必须写 `waiver.reason` 与批准来源；
4. **P0（突破核心不变量 / 安全）未闭环** → 不得进入 RDAS 验收，不得并入发布分支；
5. **M6 交接**必须用 `mine-clear.mjs handoff`（未闭环项逐条给回归路径），验收结论只许三档：完全通过 / 有条件通过 / 不通过。

**风险分级**：MCD 本体是规范 + 台账 schema/模板 + 本地编排脚本（`scripts/delivery/**`），不改产品运行时；一旦排雷结论落到运行时代码改动，按 §3 目录围栏照常判 `auto / review / block`，正常治理代码使用当前 Codex 会话 review/实测；真实经营/不可逆动作仍需单独明确授权。
