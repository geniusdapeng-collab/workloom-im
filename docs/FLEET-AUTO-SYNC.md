# 舰队自动更新机制（本地 + 云端）

> 适用：基座 `workloom-im` 与 `sync/child-repos.json#children` 里的全部子仓（含实验车道 fox / growth）。
> **不适用**：`sync/child-repos.json#isolatedRepos` 登记的隔离副本（`workloom-growthtest` / `workloom-growthmatrix`）——
> 它们双向不同步（基座不下发、本仓不回流），扫描 / 纳管 / fanout 一律跳过，规则见 `docs/DEVELOPMENT-PROTOCOL.md` §11。
> 事实源：`sync/child-repos.json`（订阅关系）、`sync/base-scope.json`（同步边界）、本文件（机制说明）。
> 落点：2026-09-19 起，云端“基座 → 子仓”的资产分发不再依赖人工开 PR；所有正常研发资产使用独立 AI 审查和仓级持续交付器集成，不等待用户逐 PR 点击批准。本地舰队镜像每日尝试跟随。

## 0. 一页速览

| 层 | 做什么 | 载体 | 触发 | 人工介入 |
|---|---|---|---|---|
| 云端 · 资产分发 | 根级资产 → 子仓 `sync/base-*` PR；保留行业配置 | `sync/fanout-cnb.mjs` | 每 30 分钟 cron / API | 正常研发无需逐 PR 人审 |
| 云端 · 持续交付 | 完整 AI、必需检查、不可修改候选、准确集成和发布回执 | 各仓 `scripts/delivery/cnb.yml` | 目标分支事件 + 每 5 分钟 reconcile | 人保留叫停/回滚权 |
| 云端 · 新仓纳管 | 扫描组织发现新 WorkLoom 仓 → 开扫描任务卡 + 纳管 PR（标签/分支保护/协议资产/门禁 stage）；隔离副本只单列报告、不纳管 | `scripts/tools/fleet-scan.mjs --issue --provision` | 每日 09:00（Asia/Shanghai）cron | 授权首装端完成真实 AI、原仓门禁、合并与激活 |
| 云端 · 代码基线 | `packages/**`、`apps/**` 等运行时代码升级 | `sync/base-sync.mjs push` / fanout `--mode full` | AI/API 触发（默认不跑；升级批次由任务卡驱动） | AI 合并（门禁全绿 + 冷却期，协议 §1/§9.5） |
| 本地 · 文档副本 | 全景认知 + 开发协议落到 `~/.codex/workloom-context/`，供 WorkLoom 会话直接引用 | `~/.codex/skills/workloom-context/scripts/sync-context.sh` | Codex automation `workloom`（每日 09:00）+ 手动 | 无需 |
| 本地 · 代码克隆 | `~/WorkLoom-fleet/` 十个订阅仓 + 两个隔离副本都跟随各自云端 `main`；新订阅仓自动克隆 | `~/.codex/skills/workloom-context/scripts/sync-fleet-local.sh` | 同上 | 无需（脏树自动跳过） |
| 本地 · 云端兜底 | 用本机令牌触发云端 fanout 流水线（跨仓开关未开时的替代通道） | `~/.codex/skills/workloom-context/scripts/fleet-cloud-sync.sh` | 手动 / automation | 无需 |

## 1. 云端资产分发（fanout）

### 1.1 它解决什么

基座改动后，九个子仓（八个行业仓 + 实验车道 growth）必须拿到**同一份**全景认知、开发协议与 AGENTS 受控区块，同时不得覆盖行业语义。
人工逐仓开 PR 的时代（2026-09-19 之前：一轮 9 个 PR，全靠会话手工创建）已经结束；含治理资产的 PR 同样进入逐仓完整独立 AI 审查：

```bash
# 基座仓内（CI 或本地干净克隆）
node sync/fanout-cnb.mjs --mode required-only            # 只处理根级受控资产
node sync/merge-sync-prs.mjs                             # 派发仓内 trusted-main reconcile；不直接合并
```

