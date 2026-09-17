/**
 * streams/sla-timer —— SLA 延迟计时器（PRD V3.0 §16.4 / §17.4）
 *
 * 不做定时扫表：SLA 截止时刻作为延迟消息投入总线（deliver-at），到期触发检查事件；
 * 扫表只做兜底对账（每 10min，只读副本）。到期误差 SLO <30s。
 * 超时未解决 → 升级事件（故障类首响 ≤5min / 需求类澄清 ≤24h / 咨询类即时——PRD F3）。
 */
import type { EventBus } from "../bus/stream.js";

export interface SlaRule {
  intent: string;
  /** 截止时长（ms）：首响或处置 SLA */
  deadlineMs: number;
  escalateTo: string; // 升级对象（值班人/班组）
}

/** PRD F3 默认 SLA 表（intent → 首响时限） */
export const DEFAULT_SLA_RULES: SlaRule[] = [
  { intent: "bug_report",       deadlineMs: 5 * 60_000,        escalateTo: "incident-responder" },
  { intent: "complaint",        deadlineMs: 5 * 60_000,        escalateTo: "fae-chief" },
  { intent: "feature_request",  deadlineMs: 24 * 3_600_000,    escalateTo: "requirement-dispatcher" },
  { intent: "billing",          deadlineMs: 60_000,            escalateTo: "credit-reconciler" },
  { intent: "kb_qa",            deadlineMs: 30_000,            escalateTo: "fae-chief" },
];

export interface TicketState { ticketId: string; tenantId: string; status: string; intent: string }

export class SlaTimer {
  private scheduled = new Map<string, number>(); // ticketId → deadline

  constructor(private bus: EventBus, private rules: SlaRule[] = DEFAULT_SLA_RULES, private now: () => number = () => Date.now()) {}

  /** 建单即排程：deliver-at 延迟消息（§17.3 延迟消息替代扫表） */
  schedule(t: TicketState): number | null {
    const rule = this.rules.find((r) => r.intent === t.intent);
    if (!rule) return null;
    const deadline = this.now() + rule.deadlineMs;
    this.scheduled.set(t.ticketId, deadline);
    this.bus.publish("tickets-flow", `ticket.${t.tenantId}.${t.ticketId}`,
      { kind: "sla.check", ticket_id: t.ticketId, tenant_id: t.tenantId, escalate_to: rule.escalateTo },
      { deliverAt: deadline });
    return deadline;
  }

  /** 到期检查（消费 sla.check 消息时调用）：仍未解决 → 生成升级事件 */
  onDeadline(t: TicketState): { escalated: boolean; to?: string } {
    this.scheduled.delete(t.ticketId);
    if (["已解决", "已关单", "done", "closed"].includes(t.status)) return { escalated: false };
    const rule = this.rules.find((r) => r.intent === t.intent);
    const to = rule?.escalateTo ?? "fae-chief";
    this.bus.publish("ops-signals", `ops.sla.${t.ticketId}`, {
      kind: "sla.breach", ticket_id: t.ticketId, tenant_id: t.tenantId, escalate_to: to, level: "P1",
    });
    return { escalated: true, to };
  }

  /** 兜底对账（每 10min 只读副本扫表时调用）：检出"排程丢失"的工单 */
  reconcile(openTickets: TicketState[]): TicketState[] {
    const now = this.now();
    return openTickets.filter((t) => {
      const deadline = this.scheduled.get(t.ticketId);
      return deadline !== undefined && deadline < now; // 早该到期却还在排程表 = 延迟消息丢失
    });
  }
}
