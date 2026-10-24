# 排雷式交付执行器（scripts/delivery/**）

> 规范：`docs/MINE-CLEAR-DELIVERY-SPEC.md`（mcd/v1.0）｜台账 schema：`docs/mine-clear/ledger.schema.json`｜报告模板：`docs/mine-clear/report-template.md`｜投喂模板：`docs/mine-clear/prompt-pack.md`
> 本目录随基座 base-sync 分发到各仓（`sync/base-scope.json#requiredRootAssets`）；**行业差异不要改这里的代码**。

## GitHub 默认交付入口（2026-10-24）

地址/车道来自 `sync/repository-registry.json`，精确部署策略由 `.workloom-delivery.json` 表达。`github.mjs` 不运行模型；当前 Codex 会话先完成真实 review 和实际测试，再保存 `workloom.codex-review/v1` JSON，字段包括 repository、headSha、baseSha、policySha256、完整 files，review 的 actor/status/evidenceSha256，及 tests 的 command/status/evidenceSha256。policySha256 按 `JSON.stringify(deliveryConfiguration())` 的 SHA-256 计算。证据必须是真实日志与审查内容的摘要，示例值不能用于真实交付。

```bash
node scripts/delivery/github.mjs inspect --logical-id workloom-hotel --pr PR_NUMBER --head HEAD_SHA --base MAIN_SHA --review ACTUAL_REVIEW_JSON
node scripts/delivery/github.mjs merge --logical-id workloom-hotel --pr PR_NUMBER --head HEAD_SHA --base MAIN_SHA --review ACTUAL_REVIEW_JSON --output MAIN_INTEGRATION_JSON
node scripts/delivery/github.mjs mirror-plan --logical-id workloom-hotel --integration MAIN_INTEGRATION_JSON
```

所有现存 status/check-run 及保护规则仍需通过，风险阻断/WIP/未审文件拒绝合并。操作只接受注册 GitHub 地址、精确 source/main 和普通 merge；成功后回读合并双亲、main 与 tree。GitHub REST 对 head 提供比较条件，base 若在窗口内变化，后验会拒绝 verified 并显式指出合并已经发生，不能假装没有副作用。CLI 不提供 force、平台规则 bypass 或替代模型审核。

CNB mirror-plan 只生成独立延迟状态；不存在 CNB 地址时记录 not-configured，不自动建仓。legacy queue-*.mjs 及 cnb.yml 继续描述 CNB 原生执行器；它们不是 GitHub 的隐式后备，不能据本地 registry 标记推断云端分布式队列已经部署。MCD 命令与下列证据门禁不变。

## 触发

命中以下任一意图即启用本机制（规范 §0）：**排雷 / 排雷式交付 / 系统性排查 / 交付前排查 / 交付体检 / 挖问题 / 问题台账 / 修复排期 / 假修复 / 联动地雷 / MCD / mine-clear**。
"独立验收 / 上线前验收"由 RDAS v3.1（`docs/REAL-DEVICE-ACCEPTANCE-SPEC.md`）承担，本机制负责把验收需要的台账与交接单准备好。

## 命令

```bash
# 1) 记录审计基线 + 建台账（输出 outputs/mine-clear/<任务号>/）
node scripts/delivery/mine-clear.mjs init --repo . --task T-2026-0929-0004 --env local-preview
node scripts/delivery/mine-clear.mjs invariants --ledger outputs/mine-clear/T-2026-0929-0004/ledger.json

# 2) 上账（问题卡 / 修复卡）
node scripts/delivery/mine-clear.mjs card-template --kind problem > outputs/mine-clear/T-2026-0929-0004/card.json
node scripts/delivery/mine-clear.mjs add --ledger <台账> --card outputs/mine-clear/T-2026-0929-0004/card.json

# 3) 提交被测源码后，实际执行修复断言与独立验收断言
node scripts/delivery/mine-clear.mjs run-assertions --ledger <台账> --card MC-001 --actor <修复会话> --role repair
node scripts/delivery/mine-clear.mjs run-assertions --ledger <台账> --card MC-001 --actor <独立验收会话> --role acceptance

# 4) 门禁与视图
node scripts/delivery/mine-clear.mjs gate --ledger <台账>              # 三基线/实际断言/独立角色/P0与P1硬闸
node scripts/delivery/mine-clear.mjs status --ledger <台账>
node scripts/delivery/mine-clear.mjs plan --ledger <台账>              # 四批计划 + 冲突面
node scripts/delivery/mine-clear.mjs verify-baseline --ledger <台账> --repo .   # 三基线对齐

# 5) M6 交接 RDAS v3.1
node scripts/delivery/mine-clear.mjs handoff --ledger <台账> --env client-runtime
pnpm acceptance:profile:check
node scripts/acceptance/fleet-run.mjs --repo <repo> --env client-runtime
```