### 1.2 幂等与“不打扰”规则

1. **先比对，再克隆**：脚本用 CNB API 读子仓 `main` 上的 `.workloom-base-sync.json`，把它记录的
   `requiredRootAssetsSha256` 与基座当前资产摘要逐项比对；只有真漂移的子仓才会被 `git clone`。
   → 舰队巡检可以在流水线里每 30 分钟跑一次，绝大多数轮次只花几次 API 调用。
2. **资产摘要为准，不以基座 sha 为准**：基座只改代码、没动根级资产时，`required-only` 模式不产生任何 PR
   （避免“每天 9 条空 PR”噪声）。`--mode full` 才比较 `lastSyncedBaseSha`。
3. **在途去重**：子仓已存在 `sync/base-*` 的 open PR 时跳过，不重复开门。
4. **分支名 = 内容指纹**：`sync/base-<基座sha8>[-full]`；同名分支已存在（例如 PR 被关掉后）时不强推、不覆盖，
   只报告，避免任何形式的强制推送。
5. **隔离副本不参与**：`isolatedRepos` 里的仓即使被误写进 `children`，也会在 fanout 入口被过滤（报告 `skippedIsolated`），
   不 clone、不推送、不开 PR。

### 1.3 正常研发交付（协议 v2 §9.4/§9.5）

`sync/merge-sync-prs.mjs` 是兼容派发入口，不直接写主干。各仓 trusted main 执行器具有同一 CNB 原生合并锁和 Git CAS 状态；fanout 失败不能跳过该仓恢复/集成。

原 PR 非 WIP、未 `risk/block`、已交接或满足旧 PR 冷却期、真实前置依赖完成、源码含当前 main、原仓必需 CI 通过后，建立 `delivery/candidate/**` 不可修改候选。候选再次运行必需 CI 和真实 CodeBuddy 审查；完整文件清单、source/main/policy、NPC Approve 与准确双亲合并回执都必须满足。`AGENTS.md`、协议、sync、CI、迁移等正常研发治理代码不再因路径永久等待用户点击审批；真实业务/秘密/实盘仍受独立授权约束。

“开了 PR”“准备了候选”“发起了构建”都不是已完成。只有对应准确源码已真实合入，才关闭原 PR；开发者追加新提交则保留原 PR 继续交付。所声明安装包/制品须另完成标签与实际字节验证。主干变化时普通 merge 到原开发分支并重跑检查；自动冲突修复有预算，保留所有原代码和分支，失败只停相关任务。

### 1.3.1 安装边界

公共交付器及锁定的解析器运行时由 `sync/base-scope.json#requiredRootAssets` 送到 **Git 根目录**；Tiger 的 `governance/` 前缀不能改变它的位置。各仓 `.cnb.yml` 只追加 `scripts/delivery/cnb.yml` include，保留原语言栈/阶段/行业种子。CI 凭据来自 CNB 原生注入；一次性的候选/状态保护规则安装与策略激活需有仓库设置权限的当前任务授权，不把用户会话令牌存入 CI。

产品所有者于 2026-10-05 明确要求十二仓独立安装研发交付机制；两个隔离副本可在各自仓建立安装 PR、保护和账本，业务 fanout 仍然跳过它们，冻结认知/上游摘要与 none-in-none-out 不变。Andromeda 的 platform-ops 不分发到其他仓。是否已激活以 `automation/delivery-state` 的 activation 事件及平台回读为准。

### 1.3.2 既有仓的首装顺序（不能把文件分发当作启用）

`base-sync` 只分发执行资产，**不会自动改子仓 `.cnb.yml`**。旧仓拿到脚本而没有 delivery include 时，`merge-sync-prs` 的派发会明确失败；这代表尚未安装，不能当作交付器已接管。首次舰队上线由具备仓库设置权限的授权安装端逐仓执行以下闭环，然后再把该仓纳入正常派发：

