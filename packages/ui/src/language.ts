/**
 * 客户端中文显示边界。
 *
 * API/数据库字段只能作为内部数据锚点；进入客户端前必须通过本词典映射。
 * 未登记字段在普通模式下统一显示为“扩展信息”，避免把 snake_case、camelCase
 * 或后端枚举直接泄露给业务用户。授权诊断界面可显式开启 diagnostic。
 */

const FIELD_LABELS: Readonly<Record<string, string>> = {
  id: "编号",
  event_id: "事件编号",
  thread_id: "任务编号",
  task_id: "任务编号",
  ticket_id: "工单编号",
  member_id: "成员编号",
  workspace_id: "工作区",
  tenant_id: "租户",
  bundle_id: "行业包",
  bundle_version: "行业包版本",
  preset_key: "岗位",
  role_title: "岗位名称",
  rule_id: "规则",
  rule_impact: "规则影响",
  status: "状态",
  status_text: "状态",
  result: "结果",
  verdict: "结论",
  version: "版本",
  name: "名称",
  title: "标题",
  description: "说明",
  detail: "详情",
  note: "备注",
  memo: "说明",
  reason: "原因",
  reason_text: "原因说明",
  kind: "类型",
  type: "类型",
  level: "级别",
  risk: "风险",
  confidence: "置信度",
  score: "得分",
  total_score: "总分",
  before: "调整前",
  after: "调整后",
  params: "参数",
  payload: "业务内容",
  input: "输入",
  output: "输出",
  actor: "执行者",
  source: "来源",
  provider: "模型服务",
  model: "模型",
  created_at: "创建时间",
  updated_at: "更新时间",
  started_at: "开始时间",
  completed_at: "完成时间",
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  active: "已启用",
  inactive: "未启用",
  enabled: "已启用",
  disabled: "已停用",
  pending: "待处理",
  pending_review: "待审核",
  review: "待审核",
  approved: "已批准",
  rejected: "已驳回",
  reject: "驳回",
  allow: "允许",
  allowed: "已允许",
  deny: "禁止",
  denied: "已禁止",
  pass: "通过",
  passed: "已通过",
  fail: "未通过",
  failed: "失败",
  running: "运行中",
  paused: "已暂停",
  completed: "已完成",
  done: "已完成",
  queued: "排队中",
  draft: "草案",
  simulated: "演示模式",
  real: "正式模式",
  unknown: "待确认",
  staged: "待装配",
  assigned: "已分派",
  ready: "已就绪",
  read: "已读",
  acted: "已处理",
  planned: "已计划",
  anomaly: "发现异常",
  nodata: "暂无数据",
  offline: "离线",
  online: "在线",
  succeeded: "已成功",
  suspended: "已挂起",
  recalled: "已召回",
  open: "处理中",
  created: "已创建",
  sent: "已发送",
  delivered: "已送达",
  in_progress: "进行中",
  cancelled: "已取消",
  canceled: "已取消",
};

const VALUE_LABELS: Readonly<Record<string, string>> = {
  ...STATUS_LABELS,
  standard: "标准档",
  economy: "经济档",
  premium: "高质量档",
  fast: "快速档",
  balanced: "均衡档",
  quality: "质量优先",
  community: "社区版",
  pro: "专业版",
  teams: "团队版",
  vpc: "专有部署版",
  owner: "负责人",
  manager: "管理员",
  staff: "成员",
  readonly: "只读成员",
  high: "高",
  medium: "中",
  low: "低",
  official: "官方",
  team: "团队",
  industry: "行业共享",
  stable: "稳定运行",
  onboarding: "开通配置中",
  trial: "试运行",
  production: "正式运行",
};

export interface ClientFieldOptions {
  /** 仅供授权诊断界面使用；普通客户端禁止开启。 */
  diagnostic?: boolean;
  /** 未登记字段的中文兜底。 */
  fallbackLabel?: string;
}

export interface ClientFieldEntry {
  label: string;
  value: string;
  /** 只在 diagnostic=true 时返回，便于受控排障。 */
  internalKey?: string;
}

function normalizeKey(key: string): string {
  return key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[.\-\s]+/g, "_")
    .toLowerCase();
}

