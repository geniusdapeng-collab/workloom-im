/** IM diagnostics preserve a fixed category and numeric HTTP status, never an upstream body/cause. */
export interface SafeChannelDiagnostic {
  category: "timeout" | "upstream_authentication" | "upstream_quota" | "upstream_unavailable" | "upstream_http" | "upstream_unknown";
  httpStatus?: number;
}

function dataProperty(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    for (let current: object | null = value, depth = 0; current && depth < 5; current = Object.getPrototypeOf(current) as object | null, depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    }
  } catch { return undefined; }
  return undefined;
}

export function safeChannelDiagnostic(error: unknown): SafeChannelDiagnostic {
  const httpStatus = [dataProperty(error, "status"), dataProperty(error, "statusCode")]
    .find((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
  const code = dataProperty(error, "code");
  const name = dataProperty(error, "name");
  const category: SafeChannelDiagnostic["category"] = typeof code === "string" && ["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNABORTED", "ABORT_ERR"].includes(code) || typeof name === "string" && ["AbortError", "TimeoutError"].includes(name) ? "timeout"
    : httpStatus === 401 || httpStatus === 403 ? "upstream_authentication"
      : httpStatus === 429 ? "upstream_quota"
        : httpStatus !== undefined && httpStatus >= 500 ? "upstream_unavailable"
          : httpStatus !== undefined && httpStatus >= 400 ? "upstream_http" : "upstream_unknown";
  return { category, ...(httpStatus === undefined ? {} : { httpStatus }) };
}

export function channelDiagnosticText(diagnostic: SafeChannelDiagnostic): string {
  return `${diagnostic.category}${diagnostic.httpStatus === undefined ? "" : `；HTTP ${diagnostic.httpStatus}`}`;
}

export function safeChannelLabel(channel: string): string {
  return ["inapp", "dingtalk", "wecom", "feishu"].includes(channel) ? channel : "unknown";
}

/** No cause field: logging this error cannot accidentally serialize the original exception. */
export class ChannelRecordingError extends Error {
  readonly diagnostic: SafeChannelDiagnostic;
  constructor(error: unknown) {
    const diagnostic = safeChannelDiagnostic(error);
    super(`卡片已外发但留痕及补偿写入失败，需要对账（${channelDiagnosticText(diagnostic)}）`);
    this.name = "ChannelRecordingError";
    this.diagnostic = Object.freeze(diagnostic);
  }
}