分发的新锁门禁也不单靠文件存在启用：main 无 delivery include、控制分支确实不存在时，继续执行旧敏感重叠约束，避免脚本先到而首装准备未完成造成自锁。main 已显式启用后，账本缺失或损坏、权限/网络失败保持红灯。安装 prepare 同时留下准确 source/main 的敏感接纳证明；后续 trusted-main admission 自动领取并释放 generation，CI 要求正向历史回执，不能把空租约集当成已许可。

1. 在目标当前 main 的独立 `chore/protocol-onboarding-*` 分支准备完整 delivery/CI 依赖闭包，追加 `scripts/delivery/cnb.yml` 与 `scripts/delivery/bootstrap-cnb.yml` include，保留原流水线、阶段、行业配置及隔离状态；开准确路径、四问、验收和回滚任务卡/安装 PR。只对共享研发资产升级，不用全量旧纳管器清理目标标签。
2. 推送准确安装源码后，设置权限者在该源码工作树执行 `node scripts/delivery/queue-runner.mjs prepare-install --repo <org/repo> --pr <安装PR>`。此步骤创建并回读强保护状态分支、保存准确 source/main 的 installation_prepared；源 PR 原生令牌仅回读，bootstrap 的 verify-install 缺该证据就拒绝 AI 批准。
3. 安装 PR 必须通过**目标仓全部原必需检查及真实 bootstrap AI**。回读完整覆盖与准确 source/main、当前独立 CodeBuddy Approve，才按平台保护普通 merge；不强制合并、不直推 main，不用本地通过替代云端通过。
4. 在合入后的目标当前 main 执行 `node scripts/delivery/queue-runner.mjs activate --repo <org/repo> --pr <安装PR>`：验证合并、原准确测试双亲和独立 AI，安装不可修改候选规则、保留 main 强保护/自有 NPC 自批限制、取消额外管理员批准并写 activation。再回读每五分钟原生流水线的实际状态写入，才记录该仓已接管。
5. 未完成此闭环的仓保持“安装中”，继续保留原 PR/分支及明确欠项；不恢复旧的第二条直接 merge 车道。安装完成的仓独立开始恢复，不等待全部仓同时就绪。两个隔离副本按本次明确授权各自安装，不加入业务分发队列。

后续新仓也须先完成同一首装闭环；原生 CI 令牌只有仓库设置读权限，不能用它伪装首次保护安装成功。缺设置写权限时由当前任务授权的持续安装端负责，不将会话令牌保存为 CI 变量或文件。

### 1.3.3 账本读取的 CNB 实测证据

2026-10-05 在 `workloom-ai/workloom-im` 使用当前任务授权身份实测 `GET /-/git/raw/automation%2Fdelivery-state/state.json`，平台返回 HTTP 200，JSON 为 schemaVersion=1、repo=workloom-ai/workloom-im、revision=128。这里 `%2F` 是分支名斜杠的标准 URL 编码，真实服务已按完整 `automation/delivery-state` 分支处理；该结论来自线上回读，不是离线夹具推断。随后 `GET /-/git/branches/automation%2Fdelivery-state` 返回 protected=true、提交 `22195d4ae662a6625ea83e6d002d4afa89bcca60`（账本已推进到 revision=134）；同一提交的 `GET /-/git/raw/22195d4ae662a6625ea83e6d002d4afa89bcca60/state.json` 用于核对准确版本。

fanout 只在读取结果通过完整身份与历史哈希链验证，且存在 installation_prepared 或 activated 后报告 ready。明确 404 是待首装；403、服务错误、网络异常和损坏账本不会被当作已就绪。若未来平台改变该 ref 路由，先通过已验证的分支查询解析提交 SHA，再读取该 SHA 的 state.json，并以同样的状态校验和门禁回归后发布。

