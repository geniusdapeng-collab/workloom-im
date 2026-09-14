# WorkLoom IM 基座同步

`base-sync` 把 WorkLoom IM 的公共能力安全分发给行业仓，同时保护行业仓自有代码。同步边界的唯一事实源是 `sync/base-scope.json`。

## 两类同步资产

### 根级必备资产

`requiredRootAssets` 无视 `pathPrefix`，始终安装在目标 Git 仓库根目录：

- `WORKLOOM_PRODUCT_CONTEXT.md`：完整覆盖，workloom-im 是唯一受控原文；
- `AGENTS.md`：只替换 `WORKLOOM-CONTEXT:BEGIN/END` 之间的唯一受控区块，标记外的子仓规则原样保留；
- `.github/workflows/base-sync-heartbeat.yml`：从 `sync/heartbeat-template.yml` 逐字节覆盖，模板无仓别占位符，可随 required-only/full 同步自升级；
- `.workloom-base-sync.json`：由引擎生成在 Git 根目录，记录必备资产 SHA-256、真实基座提交与 `pathPrefix`。

因此 Tiger 的公共代码即使位于 `governance/`，上述四个文件仍位于 Tiger 仓库根目录。heartbeat 从根级 state 读取 `pathPrefix`（根仓为 `.`、Tiger 为 `governance`）。引擎兼容读取旧版 `governance/.workloom-base-sync.json`，下一次对齐会把它迁到根目录。

若子仓完全没有 `AGENTS.md`，引擎会生成稳定的通用根级 scaffold：一级标题、共享受控区块和标记外的“本仓专属规则”入口；不会带入 workloom-im 的本仓命令或尾部说明。已知旧版通用 WorkLoom IM 指引只有在完整文件 SHA-256 精确命中 allowlist 时才整文件迁移；未知且无标记的文件保留原文、追加受控区块，并在 report 标记 `manualMigrationRequired`。残缺、重复或乱序标记会 fail closed。

### 公共基座文件

`include` 选中公共包、运行时和共享服务；`exclude`、仓级 `extraExclude`、锚点合并与污染守卫共同保护行业 bundle、种子、页面、迁移链、平台运维代码及行业依赖。

`AGENTS.md` 不在普通复制范围内，避免整文件覆盖子仓约定。根级必备资产也不受 `docs/**` 排除或行业 `pathPrefix` 影响。

## 命令

```bash
# 每次都比较实际文件；即使 state 的 base SHA 相同也会验真
node sync/base-sync.mjs detect --repo /path/to/child

# 对齐并生成一个只含白名单文件与 state 的提交
node sync/base-sync.mjs pull --repo /path/to/child

# 只安装/校验根级上下文，不触碰其他基座或行业代码
node sync/base-sync.mjs pull --repo /path/to/child --required-only

# 特殊接入/稀疏工作树：写文件和 state，但不暂存、不提交、不推送
node sync/base-sync.mjs pull --repo /path/to/child --required-only --no-commit

# 本地测试或固定基座提交，完全绕开远程发现
node sync/base-sync.mjs detect --repo /path/to/child --base-dir /path/to/workloom-im

# 只读生成全部订阅仓计划
node sync/base-sync.mjs push --base . --dry-run

# 只读生成“仅根级必备资产”的全部订阅仓计划
node sync/base-sync.mjs push --base . --dry-run --required-only
```

通用参数：

- `--required-only`：detect/pull/push 只处理根级必备资产与根级 state；
- `--no-commit`：pull 只写不提交，也不会暂存文件；不能与 `--push` 组合；
- `--dry-run`：只计算计划，不写文件/state；
- `--json`：输出机器可读报告；
- `--base-dir`：使用已固定的本地基座 checkout；
- `--extra-exclude a,b`：追加仓级排除规则；
- `--push`：pull 提交后直接推 `HEAD:main`，仅保留为受控人工入口，自动化默认采用 PR。

默认 pull 会自动提交，因此开始前要求目标仓库完全干净；存在任何非本次改动就会在写入前拒绝。必须在有意保留脏工作树时使用 `--no-commit`，随后由操作者人工审查和白名单暂存。引擎只允许显式白名单暂存。`--adopt` 是 `adopt.sh` 的受限内部开关，只能与 `pull --required-only --no-commit` 组合。

本地 `--base-dir` 必须是基座 Git 根，且本次会读取的受控源文件必须由当前 HEAD 跟踪并逐字节一致；无关的本地改动不阻塞。远程 clone 固定使用 `main`、`--single-branch`，并验证 `HEAD == refs/heads/main`。来源或目标路径任一段为 symlink（包括 dangling symlink）、越界路径或不规范 `pathPrefix` 都会被拒绝。

## 新行业仓接入

```bash
bash sync/adopt.sh /path/to/new-industry
bash sync/adopt.sh /path/to/workroom-tiger --path-prefix governance/
```

`adopt.sh` 支持普通 clone 和 `.git` 为文件的 linked worktree。执行顺序是：

