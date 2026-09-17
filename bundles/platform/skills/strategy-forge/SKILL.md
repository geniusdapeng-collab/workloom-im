---
name: strategy-forge
version: 1.0.0
description: 策略锻造——自生长闭环：洞察→提案→审批→灰度→归因；策略是可执行、可灰度、可回滚、可归因的结构化对象。
---

# 策略锻造（自生长引擎）

## 一、何时调用
- 每日洞察产出后；策略上线到达度量窗口时；熔断触发时。

## 二、闭环
```
感知（工单热点/反馈/健康分/流失信号/知识缺口）
→ 洞察（AI 发现模式与异常，证据链完整）
→ 提案（策略工程师编译策略草案）
→ 裁决（R-PL9 人审，围栏把关）
→ 上线（灰度默认，自动生效）
→ 回收（效果归因 vs 基线，迭代或回滚）
```

## 三、策略对象九要素
strategy_id / type / trigger（机器可判定）/ action（机器可执行）/ targeting（人群圈选）/ rollout（灰度方案）/ metrics（效果指标+归因基线）/ guardrail（熔断条件）/ approval（审批记录）。

## 四、策略类型（第一期）
knowledge_gap_fill 知识补全 / proactive_care 主动关怀 / billing_hint 计费提示 / sla_tuning SLA 调优 / health_weight_tuning 健康分权重 / intent_route_tuning 意图路由 / rollout_batching 灰度节奏 / alert_aggregation 告警聚合 / staffing_advice 人力建议。

## 五、纪律
1. 没有度量指标的策略不许提交审批；
2. 灰度是所有策略的默认出生方式（全量一步到位需写明理由）；
3. 熔断优先于审批：触发熔断条件自动暂停，不等人；
4. 策略墓地公开可查：回滚策略与失败教训记入组织记忆，防止同一错误换马甲再提。

## 六、自生长边界（什么不许自动长）
- 涉及钱的动作永不全自动（R-PL1）；客户数据导出类策略直接拒绝（R-PL4）；
- 触达频控：7 天被动触达 ≤2 次，全策略共享计数器（R-PL10）；
- 策略不得修改围栏规则本身（围栏变更走独立人审流程）。

## 七、与其他技能的协作
- 上游：insight-analyst（洞察）；下游：effect-evaluator（归因）、kb-fresh/health-scan/care-outreach（策略执行面）。