### 1.4 权限模型（谁给谁开权限）

| 通道 | 令牌 | 能力 | 备注 |
|---|---|---|---|
| 定时任务（每 30 分钟） | 触发者（最后改 crontab 的人）的 `CNB_TOKEN` | **默认仅当前仓** | 需要根组织管理员在「组织设置 → 仓库管控」勾选**允许定时任务跨仓操作**，令牌才升级为“根组织范围” |
| API 触发 `api_trigger_base_sync` | 调用者令牌（例如个人访问令牌，按 `AGENTS.md` §7 会话内注入、不落盘） | 调用者本身的权限 | 本地兜底脚本 `fleet-cloud-sync.sh` 走这条；不依赖组织开关 |
| 子仓 PR 门禁 | 子仓自己的 `CNB_TOKEN` | 当前仓 | 子仓流水线不申请任何跨仓权限 |

未开组织开关时，cron 会以 `🔒 权限不足` 告警收尾并**保持绿**（`--tolerate-scope-error`），
不会每半小时刷一次红灯；此时云端自动更新改由「API 触发」或本地兜底脚本承担。

### 1.5 失败模式与处置

| 现象 | 根因 | 处置 |
|---|---|---|
| `🔒 权限不足` | 定时任务跨仓开关未开 | 开组织开关；或改用 API 触发 / 本地兜底 |
| `CNB 429 Too many requests` | 舰队级巡检触发限流 | 已在 `scripts/tools/cnb-api.mjs` 内置指数退避重试（尊重 `Retry-After`），无需人工 |
| 子仓 PR 门禁红 | 代码漂移、行业化改动冲突 | 交付器仅停相关 PR；对齐主干并按预算派发 CodeBuddy 工作模式修复，独立审查与检查通过后继续 |
| 子仓 PR 门禁绿但停在队列 | PR 含 `sync/**`、`AGENTS.md`、协议、验收执行器或工作流等治理资产 | 查看仓级 state 的实际 AI/CI/依赖原因；正常研发不等待人工批准，权限/未安装/审查失败保留真实欠项 |
| `verify-lock-conflict` 拒绝 | 同仓另有 open PR 改了同一路径（例如 `.workloom-base-sync.json`） | 普通文件重叠只提示；有效敏感开发租约等待 TTL/交接释放，源码主干落后则对齐，不为解锁删除在途 PR |
| 子仓 state 显示“已漂移”但无内容变更 | 基座 sha 变了、资产没变 | `required-only` 不产生 PR，属预期 |

## 2. 云端新仓纳管

`scripts/tools/fleet-scan.mjs` 每天 09:00（Asia/Shanghai）扫描 `workloom-ai` 组织：

- 仓库根存在 `product.manifest.json#schemaVersion = workloom.product/*` → 判为 WorkLoom 仓；
  否则退化看 `.workloom-base-sync.json` / `bundles/*/bundle.json`；
- 单仓权限、网络或内容读取失败单列为未核实，继续检查其余仓；失败仓不会被归为非 WorkLoom，也不参与新仓纳管。隔离登记表缺失、不可读或结构无效时整次纳管判断保持失败闭合；
- 已纳管集合 = 基座 + `sync/child-repos.json#children`；差集里的新仓会被
  `--issue`（开 `src/auto` 扫描任务卡）与 `--provision`（建立标签/分支保护/协议资产/门禁 stage 并开纳管 PR）覆盖；
- 实验车道新仓要按协议 §10.1 在清单里补 `lane/experimentNote/experimentPaths/industryExtensionPaths`，
  否则 `experiment-guard.mjs --check` 会在基座门禁里报警；
- 有意与基座拆分的**隔离副本**按协议 §11 写入顶层 `isolatedRepos`（`syncPolicy: none-in-none-out` + `note` + `isolatedSince`）：
  `fleet-scan` 把它计入"已知"并单列报告，`--issue` / `--provision` 一律跳过；`provision-protocol.mjs` 默认拒绝为它建纳管 PR；
  隔离仓若混进 `children`，`experiment-guard --check` 报 `ISOLATED_IN_CHILDREN` 并在基座门禁判红。

