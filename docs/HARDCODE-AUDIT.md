# 硬编码排查报告（workloom-im / WorkLoom 基座）

> 排查日期：2026-08-29 · 方法：六类维度自动扫描（`scripts/hardcode-scan.mjs`）→ 白名单过滤 → 逐条语义复核
> 范围：apps/（server+web+webc）、packages/（base/runtime/shared/db）、bundles/、scripts/、.github/
> 结果：候选 932 条 → 白名单豁免 745 条 → 疑似 187 条逐条复核 → **真问题 14 项（已全部修复）+ 测试治理 3 项（魔法数动态化 / suite 与底座测试行业夹具中性化）**
> 基座特殊纪律：D 类（行业泄漏）为重中之重——底座 packages/base、packages/runtime、packages/shared、packages/db 必须行业零残留（D18，注释同责）。修复后复扫 **D 类疑似 0 条**。

## 一、复核结论总表

| 类别 | 疑似数 | 真问题 | 判定 |
|---|---|---|---|
| A 环境配置 | 91 | **1** | P22 官网源 placeholder 写死 `hotel.example.com`（P2）；其余为 CI 连接串、本地开发脚本默认值（有 env 兜底）、第三方官方端点（微信/LLM 预设/镜像源）、oss-components.json 开源清单、dsh-gate 本机地址——标准实践，豁免 |
| B 身份演示 | 17 | **3** | trpc.ts 演示登录写死 slug+MEM-001（P1）、P7 行业草稿写死 MEM-001（P1）、P1 经营主页写死「云栖酒店 · 演示身份 MEM-001」（P1）；demo.ts/release-gate/eval 为演示与冒烟脚本（白名单豁免） |
| C 密钥凭据 | 0 | 0 | 全仓无明文密钥（JWT_SECRET 走部署方配置；套件内 sk-e2e-dummy 为桩假值） |
| D 行业泄漏 | 24 | **8** | 底座酒店残留：inspection 检项/探针、service-dialog 意图词表与应答、service-kb 同义词与弱词表、service-ticket 部门路由、runtime 剧本工具（pms.\*/云栖/竞对酒店）、runtime 内容正则（小红书/抖音）、runtime 动作词（关房/开房）、server 客服 prompt（酒店前台）；另有 9 处注释行业词（P1 中性化） |
| E 规则外溢 | 6 | 0 | charter.ts 默认值 5000/2000 **基座不改**（基座行业无关，行业化由行业包 seed 覆盖；测试已动态化防回归）；E8.3 驳回校准 ×2 为有注释依据的产品逻辑常量（豁免） |
| F 文案展示 | 49 | **2** | P8「Agent ID」未中文化（P2）；P1 快捷目标酒店句式（P2）；其余为 role 枚举逻辑判断与 display 字典本体（豁免）；「API Key」为通用术语（保留） |

## 二、修复清单（14+3 项，全部完成）

