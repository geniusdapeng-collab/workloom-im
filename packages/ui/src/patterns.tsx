import type { ReactNode } from "react";
import { Badge, Card } from "./components";
import { clientIdentifierText } from "./language";

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

const RISK_LABELS: Readonly<Record<RiskLevel, string>> = {
  none: "未发现风险",
  low: "低风险",
  medium: "中风险",
  high: "高风险",
  critical: "紧急风险",
};

const RISK_TONES: Readonly<Record<RiskLevel, "neutral" | "info" | "warning" | "danger">> = {
  none: "neutral",
  low: "info",
  medium: "warning",
  high: "danger",
  critical: "danger",
};

export function FenceBadge({ risk, label }: { risk: RiskLevel; label?: string }) {
  return <Badge tone={RISK_TONES[risk]}>{label ?? RISK_LABELS[risk]}</Badge>;
}

export function ModelBadge({ model, fallbackReason }: { model?: string; fallbackReason?: string }) {
  return (
    <span className="wl-model-badge">
      <strong>{model?.trim() || "模型待确认"}</strong>
      {fallbackReason && <span>已切换：{fallbackReason}</span>}
    </span>
  );
}

export interface TenantScopeProps {
  tenant: string;
  workspace: string;
  environment: "demo" | "configuring" | "test" | "pilot" | "active" | "rollback" | "unknown";
}

const ENVIRONMENT_LABELS: Readonly<Record<TenantScopeProps["environment"], string>> = {
  demo: "演示环境",
  configuring: "配置中",
  test: "测试环境",
  pilot: "灰度运行",
  active: "正式运行",
  rollback: "正在回滚",
  unknown: "环境待确认",
};

export function TenantScope({ tenant, workspace, environment }: TenantScopeProps) {
  return (
    <div className="wl-tenant-scope" aria-label="当前租户与工作区范围">
      <span><strong>租户</strong>{tenant || "待确认"}</span>
      <span><strong>工作区</strong>{workspace || "待确认"}</span>
      <Badge tone={environment === "active" ? "success" : environment === "unknown" || environment === "rollback" ? "danger" : "warning"}>
        {ENVIRONMENT_LABELS[environment]}
      </Badge>
    </div>
  );
}

export interface ReceiptLinkProps {
  eventId?: string;
  requestId?: string;
  onOpen?: () => void;
}

export function ReceiptLink({ eventId, requestId, onOpen }: ReceiptLinkProps) {
  const id = eventId || requestId;
  if (!id) return <span className="wl-receipt wl-receipt--missing">回执待确认</span>;
  const content = <><span>{eventId ? "事件账本回执" : "任务请求回执"}</span><code>{clientIdentifierText(id)}</code></>;
  return onOpen
    ? <button type="button" className="wl-receipt wl-receipt--button" onClick={onOpen}>{content}</button>
    : <span className="wl-receipt">{content}</span>;
}

export interface AgentWorkCardModel {
  id: string;
  actor: string;
  humanOwner?: string;
  goal: string;
  stage: string;
  progress?: { completed: number; total?: number; next?: string };
  reason?: string;
  needsHuman?: { action: string; due?: string; consequence?: string };
  risk?: RiskLevel;
  fence?: string;
  model?: string;
  fallbackReason?: string;
  receipt?: { eventId?: string; requestId?: string; updatedAt?: string };
  recovery?: string;
}

export function AgentWorkCard({ work, actions }: { work: AgentWorkCardModel; actions?: ReactNode }) {
  const total = work.progress?.total;
  const completed = work.progress?.completed ?? 0;
  const percentage = total && total > 0 ? Math.min(100, Math.max(0, Math.round((completed / total) * 100))) : undefined;
  return (
    <Card className="wl-agent-work-card" data-wl-pattern="agent-work-card">
      <header className="wl-pattern-header">
        <div>
          <p className="wl-pattern-eyebrow">{work.actor}{work.humanOwner ? ` · 人类责任人 ${work.humanOwner}` : ""}</p>
          <h3>{work.goal}</h3>
        </div>
        <FenceBadge risk={work.risk ?? "none"} />
      </header>
      <div className="wl-work-stage">
        <span><strong>当前阶段</strong>{work.stage}</span>
        {work.progress && <span><strong>进度</strong>{total ? `${completed}/${total}` : `${completed} 项已完成`}</span>}
      </div>
      {percentage !== undefined && <progress value={percentage} max={100} aria-label={`任务进度 ${percentage}%`} />}
      {work.progress?.next && <p><strong>下一步：</strong>{work.progress.next}</p>}
      {work.reason && <p><strong>依据：</strong>{work.reason}</p>}
      {work.needsHuman && (
        <section className="wl-human-needed" aria-label="需要人类处理">
          <strong>需要你处理：{work.needsHuman.action}</strong>
          {work.needsHuman.due && <span>截止时间：{work.needsHuman.due}</span>}
          {work.needsHuman.consequence && <span>未处理影响：{work.needsHuman.consequence}</span>}
        </section>
      )}
      {(work.fence || work.model || work.fallbackReason) && (
        <div className="wl-pattern-meta">
          {work.fence && <span>命中围栏：{work.fence}</span>}
          {(work.model || work.fallbackReason) && <ModelBadge model={work.model} fallbackReason={work.fallbackReason} />}
        </div>
      )}
      <footer className="wl-pattern-footer">
        <ReceiptLink eventId={work.receipt?.eventId} requestId={work.receipt?.requestId ?? work.id} />
        {work.receipt?.updatedAt && <span>更新于 {work.receipt.updatedAt}</span>}
        {work.recovery && <span>恢复方式：{work.recovery}</span>}
      </footer>
      {actions && <HumanActionBar>{actions}</HumanActionBar>}
    </Card>
  );
}

