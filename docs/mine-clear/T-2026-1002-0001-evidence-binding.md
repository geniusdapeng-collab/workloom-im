# T-2026-1002-0001 排雷台账回执绑定：结构性死锁与处置

适用范围：`outputs/mine-clear/T-2026-1002-0001/` 的 MCD 台账。本文件记录被拒候选 #256
的第三类问题、实测复现方式，以及为什么它无法在"只准普通提交"的约束下由本会话收敛。

## 1. 被拒的问题（真实存在）

台账与 `evidence-index.json` 的每一份 `run`/`artifact` 都声明 `commit=849a5a1`，
但回执实体是 `5e0044f` 随分支入库的。`mine-clear.mjs gate` 会经 git 在**声明提交**上
回读每份产物（`verifyArtifact` / `verifyRun` → `git show <commit>:<path>`），因此：

```
$ git show 849a5a17e7f969d19eafed9eb6d31ca52e6a79f6:outputs/mine-clear/.../runs/MC-040-....json
fatal: path '...' exists on disk, but not in '849a5a1'
```

28 份回执在任意克隆上一份都取不到。上一轮提交说明写"逐份 sha256 与台账引用一致、
可在任意克隆上现场回读"，实测不成立：磁盘字节确实一致，但声明提交里没有这些文件。

## 2. 已落地的修复（可独立复跑）

- `scripts/delivery/rebind-ledger-evidence.mjs`：回执回读控制面。
  `--check` 逐份从**声明提交**回读 blob，核对 sha256 与磁盘字节，不一致即非零退出；
  `--write` 按磁盘字节刷新散列。修复前 28 份全部命中不了，修复后 28 份全部通过。
- `scripts/delivery/mine-clear.test.mjs` 新增 3 条回归（脱钩判红 / 重绑后可逐份回读 /
  脏树拒绝重绑 / 散列篡改判红），`node --test` 18/18。
- 回执已在真实可回读的提交上重采：4 张卡 7 条断言，先在私有 Unix PG 17 集群上以
  `role=repair` 跑一遍、再以 `role=acceptance` 跑一遍，逐条 `exit_code=0`、
  `assertion_validation.ok`；`runs/` `evidence/` `evidence-index.json` 与台账同批入库。

## 3. 结构性死锁（本会话无法收敛的原因）

`mine-clear.mjs` 的三基线契约要求两条同时成立：

1. `baseline.acceptance.commit` **必须等于当前 HEAD**（`verifyBaselines`：
   `commits.acceptance !== revision.commit → "验收基线不是当前 HEAD（过期验收证据）"`）；
2. 每条断言回执必须能在**它声明的提交**上回读，且引用链上的
   `assertion.run.commit` / `assertion.evidence.commit` / run 记录内部 `commit`
   都必须等于 `acceptance.commit`（`verifyCardEvidence` → `expectedCommit = commit`）。

但回执实体只存在于**添加它的那个提交**里。指向该实体的台账只能写进**之后的提交**。
于是每次把台账提交上去，HEAD 就前进一格，`acceptance` 又落后于 HEAD：

```
95cea20  回执实体入库，台账指向 95cea20   → gate: 验收基线不是当前 HEAD
2e99699  提交台账（HEAD 前进）           → gate: 验收基线不是当前 HEAD
...      再对齐、再提交，循环
```

要收敛需要一个"自身包含指向自己回执的台账、且自身就是 HEAD"的提交，而提交不能包含
自己的 SHA。因此这三条约束在当前实现下无不动点。

## 4. 处置与边界

- 本轮**不伪造** `acceptance.commit`、不改写 gate 语义、不删断言、不跳过门禁。
- 把 `acceptance.commit` 设成 HEAD 再提交会立刻过期（第 3 节），设成别的提交则
  `verifyCardEvidence` 会因 `expectedCommit = acceptance` 判定回执不一致——两条路都红。
- 台账回执绑定本身已真实可用（第 2 节），死锁只在"同时要 HEAD 一致"这一条上。
- 建议由拥有门禁实现权的一方决定处置：或让 gate 允许 `acceptance` 是 HEAD 的祖先
  （与 `is_descendant_of_repair` 的语义一致），或让回执绑定到 `repair` 基线而非
  `acceptance`。这两种都属门禁语义变更，超出本会话授权。
- 台账剩余项（MC-040 / MC-043 的独立 verified、acceptance 基线）按设计保留。

## 5. 复跑方式

```bash
node scripts/delivery/rebind-ledger-evidence.mjs \
  --ledger outputs/mine-clear/T-2026-1002-0001/ledger.json --repo .
node --test scripts/delivery/mine-clear.test.mjs
node scripts/delivery/mine-clear.mjs gate \
  --ledger outputs/mine-clear/T-2026-1002-0001/ledger.json
```