const RAW_MACHINE_TEXT = /\b(?:bundle_id|bundleId|event_id|fence_bindings|preset_key|reasonEnum|request_id|tenant_id|workspace_id|SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|Internal Server Error)\b/i;
const ENGINEERING_TEXT = /(?:^|[^A-Za-z0-9])(?:P|F|E|L)\d+(?:\.\d+)?(?:$|[^A-Za-z0-9])/;
const SAFE_UNAVOIDABLE_TERM = /^(?:AI|API|H5|OAuth|SLA|URL|WorkLoom)$/i;
const RAW_FIELD_TOKEN = /(?:^|[^A-Za-z0-9])(?:[a-z][a-z0-9]*_[a-z0-9_]+|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+)(?=$|[^A-Za-z0-9])/;
const CLIENT_LATIN_TOKEN = /(?:[A-Za-z][A-Za-z0-9]*|[0-9]+[A-Za-z][A-Za-z0-9]*)(?:[.-][A-Za-z0-9]+)*/g;
const SAFE_CLIENT_LATIN_TERMS = new Set([
  "3D", "AI", "API", "B", "C", "DSL", "GEO", "H5", "IM", "KPI", "LLM", "MVP", "OAuth",
  "PC", "RLS", "ROI", "SLA", "URL", "WorkLoom",
]);

function hasUnknownLatinTerm(text: string): boolean {
  const tokens = text.match(CLIENT_LATIN_TOKEN) ?? [];
  return tokens.some((token) =>
    !SAFE_CLIENT_LATIN_TERMS.has(token)
    && !/^v\d+(?:\.\d+)*$/i.test(token)
    // 用户可核对的业务编号不是代码字段；仅允许大写短前缀 + 数字段，
    // 小写内部主键、snake_case、camelCase 仍会被前置规则拦截。
    && !/^(?:[A-Z]{1,8}-?\d{1,20}|[A-Z]{1,8}(?:-\d{1,20}){2,})$/.test(token),
  );
}

function unsafeMachineText(text: string): boolean {
  return RAW_MACHINE_TEXT.test(text)
    || RAW_FIELD_TOKEN.test(text)
    || ENGINEERING_TEXT.test(text)
    || /^[\[{][\s\S]*[\]}]$/.test(text)
    || (/[㐀-鿿]/.test(text) && hasUnknownLatinTerm(text));
}

export function isKnownClientField(key: string): boolean {
  return Object.hasOwn(FIELD_LABELS, normalizeKey(key));
}

export function clientFieldLabel(key: string, options: ClientFieldOptions = {}): string {
  const normalized = normalizeKey(key);
  const known = FIELD_LABELS[normalized];
  if (known) return known;
  if (options.diagnostic) return key;
  return options.fallbackLabel ?? "扩展信息";
}

export function clientStatusLabel(value: string): string {
  const normalized = normalizeKey(value);
  return STATUS_LABELS[normalized] ?? (/[一-鿿]/.test(value) && !unsafeMachineText(value) ? value.trim() : "状态待确认");
}

/**
 * 把数据库主键、请求追踪号等内部标识转换为可核对但不可反推结构的客户端回执。
 * 仅保留末尾连续数字；UUID、哈希、带业务前缀的主键不会原样进入普通客户端。
 */
export function clientIdentifierText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "编号待确认";
  const suffix = value.trim().match(/(\d{2,6})$/)?.[1];
  return suffix ? `尾号 ${suffix}` : "编号已记录";
}

export function clientValueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "暂无";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return new Intl.NumberFormat("zh-CN").format(value);
  if (typeof value === "string") {
    const text = value.trim();
    const normalized = normalizeKey(text);
    const known = VALUE_LABELS[normalized];
    if (known) return known;
    if (!text || unsafeMachineText(text)) return "信息待确认";
    // 普通客户端以中文为默认展示边界；数字、日期、金额和极少量行业通用缩写可保留。
    if (/[\u3400-\u9fff]/.test(text)) return text;
    if (/^[\d\s.,:%+\-/¥￥()]+$/.test(text) || SAFE_UNAVOIDABLE_TERM.test(text)) return text;
    return "信息待确认";
  }
  if (Array.isArray(value)) return value.length === 0 ? "暂无" : `${value.length} 项`;
  if (typeof value === "object") return `${Object.keys(value as object).length} 项信息`;
  return String(value);
}

/**
 * 服务端或行业包提供的自然语言只能在通过中文展示边界后进入普通客户端。
 * 该函数专用于说明、标题、问题等自然语言，不用于用户自行输入的原文，也不
 * 用于受控诊断界面。未知英文、工程代号、字段名和 JSON 一律使用中文兜底。
 */
export function clientChineseText(value: unknown, fallback = "信息待确认"): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  if (!text || !/[\u3400-\u9fff]/.test(text)) return fallback;
  if (unsafeMachineText(text)) return fallback;
  return text;
}

export function clientFieldEntries(
  record: Readonly<Record<string, unknown>>,
  options: ClientFieldOptions = {},
): ClientFieldEntry[] {
  return Object.entries(record).map(([key, value]) => ({
    label: clientFieldLabel(key, options),
    value: clientValueText(value),
    ...(options.diagnostic ? { internalKey: key } : {}),
  }));
}