export function EvidenceList({ items }: { items: readonly { title: string; detail?: string; source?: string }[] }) {
  return (
    <ul className="wl-evidence-list">
      {items.map((item, index) => (
        <li key={`${item.title}-${index}`}>
          <strong>{item.title}</strong>
          {item.detail && <span>{item.detail}</span>}
          {item.source && <span>来源：{item.source}</span>}
        </li>
      ))}
    </ul>
  );
}

export interface DecisionPackageModel {
  title: string;
  action: string;
  summary: string;
  before?: ReactNode;
  after?: ReactNode;
  evidence?: readonly { title: string; detail?: string; source?: string }[];
  risk: RiskLevel;
  fence?: string;
  memory?: string;
  model?: string;
  impact: string;
  rollback: string;
  eventId?: string;
}

export function DecisionPackage({ decision, actions }: { decision: DecisionPackageModel; actions?: ReactNode }) {
  return (
    <Card className="wl-decision-package" data-wl-pattern="decision-package">
      <header className="wl-pattern-header"><div><p className="wl-pattern-eyebrow">待人类裁决</p><h3>{decision.title}</h3></div><FenceBadge risk={decision.risk} /></header>
      <dl className="wl-decision-grid">
        <div><dt>拟执行动作</dt><dd>{decision.action}</dd></div>
        <div><dt>决策摘要</dt><dd>{decision.summary}</dd></div>
        {decision.before !== undefined && <div><dt>变更前</dt><dd>{decision.before}</dd></div>}
        {decision.after !== undefined && <div><dt>变更后</dt><dd>{decision.after}</dd></div>}
        <div><dt>影响范围</dt><dd>{decision.impact}</dd></div>
        <div><dt>回滚方式</dt><dd>{decision.rollback}</dd></div>
        {decision.fence && <div><dt>命中围栏</dt><dd>{decision.fence}</dd></div>}
        {decision.memory && <div><dt>记忆依据</dt><dd>{decision.memory}</dd></div>}
        {decision.model && <div><dt>实际模型</dt><dd>{decision.model}</dd></div>}
      </dl>
      {decision.evidence && decision.evidence.length > 0 && <><h4 className="wl-pattern-subtitle">证据</h4><EvidenceList items={decision.evidence} /></>}
      <footer className="wl-pattern-footer"><ReceiptLink eventId={decision.eventId} /></footer>
      {actions && <HumanActionBar>{actions}</HumanActionBar>}
    </Card>
  );
}

export function HumanActionBar({ children }: { children: ReactNode }) {
  return <div className="wl-human-action-bar" aria-label="人类可执行操作">{children}</div>;
}

export interface LedgerTimelineItem {
  id: string;
  action: string;
  actor: string;
  time: string;
  result?: string;
  verified?: boolean;
}

export function LedgerTimeline({ items }: { items: readonly LedgerTimelineItem[] }) {
  return (
    <ol className="wl-ledger-timeline">
      {items.map((item) => <li key={item.id}><div><strong>{item.action}</strong><span>{item.actor} · {item.time}</span>{item.result && <p>{item.result}</p>}</div><div><Badge tone={item.verified ? "success" : "warning"}>{item.verified ? "链路已验证" : "等待验链"}</Badge><ReceiptLink eventId={item.id} /></div></li>)}
    </ol>
  );
}

export function ExamGate({ status, version, subjectHash, updatedAt }: { status: "passed" | "failed" | "pending" | "blocked"; version?: string; subjectHash?: string; updatedAt?: string }) {
  const label = status === "passed" ? "考试已通过，可进入灰度" : status === "failed" ? "考试未通过，禁止晋级" : status === "blocked" ? "考试门禁已阻断" : "等待考试";
  return <Card className="wl-trust-state"><div className="wl-pattern-header"><h3>考试门禁</h3><Badge tone={status === "passed" ? "success" : status === "pending" ? "warning" : "danger"}>{label}</Badge></div><div className="wl-pattern-meta">{version && <span>题集版本：{version}</span>}{subjectHash && <span>装配版本：{subjectHash}</span>}{updatedAt && <span>更新于 {updatedAt}</span>}</div></Card>;
}

export function MemorySource({ source, scope, confidence, sensitive }: { source: string; scope: string; confidence?: number; sensitive?: boolean }) {
  return <div className="wl-memory-source"><strong>记忆来源：{source}</strong><span>适用范围：{scope}</span>{confidence !== undefined && <span>置信度：{Math.round(confidence * 100)}%</span>}{sensitive && <Badge tone="warning">敏感内容</Badge>}</div>;
}

export function NightShiftStatus({ status, owner, nextRun, needsHuman = 0 }: { status: string; owner?: string; nextRun?: string; needsHuman?: number }) {
  return <Card className="wl-trust-state"><div className="wl-pattern-header"><h3>夜班状态</h3><Badge tone={status.includes("失败") ? "danger" : needsHuman > 0 ? "warning" : "info"}>{status || "状态待确认"}</Badge></div><div className="wl-pattern-meta">{owner && <span>值班责任人：{owner}</span>}{nextRun && <span>下次运行：{nextRun}</span>}<span>需要人工处理：{needsHuman} 项</span></div></Card>;
}

export function MetricCard({ label, value, period, source, updatedAt, delta }: { label: string; value: ReactNode; period: string; source: string; updatedAt: string; delta?: string }) {
  return <Card className="wl-metric-card"><span>{label}</span><strong>{value}</strong>{delta && <Badge tone={delta.startsWith("-") ? "warning" : "info"}>{delta}</Badge>}<footer><span>范围：{period}</span><span>来源：{source}</span><span>更新于 {updatedAt}</span></footer></Card>;
}
