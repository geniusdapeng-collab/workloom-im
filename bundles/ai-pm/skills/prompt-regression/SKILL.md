---
name: prompt-regression
version: 3.0.0
description: prompt 新旧版本 eval 回归 diff——通过率变化、退化案例 Top3、成本 delta；未通过阻断、通过转人审（R-PM8 双段门禁的执行器）。
---

# prompt 变更回归

## 一、何时调用
- 任何生产 prompt 变更提交时（强制）；
- 两个 prompt 版本 A/B 对比评估时（评估方案须人审）。

## 二、输入契约
- prompt 旧版本与新版本（版本库登记）；关联 eval 集（核心路径+历史 badcase 全覆盖，不得只跑抽样好话术）。

## 三、执行步骤
1. 新旧版本在同一 eval 集上分别跑分（同一模型、同一参数）；
2. 产出 diff 报告：通过率变化、退化案例 Top3（具体到条目与差异）、新增通过案例、成本/时延 delta；
3. 判定：通过率下降或出现核心路径退化 → 阻断（R-PM8 block 段）；通过 → 提交人审（review 段）；
4. 人审批准后新版本生效，旧版本保留可分钟级回滚。

## 四、边界与围栏
- 权限面：prompt 版本库读写（R-PM8）；跑分走谷时窗口。
- 绝不编造回归结果；judge 参与评分时遵循 85% 一致率校准纪律，失准期 judge 结果仅供参考。

## 五、与其他技能的协作
- 上游：prompt-curator 的变更登记；eval-forge 的 eval 集；
- 下游：changeset-harvest（DevFabric S4 的 eval 回归门禁即调用本技能）、release-cut（发布附回归摘要）。
