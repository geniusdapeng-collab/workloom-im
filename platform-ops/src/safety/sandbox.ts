/**
 * safety/sandbox —— 沙箱验证（对焦方案 §2.4 G5 闸）
 *
 * 声明式场景剧本：变更合入前在隔离环境跑端到端剧本，验证"新功能在真实流程里不闯祸"。
 * 剧本步骤为确定性操作（建单/注入需求/触发围栏/对账），每步带断言；
 * 任一断言失败即 G5 不通过。环境由 CI 以 docker-compose 提供（本模块只负责剧本执行与判定）。
 */

export interface SandboxStep {
  name: string;
  /** 操作：对环境执行一个确定性动作，返回动作结果摘要 */
  act: (env: SandboxEnv) => Promise<Record<string, unknown>>;
  /** 断言：对动作结果的硬性检查（全部通过该步才算过） */
  assert?: Array<{ desc: string; check: (result: Record<string, unknown>) => boolean }>;
}

export interface SandboxScenario {
  id: string;            // 如 S-1 / S-2
  title: string;
  steps: SandboxStep[];
}

/** 沙箱环境接口（CI：真实隔离环境适配器；测试：内存假环境） */
export interface SandboxEnv {
  call(service: string, action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 场景间隔离：每个场景开始时重置种子数据 */
  reset(seedProfile: string): Promise<void>;
}

export interface SandboxReport {
  scenarioId: string;
  pass: boolean;
  steps: Array<{ name: string; pass: boolean; failures: string[] }>;
  durationMs: number;
}

export async function runScenario(env: SandboxEnv, sc: SandboxScenario, now: () => number = () => Date.now()): Promise<SandboxReport> {
  const start = now();
  await env.reset(sc.id);
  const steps: SandboxReport["steps"] = [];
  for (const step of sc.steps) {
    const failures: string[] = [];
    try {
      const result = await step.act(env);
      for (const a of step.assert ?? []) {
        if (!a.check(result)) failures.push(a.desc);
      }
    } catch (err) {
      failures.push(`步骤异常：${err instanceof Error ? err.message : String(err)}`);
    }
    steps.push({ name: step.name, pass: failures.length === 0, failures });
    if (failures.length > 0) break; // fail-fast：后续步骤前置已破坏，不刷无效红灯
  }
  return { scenarioId: sc.id, pass: steps.every((s) => s.pass), steps, durationMs: now() - start };
}

/* ---------------- 内置剧本：S-1/S-2（PRD 演示场景的安全版） ---------------- */

/**
 * S-1 需求全闭环剧本：客户提需求 → 澄清 → 确认单 → 注入研发（人审闸）→ 状态回传 → 交付关单。
 * 安全断言聚焦"闸门都在"：未经客户确认不得注入、未经 PM 审批不得进流水线。
 */
export function scenarioS1(): SandboxScenario {
  return {
    id: "S-1",
    title: "需求全闭环（闸门在位验证）",
    steps: [
      {
        name: "客户提出需求（一句话）",
        act: (env) => env.call("ticket", "create", { intent: "feature_request", text: "决策包按楼层拆分" }),
        assert: [{ desc: "工单已建且意图正确", check: (r) => r.ticket_id !== undefined && r.intent === "feature_request" }],
      },
      {
        name: "未经客户确认尝试注入研发（应被拒）",
        act: (env) => env.call("aipm", "inject", { confirmed: false }),
        assert: [{ desc: "未确认注入被拒绝（客户显式确认是唯一闸门）", check: (r) => r.injected === false && r.reason === "customer-not-confirmed" }],
      },
      {
        name: "澄清四轮 + 产出《需求确认单》+ 客户确认",
        act: (env) => env.call("requirement", "confirm", { clarify: ["场景", "使用者", "验收", "约束"], customerConfirmed: true }),
        assert: [{ desc: "确认单三方绑定（原文+确认记录+关联工单）", check: (r) => r.bound === true }],
      },
      {
        name: "未经 PM 审批尝试进流水线（应被 R-PL3 拦）",
        act: (env) => env.call("aipm", "inject", { confirmed: true, pmApproved: false }),
        assert: [{ desc: "未审批注入被围栏拦截（review）", check: (r) => r.fenceVerdict === "review" }],
      },
      {
        name: "PM 审批后注入 + 状态回传 + 交付关单",
        act: (env) => env.call("aipm", "inject", { confirmed: true, pmApproved: true }),
        assert: [
          { desc: "ticket↔requirement 双向关联建立", check: (r) => r.linked === true },
          { desc: "状态回传客户", check: (r) => r.callbackSent === true },
        ],
      },
    ],
  };
}

/**
 * S-2 故障应急剧本：客户报障 → 直通运维 → 分级（P2 不叫醒）→ 复盘 → 知识沉淀。
 * 安全断言聚焦"分级聚合纪律"与"告警闭环回流知识库"。
 */
export function scenarioS2(): SandboxScenario {
  return {
    id: "S-2",
    title: "故障应急（分级聚合与知识回流验证）",
    steps: [
      {
        name: "客户报障（自动收集实例号+时间窗）",
        act: (env) => env.call("ticket", "create", { intent: "bug_report", text: "数字员工两小时无响应" }),
        assert: [{ desc: "故障工单直通运维组且首响计时启动", check: (r) => r.routed === "incident-responder" && r.slaDeadlineMs === 300_000 }],
      },
      {
        name: "供应商故障但自动切换成功（应判 P2 不叫醒）",
        act: (env) => env.call("incident", "classify", { providerDown: true, failoverOk: true, userImpact: false }),
        assert: [{ desc: "分级为 P2 进晨报，不电话值班人", check: (r) => r.level === "P2" && r.pageOncall === false }],
      },
      {
        name: "影响面扩大（应升 P0 三通道告警）",
        act: (env) => env.call("incident", "classify", { providerDown: true, failoverOk: false, userImpact: true }),
        assert: [{ desc: "升级为 P0 且电话+短信+WS 三通道", check: (r) => r.level === "P0" && (r.channels as string[])?.length === 3 }],
      },
      {
        name: "复盘产出知识条目（告警闭环回流）",
        act: (env) => env.call("kb", "harvest", { source: "postmortem" }),
        assert: [{ desc: "复盘知识条目进入待审队列（R-PL8）", check: (r) => r.draftCreated === true && r.pendingReview === true }],
      },
    ],
  };
}

/** G5 闸入口：跑全部内置剧本，全过才放行 */
export async function runSandboxGate(env: SandboxEnv): Promise<{ pass: boolean; reports: SandboxReport[]; summary: string }> {
  const reports: SandboxReport[] = [];
  for (const sc of [scenarioS1(), scenarioS2()]) {
    reports.push(await runScenario(env, sc));
  }
  const pass = reports.every((r) => r.pass);
  const failed = reports.filter((r) => !r.pass).map((r) => `${r.scenarioId}(${r.steps.find((s) => !s.pass)?.failures.join("、")})`);
  return { pass, reports, summary: pass ? `沙箱剧本 ${reports.length}/${reports.length} 全过` : `沙箱失败：${failed.join("；")}` };
}
