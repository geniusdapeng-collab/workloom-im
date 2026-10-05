# 排雷式交付执行器（scripts/delivery/**）

> 规范：`docs/MINE-CLEAR-DELIVERY-SPEC.md`（mcd/v1.0）｜台账 schema：`docs/mine-clear/ledger.schema.json`｜报告模板：`docs/mine-clear/report-template.md`｜投喂模板：`docs/mine-clear/prompt-pack.md`
> 本目录随基座 base-sync 分发到各仓（`sync/base-scope.json#requiredRootAssets`）；**行业差异不要改这里的代码**。

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


## 持续研发交付（queue-*，2026-10-05）

与上方 MCD 台账执行器并列的研发交付机制；具体协议见 `docs/DEVELOPMENT-PROTOCOL.md` v2。`queue-runner.mjs` 提供 status、lease、handoff、review-prepare、review-finish、activate、reconcile。日常开发用独立工作树；普通重叠提示；敏感开发租约默认 15 分钟，owner/generation 续租；CI/评审前交接释放。

trusted main 的 `cnb.yml` 每 5 分钟恢复，原生仓级锁串行集成。原 PR 通过必需检查后创建不可修改候选分支/PR，再运行绑定 source/main/policy/完整文件列表的真正 CodeBuddy 审查。Bot Approve 和完整结构化结果双重回读；平台强保护保留，不等待用户点 Approve。没有覆盖、超时、CI 红、依赖未满足或权限失败均不合。

AI 使用固定官方镜像内的 SDK，按每批最多 30 个变化路径分批精读；每仓同时只有一条审查流水线、最多两个模型子进程。全部批次必须给出准确覆盖和身份回执，任一批缺失、失败或漂移不发布 Approve。审查失败按 source/main 限两次并退避；进程中断由原生 build SN 回读计数，丢失启动响应以唯一 title 查回，无正向回执不重复启动。未知结果只保留该任务，超出在途时限后无关任务仍可排入原生串行锁。

既有必需 CI 阶段只能增加检查，不能被来源分支删改、调序或降级；若需改变既有门禁本身，先提交独立治理变更并经过可回读的独立 AI/平台检查，不能借普通 PR 偷换已经测试的政策。当前执行器对此类门禁替换保持阻断，不能声称它已支持自动迁移门禁政策。

Git `automation/delivery-state` 保存任务、租约、事件、尝试、AI、集成和发布证明；普通 fast-forward push 是 CAS，transaction ID 处理丢失响应。没有强推。合并响应不明暂停集成，先正向回读；声明的 UI/桌面制品发布单独排队、固定 SHA/版本并校验 tag/manifest/实际 SHA-512 字节，失败不跳过无关集成，不生成发布成功回执。

初次安装必须有真实 bootstrap AI 审查和原仓检查；合入以后由设置权限者一次安装不可修改候选/状态保护规则、回读 main 必需检查/评审并取消额外管理员批准、写 activation 事件。云端只有 CNB 原生令牌，不保存会话凭据。隔离副本排除，平台秘密/实盘/客户动作不在研发自动授权内。

验证：`node --test scripts/delivery/queue.test.mjs scripts/ci/protocol-rules.test.mjs sync/merge-sync-prs.test.mjs scripts/ui-release-registration.test.mjs`。包含真实本地 bare Git 的 CAS 并发、丢失 push 回执、主干对齐/语义冲突，与 AI 覆盖、权限、过期、依赖、失败隔离和冻结发布断言。云端上线另须真实平台检查、AI 和状态回读；本地模拟不算云端成功。