## 门禁语义（gate 为什么判红）

| 判红原因 | 出处 |
|---|---|
| 卡片代码不存在 / 行号越界 / 不属于审计基线 / blob 散列不符 | 纪律 1「无证据不上账」 |
| 断言缺可运行 `command`、含"优化/提升/加强"类措辞 | 纪律 9「验证信号前置」 |
| `fixed/verified` 但断言为 `fail/not-run`、缺运行记录或实际退出非零 | 纪律 1「证据优先于声明」 |
| 输出文件缺失/空/目录/symlink/越界、散列不符、commit/command/argv/卡号与实际执行不同 | 证据契约 `docs/mine-clear/evidence.schema.json` |
| 三基线缺失/null/未知、后代关系不成立、验收基线不是当前干净 HEAD | 纪律 6「基线显式对齐」 |
| `state=verified` 缺修复者/验证者，或同一 actor 且无独立批准来源 | 纪律 7「修复者不自验」 |
| 修复卡缺 `regression` / `rollback` / `conflict_paths` / 联动推演 | M5 修复卡格式 |
| **P0/P1 问题未独立 `verified`**，包括 `fixed/covered/wontfix` | 阻断交付；覆盖提交和声明不能替代独立验收 |
| 台账缺系统不变量清单 | M0「不变量是断言设计的骨架」 |

`handoff` 另外要求：**每个未闭环项都有 `regression.command`**（规范 §7），否则拒绝生成交接单。

## 产物

```
outputs/mine-clear/<任务号>/
  baseline.json   # 审计基线：commit / 分支 / 远端 main 对比 / 工作树脏项 / 冒烟位
  ledger.json     # 问题卡 + 修复卡 + 断言 + 证据
  evidence/       # 断言输出原文、日志摘录、响应原文、截图
  runs/           # workloom.evidence-run/v1：实际 argv/退出码/时刻/角色/提交/输出散列
  approvals/      # 独立批准来源；只有 reason 不能绕过角色隔离
  evidence-index.json # workloom.evidence-index/v1：运行与真实文件引用
  report.md       # 按 docs/mine-clear/report-template.md 出（四段硬性内容不可缺）
  handoff.json    # RDAS 验收交接单
```

## 退出码

`0` 通过；`1` 门禁未过 / 存在 stale 基线卡 / 交接被拒；`2` 参数或环境错误。

`init` 抓取失败时仍保存本地审计基线，`fetch_status=failed`、`fetched_at=null` 并给出未验证原因；`verify-baseline` 抓取失败退出 `2`。显式 `--no-fetch` 只核验本地 Git 历史，不声明云端最新。

## 执行证据与 RDAS 的共同契约

`assertion.exec` 是 `{ "file": "node", "args": ["--test", "path/to/assertions.test.mjs"] }`。`run-assertions` 直接调用 argv，捕获实际退出码、信号、起止时间和脱敏输出；执行前后提交与工作树必须一致。修复通过只进入 `fixed`，独立 `acceptance` 通过才进入 `verified`；失败、超时、缺可执行文件均回到 `unfixed`，旧验证声明被清除。

通过前置条件后、首个进程启动前，执行器先落盘 `unfixed/not-run` 并清除旧验收基线与验证声明；证据文件/索引发布出错或进程中断时，旧绿记录不能继续放行。`last_assertion_attempt` 保留本轮角色、提交、开始时刻及完成结果；旧运行文件保留以便追溯。

Node `--test` 会清理继承的 `NODE_TEST_CONTEXT`，添加受控 `node-test-reporter.mjs`，保存 TestsStream 的逐文件机器计数。记录中 `requested_exec` 保留台账声明，`exec` 保留实际带观测器的 argv，`node_observer` 绑定观测器散列与机器摘要文件；人工报告文本不作为断言计数。全筛掉、全部跳过或空测试文件都是零实际通过测试，即使外层文件加载退出 0，也记录 `validation.ok=false/result=fail`，原始 `exit_code` 仍保留 0。默认进程隔离模式提供逐文件摘要；其它模式若缺该摘要，保持未验证，不用外层 `passed=1` 代替。