纳管 PR 合并后，新仓在下一次 fanout 巡检（≤30 分钟）自动进入资产分发，并在本地 `sync-fleet-local.sh`
下一次运行时自动克隆到 `~/WorkLoom-fleet/`。

## 3. 本地副本

```bash
# 文档副本（全景认知 + 开发协议）→ ~/.codex/workloom-context/
sh ~/.codex/skills/workloom-context/scripts/sync-context.sh          # 同步
sh ~/.codex/skills/workloom-context/scripts/sync-context.sh --check  # 只判断是否过期（退出码 3=过期）

# 十个订阅仓 + 两个隔离副本 → ~/WorkLoom-fleet/（新仓自动 clone；脏树跳过，不覆盖任何本地改动）
sh ~/.codex/skills/workloom-context/scripts/sync-fleet-local.sh [--quiet]

# 云端兜底：用本机令牌触发 fanout 流水线（等云端跑完再返回）
sh ~/.codex/skills/workloom-context/scripts/fleet-cloud-sync.sh [--mode required-only|full] [--dry-run]
```

Codex automation `workloom`（每日 09:00）按顺序跑前两条，**无变化不通知**。

## 4. 人的角色：方向、单独业务授权与叫停

正常研发由真实 AI 审查和必需 CI 自动推进，人保留叫停与通过新 revert PR 回滚的权利；`risk/block` 不交付。资金、实盘、生产秘密、客户数据外发与不可逆经营动作仍需单独明确授权。所有研发路径都有审查，不能伪造批准、force 合并或关闭未完成任务来解除阻塞。

## 5. 验证与排障命令

```bash
node --test scripts/delivery/queue.test.mjs sync/fanout-rules.test.mjs sync/merge-sync-prs.test.mjs # 队列/租约/CAS/派发/漂移断言
node sync/fanout-cnb.mjs --dry-run --json                     # 只报告：谁漂移、谁在途、谁对齐
node sync/fanout-cnb.mjs --only workloom-ai/workroom-tiger    # 只处理单仓
node sync/merge-sync-prs.mjs --dry-run --json                 # 只报告已安装仓级执行器
node scripts/delivery/queue-runner.mjs reconcile --dry-run --repo workloom-ai/workloom-im
```

CI 内可手动触发同一流水线（`BASE_SYNC_DRY_RUN=1` 只报告不落地）：

```bash
curl -X POST -H "Authorization: Bearer $CNB_TOKEN" -H 'Content-Type: application/json' \
  -d '{"branch":"main","event":"api_trigger_base_sync","env":{"BASE_SYNC_DRY_RUN":"1"}}' \
  https://api.cnb.cool/workloom-ai/workloom-im/-/build/start
```

## 6. 回滚

- 停止该仓自动交付：通过经审查的 PR 停用 `scripts/delivery/cnb.yml` 的 reconcile 触发；未知合并写先回读，保留 state 与原分支，不删除证据。保留 main 强保护。
- 关掉 fanout：删除 `api_trigger_base_sync` 与 30 分钟 cron 两条；
- 单仓豁免（仍属订阅、只是少同步某些文件）：在 `sync/child-repos.json` 该仓条目里加 `extraExclude`，或临时关闭该仓在途 PR（fanout 见在途 PR 即跳过）；
- 单仓隔离（完全不收不发，如 growthtest / growthmatrix）：把该仓从 `children` 移到顶层 `isolatedRepos`（协议 §11），fanout / 扫描 / 纳管会同时跳过；
- 全部回滚：`git revert` 引入 fanout 的提交；已合并的文档同步可用子仓 `git revert` 回退（纯文本，无副作用）。
