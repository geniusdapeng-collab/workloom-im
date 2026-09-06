# 仙女座运营运维系统 · 平台运营包（platform-bundle）

> 对应 PRD：《WorkLoom 平台运营运维系统 产品需求文档 V3.0》
> 一句话定义：**以工单为账本、以技术支持为桥梁、以知识库为弹药、以自生长为引擎的平台级服务系统——用 AI 运营运维 AI，执行交给数字员工，裁决永远在人。**

本包是平台运营实例的行业差异资产包：一套独立部署的 WorkLoom 实例 + 本包 = 仙女座运营运维系统。
底座代码零改动，复用基座全部机制（五元事件/围栏瀑布/审批/班组/巡检/夜班/组织记忆/service-ticket/service-dialog/service-kb/积分事件投影）。

## 四根支柱 → 包内资产映射

| 支柱 | PRD 功能 | 包内资产 |
|---|---|---|
| **桥梁**（技术支持服务） | F1 通道 / F2 意图识别 | `presets/fae-chief.yml`、`skills/intent-triage`、`service-front/faq.json` |
| **账本**（工单中枢） | F3 状态机/SLA/记账/回访 | `skills/ticket-ledger`、`seeds/tickets.json` |
| **弹药**（企业知识库） | F5 生命周期/版本对齐/保鲜 | `presets/kb-*.yml`、`skills/kb-harvest`、`skills/kb-fresh`、`seeds/kb.json` |
| **引擎**（策略中心） | F12 / 第七章自生长 | `presets/insight-analyst.yml`、`strategy-engineer.yml`、`effect-evaluator.yml`、`skills/strategy-forge`、`seeds/strategies.json`（含策略墓地） |

## 七个数字员工班组（17 名，PRD 第六章）

| 班组 | 数字员工 | 承接业务域 |
|---|---|---|
| FAE 工单组 | 平台客服长 / 工单分诊官 / 需求转运官 | D1/D2/D4 |
| 知识管理组 | 知识馆长 / 知识保鲜官 | D3 |
| 客户成功组 | 客户健康官 / 续费预警官 / onboarding 向导官 | D5 |
| 计费账务组 | 积分对账官 / 账单官 | D6 |
| 平台运维组 | 巡检官 / 故障应急官 | D7 |
| 行业包运营组 | 包版本官 / 上架审核官 | D8 |
| 策略运营组 | 洞察分析师 / 策略工程师 / 效果评估官 | D9 |

## 平台围栏包（R-PL1~R-PL10 + default_level=review 兜底）

见 `fences/platform-baseline.yml`。红线：**R-PL4 客户数据导出 block（无审批通路）**、**R-PL10 触达频控 block（全策略共享计数器）**；资金/批量/研发注入/灰度/通报/知识发布/策略上线全部 review 人审。

## 与 ai-pm V3 的深度耦合（需求流，PRD 业务流二）

这是本系统与 WorkLoom IM 基座中最关键的衔接设计。**客户的每一句"我想要 XX"，终点是 ai-pm 产品经理负责制研发流水线的一次交付：**

```
客户对话（feature_request）
  └─ 需求转运官（requirement-dispatcher，本包）
       ① 澄清框架四问（场景/使用者/验收期望/约束）→《需求确认单》
       ② 客户显式确认（唯一闸门，禁止省略）
       ③ R-PL3 人审：平台 PM 拍板立项（驳回须给理由并回传客户）
       ④ 注入 ai-pm V3「平台工单入口」→ requirement-analyst 接单
           建立 ticket ↔ requirement 双向关联（requirements_link）
           同类需求多客户聚合为一个 requirement；需求热度 = f(客户数, 健康分, ARR)
  └─ ai-pm V3 流水线（基座 bundles/ai-pm）：立项 → 开发 → 评测 → 发布
       ⑤ 关键节点 1 分钟内回传工单并推送客户（状态透明）
       ⑥ 交付说明自动推送 → 客户验收 → 关单 → 第 3 天回访
       ⑦ 回访反馈三路分流：问题→新工单 / 建议→eval 集 / 问答→知识库候选
       ⑧ 行业通用判断 → 行业包运营组灰度分发（5%→50%→100%，R-PL5 每批人审）
```

工程落点：注入与回传走标准「工单/需求/交付事件」三种标准消息（PRD §1.5 产品解耦原则——两个 Bundle 互不知道对方存在，只通过事件衔接）。`skills/requirement-clarify/SKILL.md` 是衔接岗的完整作业契约。

## 数据红线（PRD §9.2，档案 forbidden 硬约束）

- 平台库**不存**客户原始经营数据（订单/营收/对话明细）；只存工单、脱敏健康指标元数据、版本与账务信息；
- 客户侧上报字段级白名单：工单数据/版本号/聚合健康指标/错误码；白名单外字段整批拒收并告警；
- R-PL4 block 兜底一切导出企图。

## 实施路线（对应 PRD 第十二章 P1→P4）

| 阶段 | 主题 | 本包支撑 |
|---|---|---|
| P1 客服通道贯通 | 客户能提、平台能接、AI 能答 | 意图六分类 + 知识库初版 + 工单状态机（已含） |
| P2 研发衔接闭环 | 需求变交付、交付变关单 | 需求转运官 + 确认单 + 状态回传（已含） |
| P3 经营班组上岗 | 健康分/对账/知识复利 | 客户成功组 + 计费账务组 + 知识管理组（已含） |
| P4 规模化自治与自生长 | 巡检聚合/版本矩阵/策略引擎 | 运维组 + 包运营组 + 策略运营组（已含）；工程篇（实时链路/OLAP/推送网关）按 PRD 第十五~二十一章在基座演进 |

> 工程篇（NATS JetStream 实时面 / Redis 缓存面 / ClickHouse 分析面 / push-gateway）属基座能力演进，走 WorkLoom IM 基座迭代后由 base-sync 机制同步全部子仓——行业包层无需改动。