文件引用是 `{ "path": "evidence/MC-001-0-….txt", "sha256": "<64hex>", "commit": "<40hex>" }`，路径相对台账所在目录。代码发现证据使用 `file:line@commit`，`sha256` 绑定审计提交中的完整 blob；非代码发现证据同样要绑定审计提交与真实文件。schema 见 `docs/mine-clear/evidence.schema.json`，实际 Git/文件/退出码回读由 `evidence.mjs` 执行。

同 actor 豁免需要 `reason/approved_by/approved_at/source`。source 必须回读为 `workloom.evidence-approval/v1`，其中批准主体、范围 `role-separation`、原因、完整提交与声明一致，批准者不属于修复/验收 actor；原始批准事件可保留 `source_uri` 供复核。手写 reason 不算批准。

`--actor` 由调用方提供，绑定 JSON 也不是平台签名身份认证。可信协调者仍须分配真实未参与修复的会话，并保留会话/批准来源；本地字段校验只能核对角色与证据一致性，不能证明调用者身份。

RDAS 的 `coverage.mjs` 固定复核 276 个唯一 ID。每项通过需相同 ID 的原始 `expected/actual/pass`、实际运行记录及文件散列；聚合 `ok`、`evidence-present`、0/0 或只放四个域摘要不会扩展成通过。`not-applicable` 必须有范围 `not-applicable` 的独立批准来源，仍保留在 276 项分母里。`report-v3.mjs` 再次回读所有条目与阶段文件，P 域另回读独立 receipt/transcript、真实产物、同线程事件与状态断言及 reserve→commit 配额账本；摘要的 calls/tokens、实际计量、冻结原因与原始账本逐项对账。缺失/不一致/未知实际用量保持 `unverified`，实际失败为 `fail`；输出报告只代表 `reportGenerated=true`，验收通过另由 `acceptancePassed` 表达。

`fleet-run.mjs` 在每个阶段执行前先落盘未验证状态，删除该阶段的旧派生产物与自动条目引用；被跳过、目标未就绪或执行器缺失的阶段也会清除旧自动通过证据。原始运行文件保留以便追溯。每次真实执行的日志与该阶段非空文件一起进入 run；必需 JSON 未重新产生、非法 JSON 或空文件不能凭退出 0 计通过。失败进程产生的新 JSON 同样被绑定，正式报告保留其真实失败。

回归与 `release:gate` 各有独立 argv/退出码/信号/起止时刻及 `workloom.command-observation/v1` 文件。`lib/regression-evidence.mjs` 再通过真实 Node 子进程回读这些 run，生成 `workloom.acceptance-regression/v2` 汇总；汇总自身绑定实际输入 `regression/summary-input.json`、全部必需命令及各运行记录。报告重新对账这些文件，不能只把“通过”字符串、最后一条命令或删减过的汇总当作门禁全绿。

coverage/report 退出码：`0=pass`、`1=fail`、`2=unverified`。报告不会从文件存在或配置推定 A 级精读/真机证据。

## 自测

```bash
node --test scripts/delivery/*.test.mjs
```

