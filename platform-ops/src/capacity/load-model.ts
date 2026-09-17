/**
 * capacity/load-model —— 容量模型与伸缩阶梯（PRD V3.0 第二十一章）
 *
 * 把"万级租户"翻译成数字：负载模型常量为单一事实源；
 * 水位检项（§18.4 平台基础设施域）按模型阈值判定 P1/P2；
 * 伸缩阶梯：起步 <500 / 成长 500-3000 / 规模 3000-10000 / 超规模 >50000（预案）。
 */

/** §21.1 负载模型（基准 10,000 租户） */
export const LOAD_MODEL = {
  tenantsBaseline: 10_000,
  dailyTickets: 50_000,            // 万租户 × 均 5 单/日
  dailyBizEvents: 1_500_000,       // 工单均 30 事件
  dailyEventsWithTelemetry: 4_000_000,
  peakWriteTps: 500,               // 均值 46 × 10 倍峰值系数
  writeTpsCapacity: 2000,          // 单 PG + 分区 + 租户粒度 advisory 锁（4 倍余量）
  peakReadQps: 3000,               // 积分余额/在线状态/工单列表
  pushConnsPlatform: 2_000,
  pushConnsCustomer: 50_000,
  ingestPeakRps: 200,
  eventRowBytes: 2560,             // ~2.5KB/行
  dailyStorageBytes: 10 * 1024 ** 3, // ~10GB/日
  hotRetentionMonths: 13,
} as const;

/** §21.3 伸缩阶梯 */
export type ScaleTier = "bootstrap" | "growth" | "scale" | "hyper";

export function scaleTierFor(tenants: number): ScaleTier {
  if (tenants < 500) return "bootstrap";
  if (tenants < 3_000) return "growth";
  if (tenants <= 10_000) return "scale";
  return "hyper";
}

export const TIER_ACTIONS: Record<ScaleTier, string[]> = {
  bootstrap: ["单 PG + Redis 单节点 + JetStream 单机 + 流处理器×2", "ClickHouse 退化为 PG 物化视图（接口不变）"],
  growth:    ["Redis Sentinel 三节点", "JetStream 集群化", "PG 只读副本×1", "push-gateway 独立部署"],
  scale:     ["分区全量", "ClickHouse 2×2", "只读副本×2", "HPA 全量启用"],
  hyper:     ["按租户组分库（RLS 与路由已预留）", "Kafka 评估", "单元化部署"],
};

/** 水位检项（§18.4：容量类 P2 起步，主从延迟 >30s 升 P1） */
export interface WaterLevel {
  check: string;
  value: number;
  thresholdP2: number;
  thresholdP1?: number;
  unit: string;
}

export function waterLevels(measured: {
  pgReplicationLagSec?: number;
  jetstreamBacklog?: number;
  redisMemoryRatio?: number;
  pushGatewayConns?: number;
  diskRatio?: number;
  writeTps?: number;
}): WaterLevel[] {
  const out: WaterLevel[] = [];
  if (measured.pgReplicationLagSec !== undefined) {
    out.push({ check: "pg_replication_lag", value: measured.pgReplicationLagSec, thresholdP2: 10, thresholdP1: 30, unit: "s" });
  }
  if (measured.jetstreamBacklog !== undefined) {
    out.push({ check: "jetstream_backlog", value: measured.jetstreamBacklog, thresholdP2: 20_000, thresholdP1: 50_000, unit: "条" }); // >5万触发 HPA 扩容
  }
  if (measured.redisMemoryRatio !== undefined) {
    out.push({ check: "redis_memory", value: measured.redisMemoryRatio, thresholdP2: 0.7, thresholdP1: 0.85, unit: "ratio" });
  }
  if (measured.pushGatewayConns !== undefined) {
    out.push({ check: "push_gateway_conns", value: measured.pushGatewayConns, thresholdP2: 40_000, thresholdP1: 48_000, unit: "conn" });
  }
  if (measured.diskRatio !== undefined) {
    out.push({ check: "disk", value: measured.diskRatio, thresholdP2: 0.75, thresholdP1: 0.9, unit: "ratio" });
  }
  if (measured.writeTps !== undefined) {
    out.push({ check: "write_tps", value: measured.writeTps, thresholdP2: LOAD_MODEL.writeTpsCapacity * 0.5, thresholdP1: LOAD_MODEL.writeTpsCapacity * 0.75, unit: "tps" });
  }
  return out;
}

export function levelOf(w: WaterLevel): "ok" | "P2" | "P1" {
  if (w.thresholdP1 !== undefined && w.value > w.thresholdP1) return "P1";
  if (w.value > w.thresholdP2) return "P2";
  return "ok";
}