1. 验证普通 clone/linked worktree、规范化 `pathPrefix`、基座脚本来源和全部路径边界；
2. 安装根级产品上下文、AGENTS 受控块与静态 heartbeat，并在写 state 前逐项复验、执行密钥扫描；
3. 若仓库由 workloom-im fork/template 派生，仅在内容与基座逐字节相同时，把父仓专属 `AGENTS.repo.md` 替换为通用待填写 scaffold，并删除父仓专属 `.github/workflows/base-sync-push.yml`；未知或已定制内容绝不覆盖，其他 workflow 不受影响；
4. 写入带 `pathPrefix` 的根级 state，再运行独立 detect 与四项接入资产密钥扫描。

脚本不暂存、不提交、不推送。审查根级接入资产和可选的两项精确派生迁移后，由操作者白名单提交，并把新仓登记进 `sync/child-repos.json`。任何扫描或安装失败都会回滚本次写入，不把受阻内容留在目标工作树。

## 自动化与凭据

- 父仓 plan 在不接触跨仓凭据时先执行 YAML、密钥扫描器和同步引擎测试；PR 事件停在本地验证；
- 可选 fan-out 只使用限定到清单仓库的短期 GitHub App installation token：先做 private-safe 跨仓 dry-run，再以精确 `base_sha` 和 `mode=required-only|full` 发送 `repository_dispatch`，并仅对 GitHub 标记为 `disabled_inactivity` 的 heartbeat 做恢复与运行监控；未配置 App 时公开九仓仍由各自 schedule 工作；
- 子仓 heartbeat 先以公开只读、无 token 的方式把基座 `main` 固定为不可变提交，再执行该提交里的引擎；同步阶段显式拒绝残留认证 header；
- 发生变更后，子仓在注入写令牌前执行 `pnpm install --frozen-lockfile --ignore-scripts`，并按脚本存在性运行 typecheck/test，且要求验证后工作树干净；最后才用本仓短期、最小权限 `GITHUB_TOKEN` 推同仓分支并创建 PR；
- Git 远端 URL 永不拼入令牌。确需命令行认证时，引擎只通过临时 Git 环境配置传递 HTTP header，并对错误做二次脱敏；
- 成功、失败和 dry-run 路径都会清理临时 clone。

不要配置、记录或提交个人访问令牌。同仓 `GITHUB_TOKEN` 创建的事件不保证自动触发后续 PR CI，因此 heartbeat 自身的推送前验证是硬门槛；同步 PR 仍须人工评审，若仓库另有可触发的外部 CI，再把它作为附加门槛。

## 状态与验真语义

根级 `.workloom-base-sync.json` 包含：

- `lastSyncedBaseSha`：最近一次完整基座同步提交；
- `lastRequiredAssetsBaseSha`：最近一次根级必备资产来源提交；
- `requiredRootAssetsSha256`：完整上下文、静态 heartbeat 及 AGENTS 受控区块的独立哈希；
- `pathPrefix`：行业基座在仓内的规范相对路径（根目录记为 `.`）；
- `lastSyncMode`、`lastSyncAt`、`filesTouched` 和仓级排除项。

state 只用于审计和加速理解，不是“已对齐”的证明。`detect` 总会重新读取基座与目标文件；SHA 相同但上下文缺失、被改写或标记异常仍会返回退出码 `2`。反过来，内容已一致但根级 state 缺失或过期也会以独立的 `stateDrift` 返回退出码 `2`，从而触发一次 state-only pull。标记缺失时可安全追加，标记残缺、重复或顺序错误时 fail closed，等待人工修复。

## 提交与失败边界

- 同步计划在落盘前完成污染黑名单和单次文件数检查；
- 内容安装后再次计算计划，确认零漂移后才写 state；
- 锚点合并后的 lockfile 只用 `pnpm install --lockfile-only --ignore-scripts` 刷新，失败即关闭；
- 自动提交只暂存计划内文件、新产生的 lockfile 和根级 state，并在 state 落盘前后分别调用基座 HEAD 中受控的密钥扫描器检查 staged 白名单；
- `--no-commit` 也会扫描本次写入资产与待写 state；扫描、lockfile、安装复验或提交前任一环节失败，事务会恢复文件和 index 到同步前状态；
- required assets 无法验证、AGENTS 标记异常、目标工作树不干净或认证失败时立即停止；
- 错误文本会移除已知 token、GitHub token 形态、认证 header 载荷和 URL userinfo。

## 测试

```bash
node --test sync/base-sync.test.mjs
bash -n sync/adopt.sh
node --check sync/base-sync.mjs
```

测试覆盖 AGENTS 三态迁移与 report、同 SHA 文件验真、Tiger 根级落点、旧 state 迁移、静态 heartbeat 自升级、来源 HEAD 约束、白名单提交、脏树拒绝、`--required-only --no-commit`、required-only push、lockfile/密钥扫描事务回滚、凭据脱敏、源/目标/dangling/pathPrefix symlink 对抗、临时 clone 全路径清理、linked worktree 跨仓前缀接入，以及父仓专属文件的精确派生清理。