进程执行与退出状态遵循 [Node.js child_process 官方文档](https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options)；代码 blob 和后代关系分别由 [git show](https://git-scm.com/docs/git-show) 与 [git merge-base --is-ancestor](https://git-scm.com/docs/git-merge-base) 回读，工作树状态由 [git status --porcelain](https://git-scm.com/docs/git-status) 判断。

结构化测试观测使用 [Node.js Test runner 的 custom reporter / TestsStream](https://nodejs.org/api/test.html#custom-reporters)；人读报告格式不用于机器解析。


## 持续研发交付（queue-*，2026-10-07）

与上方 MCD 台账执行器并列；协议见 `docs/DEVELOPMENT-PROTOCOL.md` v2。产品所有者撤销 CNB/GitHub 等平台付费 AI 审核与 NPC 自动修复，要求当前 Codex 自带模型在提交/发布前完成代码 review 和实际测试。`queue-runner.mjs` 提供 status、lease、handoff、admit、verify-review、verify-bootstrap、prepare-install、verify-install、activate、reconcile、releases。旧 review-prepare、review-finish 和 review-plugin/model-gateway 执行入口在网络或模型 I/O 前明确拒绝；不会调用 SDK、模型网关、NPC 或发布平台批准。

日常开发使用独立工作树。普通重叠提示；敏感开发租约默认 15 分钟，以准确 owner/generation 续租。等待 CI/review 前用 lease --action release 显式释放；任务号、ready 或 handoff 不能自行解除有效租约。源码正向接纳在 main 独立的 workloom-delivery-admission 原生锁中自动 acquire→release→source_admitted，绑定 source/main 和完整路径摘要；实际集成另领取当前 fenced generation，旧持有者不能释放或续租新一代。

当前 Codex 会话先精读完整变化文件与直接依赖，处理错误/并发/权限路径并运行必要测试。将实际 review 与测试保存为结构化 JSON，再执行：

```bash
node scripts/delivery/queue-runner.mjs handoff --repo <org/repo> --pr <number> --review-receipt /path/to/actual-review.json
```

回执字段为 schemaVersion=1、provider=codex、repo、number、headSha、mainSha、policyHash、reviewedFiles、reviewedAt、summary、dependsOn、ciPolicyChanges，以及 tests 的真实 command、exitCode=0、finishedAt、result。精确 files/CI 变化 id 必须与当前快照一致；测试时间不得早于该源码提交或晚于 review。成功 handoff 保存正文回读后的快照和内容摘要。记录是可信会话的实际审查声明和一致性证据，不是平台签名身份，也不是平台 AI 批准；CLI 不启动 Codex API 或外部模型。

既有必需 CI 流水线与阶段身份、顺序和验证信号保留，不能转为 allowFailure。脚本、镜像、include 或依赖实现变化须在当前准确源码/主干快照中逐项解释 id、保留/增强的信号、回归和回滚。source/main/policy/完整范围漂移使旧记录失效；语义冲突或红灯保存 repairRequired 诊断，由当前 Codex 会话修复并重做 review/测试，定时执行器不派发平台模型。

trusted main 的 `cnb.yml` 每 5 分钟恢复。原仓 CI 与会话记录成立后，创建固定源码的不可修改候选 PR，再运行原仓 CI；仓级 workloom-delivery-merge 只串行实际集成。敏感候选必须取得并再次核验 fenced 集成租约，普通 merge 回读准确 source/main 双亲。WIP、risk/block、业务红线、缺记录、依赖未满足、权限失败或 CI 红灯保持未完成，其他可交付任务仍可推进。真实写响应不明先正向回读，不能盲目重复。

基座迁移暂时保留旧 delivery-ai-review / delivery-bootstrap-review 的流水线和阶段名称，以兼容旧主干的 CI 身份保护；执行内容全部替换为确定性的 Git/资产/账本/会话记录检查，没有 CodeBuddy 镜像或模型调用。目标安装包将 bootstrap 命名为 delivery-bootstrap-checks；不能从遗留名称推断仍在使用 AI。

Git `automation/delivery-state` 通过普通 fast-forward CAS 保存只增事件、任务、租约、尝试、会话 review/实测、集成与发布证明；transaction ID 恢复丢失 push 响应。没有强推。发布用独立 delivery-releases / workloom-delivery-release 锁，队列只启动/回读，不上传资产也不持锁等待子构建。UI 资产写入的唯一串行点仍为根 `.cnb.yml` 的 `.ui-release` / workloom-delivery-release-ui；页面与队列触发同一 api_trigger_ui_release，无第二上传通道。

UI/桌面发布必须显式传入已审查并合入的 RELEASE_EXPECTED_SHA 和版本。release-source 不从 current main/tag 的 CNB_BRANCH_SHA 推测来源；缺原生仓身份或准确 SHA 时打包/上传前失败。发布成功需真实 build SN/source/event/title、tag、manifest 与实际 SHA-512 字节。私有仓制品先经官方认证下载接口获取临时 byte URL，Bearer 只发给初始 CNB API，后续 HTTPS/CDN 请求不带凭据；权限、空流、大小、JSON、摘要或重定向失败均不能形成发布回执。桌面 mac/Windows 节点及签名环境缺失仍为欠项，Linux CI 不能冒充真实桌面构建。

首装先由具备设置权限的安装端在准确安装分支运行 prepare-install，回读状态分支强保护并准备准确 source/main。安装清单 schemaVersion=2 必须包含完整执行闭包、生成的 CI/文档、必要适配器及目标资产摘要；sourceSha 是上游来源提交，不是目标安装提交。verify-bootstrap 用只读临时 Git 检出准确安装源码，核验账本和每个 tracked asset 的 Git/文件字节；不能只凭标记 repo 或本地文件存在通过。

首装完成 Codex 会话 review/实测、确定性 bootstrap 与原有门禁后，才取消额外人工计数/管理员批准、冻结源码并普通 merge；首次安装合并前实时核对 ready、正文、依赖、源码/主干、完整范围和 CI。平台保留创建时政策时，只创建同一已冻结源码的替代 PR，保存原记录 id、原 PR 和相同实测，再跑完整原仓 CI；真实合入后关闭原 PR，源分支保留。当前 main activate 再核验准备证明、源码/主干祖先、会话记录、清单和保护，写 platformAI=false 事件。源 PR 原生令牌只读，云端持续执行只用原生托管/CI 令牌，会话凭据不进入文件或 CI。

Tiger 仍保留 Python/governance 产品检查。旧 governance 的四个协议入口显式委托根级现行协议/CLI，保留真实退出码，避免直接调用旧 open-PR 永久锁。未知加强版协议不覆盖；已审核的目标适配保留完整 Git、PR、main、fork、路径和租约边界。删除文件 URL 只能对应目标旧 base，新增/修改文件仍绑定准确 source。

两个隔离副本按产品所有者授权各自在本仓安装研发机制，不改变行业身份、冻结上下文或隔离清单，不加入业务 fanout；客户数据、生产秘密和 Tiger 实盘等仍须单独授权。

验证：`node --test scripts/delivery/queue.test.mjs scripts/delivery/install-repository.test.mjs scripts/delivery/install-account.test.mjs scripts/ci/protocol-rules.test.mjs sync/fanout-safety.test.mjs`。实际 Git 测试覆盖 CAS 竞争、丢失响应、普通分支对齐/冲突、准确两亲激活、完整清单、会话记录漂移、租约、权限、依赖、失败隔离和固定源码发布。云端上线另需真实原仓检查、merge/activation 与原生状态写入；本地测试不代替云端成功。

### 账户新增仓安装

基座激活后，安装端运行 `node scripts/delivery/install-account.mjs --source-root <基座当前 main 工作区> --directory <专用安装目录> --concurrency 2`。读取所有 Owner/active 仓库的完整分页，包括嵌套组织；来源必须为当前基座 main 且账本有真实激活。每仓使用带任务所有者标记的独立完整干净 clone，保留其他任务工作树与远端，进程声明避免并发安装和失效锁删除竞争。

每仓检查既有产品 CI，按确定资产摘要、任务卡、分支和 PR 幂等恢复，并离线刷新目标自身开源清单。缺 main、冻结、权限失败、检查未过或缺 Codex 实测记录保存明确状态；一仓失败不停止其他仓。只有真实 merge 双亲、activation 和原生写入回读成功才算启用；已激活仓更新经原生候选，不能走首次安装捷径。

用户取消的 Codex chat 账户安装 heartbeat 保持取消。本机制不会重建它。未来仓扫描/准备可由另行授权的安装调度执行；实际会话 review/实测仍须 Codex 完成，缺记录保持等待，不能由定时脚本伪造。账户报告在专用目录 latest-report.json；仓级原生五分钟交付和账户安装调度分别回读。

### CNB 契约来源

[官方语法手册](https://docs.cnb.cool/zh/build/grammar.html)规定退出码 78 表示成功并中断当前流水线，include 的数组追加、对象合并、本地覆盖引用配置。因此非安装分支跳过 bootstrap 不跳过独立产品流水线。[默认变量契约](https://docs.cnb.cool/en/build/build-in-env.html#usage)规定原生仓库身份自动注入，每个 job 使用真实身份而不覆盖。[官方 OpenAPI](https://docs.cnb.cool/zh/develops/openapi.html)定义认证接口；具体读写、保护和制品证明按平台实时回读。