| # | 级别 | 位置 | 问题 | 修法 |
|---|---|---|---|---|
| 1 | P1 | `apps/web/src/lib/trpc.ts` | 演示登录写死 `workspaceSlug: "yunqi-hotel"` + `MEM-001`——客户自建工作区时演示登录即坏 | 抽为 `VITE_DEMO_WORKSPACE` / `VITE_DEMO_MEMBER` env 可配（保留种子默认值兜底） |
| 2 | P1 | `apps/web/src/pages/p7/P7.tsx` | 行业草稿 `ownerMemberNo: "MEM-001"` 写死 | 默认空，加载时以当前登录身份 `members.me.identity.memberNo` 填充（fenceRef `hotel-baseline/v1` 保留——内置示例 bundle 真实围栏，有消费方） |
| 3 | P1 | `apps/web/src/pages/p1/P1.tsx` | 上线横幅写死「云栖酒店 · 演示身份 MEM-001」 | 工作区名改取 `workspace.profile.name`，去除写死号码；空态兜底「演示工作区」 |
| 4 | P0 | `packages/base/inspection/checks.ts` `scan.ts` | `HOTEL_CHECKS` / `room_state` / 房态探针——底座行业词（D18） | 中性化为 `DEFAULT_CHECKS` / `state_sync` / 状态同步探针（`stateUnits[{unit,synced}]`）；seed 快照字段、suite 探针键同步改名 |
| 5 | P0 | `packages/base/service-dialog/dialog.ts` `intents.ts` | mock 应答「云栖酒店智能客服」、工单映射（空调/马桶/房费/押金）、意图词表（房型/大床房/早餐/wifi/退房/入住/续住/打扫）——生产路径行业词 | 中性化为通用服务口径（智能客服/设备/水管/费用/清洁/更换/续费/营业/会员/优惠）；server 复用同一张规则表不漂移 |
| 6 | P0 | `packages/base/service-kb/search.ts` | 同义词表（早饭→早餐/wifi 五连）与弱词表（酒店/房间/客房/住客/前台） | 通用同义词（会员/优惠/配送/开票/退换）与中性弱词表 |
| 7 | P0 | `packages/base/service-ticket/constants.ts` | 工单类型「送物」、部门路由 客房部/工程部/值班经理/前台 | 配送 / 配送组 / 维修组 / 客服主管 / 客服组（通用口径，路由表仍可注入覆盖） |
| 8 | P0 | `packages/runtime/src/tools.ts` | 剧本工具 `pms.price.*`/`ota.price.write`、竞对卡「西湖云舍酒店」、评价渠道「携程」、文案「秋日云栖套餐」 | 工具改名 `biz.price.*`/`channel.price.write`（行业无关命名），剧本数据中性化（竞品门店/评价平台/秋日特惠套餐/occ_7d→sold_7d） |
| 9 | P0 | `packages/runtime/src/loop.ts` | 内容域分流正则含 `小红书|抖音|TikTok`（社媒行业词）；规划白名单/水合判断引用 pms.\* | 正则去平台名（保留通用内容词）；工具名同步 biz.\*；模板步骤标签中性化 |
| 10 | P0 | `packages/runtime/src/intent.ts` | 动作词表含酒店操作「关房/开房」；clarify 示例「雅致大床房/携程」 | 下架/上架；示例改「主打款调价/回复 2 分差评」 |
| 11 | P0 | `apps/server/src/service/dialog.ts` | C 端客服 LLM prompt「你是酒店前台客服」、弱词表酒店词、中置信提示「联系前台」 | 「你是智能客服」、中性弱词表、「联系客服」 |
| 12 | P1 | `packages/shared/src/enums.ts` `event-schema.ts` | `HOTEL_AGENT_KINDS` 导出与「酒店版/酒店=房型房价」注释（D18 注释同责） | `AGENT_KINDS`（零消费方，安全改名）+ 注释中性化（行业字段由 bundle 扩展） |
| 13 | P1 | 底座 9 处注释 | inspection/model-router/night-shift/workdata/audit-core(SKU 示例)/runtime ask 注释列举具体行业 | 全部改「内置/通用/行业包」中性表述（audit-core 主体已由仓库维护者预中性化，本处仅补 SKU 示例一处） |
| 14 | P2 | `apps/web/src/pages/p8/P8.tsx` `p22/P22.tsx` | 「Agent ID」英文直出；官网源 placeholder `hotel.example.com` | 「员工编号」；`https://www.example.com` |
| 15 | 治理 | `packages/base/captain/captain.test.ts` `captain-v2.test.ts` | 断言绑死默认值魔法数（5000/2500/3000/12000…）——默认值行业化调整即破；`ota-operations` 酒店角色名 | 引入 `CAP = defaultCharter().autonomy.procurement_cap`，断言全部动态化；角色名改 `channel-operations`（charter.ts 默认值 5000/2000 基座不动） |
| 16 | 治理 | `scripts/suite.ts`（12 处） | NLU 意图分类夹具残留酒店句式（OCC/入住率/保底价/满房/房价/关房/小红书文案/雅致大床房）；工具名 pms.\* | 替换为中性经营句式（营收/订单量/毛利红线/缺货/售价/下架/促销文案/主打款），路由语义不变；工具名同步 biz.\* |
| 17 | 治理 | 底座测试夹具（6 文件） | service-dialog/service-kb/service-ticket/inspection 测试夹具全量酒店场景（云栖住客须知/退房/早餐/房型/客房部） | 随源码中性化同步改写为通用服务场景（顾客须知/退换/会员/品类/配送组），断言语义不变 |

## 三、豁免判定摘录（代表性）

- **CI 连接串**（.github/workflows/ci.yml）：CI 环境 postgres service 标准做法
- **本地开发脚本**（doctor.sh/reset.sh/preview-all.sh/dev-note.js 等）：localhost 提示与默认值，均有 env 兜底
- **第三方官方端点**（api.weixin.qq.com、api.deepseek.com 等 LLM 预设、npm/镜像源）：产品预设或工具链地址，非硬编码缺陷
- **dsh-gate 127.0.0.1:8799**：local-first 架构的本机 gate 地址，有意设计
- **charter.ts 默认值 5000/2000**：基座行业无关，默认值行业化由行业包 seed 覆盖（电商仓 100000/50000 即行业包口径）；测试已 CAP 动态化，行业包调默认值不再破测试
- **E8.3 校准系数 ×2**：驳回降权的产品逻辑常量，有注释依据
- **scripts/demo.ts / release-gate.ts / eval/**：演示与冒烟脚本（白名单），酒店演示数据集为本仓内置 demo，与 seed 同源
- **bundles/hotel**：行业包本体——行业词住在行业包里是设计本意（D2 槽位），非底座泄漏
- **room_price / RT-DLX-KING 等标识符**：内置示例 bundle 的对象型槽位与种子围栏 scope 同源，改名将断种子围栏匹配；语义行业化经 bundle 扩展机制覆盖
- **suite 保底价 R2 熔断用例**：测的是种子围栏规则本体（与 seed 同源），非句式夹具
- **「API Key」「美团」（tools 默认渠道）**：通用术语/示例渠道名（与电商仓同口径保留）

## 四、验证

- `pnpm -C packages/base typecheck` + `test`：**385/385 全绿**（含 captain 动态化断言；75 条 DB 集成用例按 RUN_DB_TESTS 门槛跳过同基线）
- `pnpm typecheck`：7 包全绿
- `pnpm suite`：**445/445 全绿**（独立库 workloom_im；注：8787 端口被他仓残留 dev server 占用会导致 H 段误打到别的库，已清场后复跑全绿）

## 五、后续纪律

- `scripts/hardcode-scan.mjs` 已入仓——六类维度一键复扫，可作为 CI 防回归门禁（`node scripts/hardcode-scan.mjs .`）
- 默认值调整时**禁止**在测试中写死具体数值——一律动态引用（CAP 模式）
- 底座新增代码（packages/base、runtime、shared、db）**禁止**出现行业词，注释同责（D18）；行业语义一律经 bundle/seed 槽位注入
