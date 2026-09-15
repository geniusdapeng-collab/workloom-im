/**
 * 已验证活动 Bundle → 巡检行业适配器注册表。
 *
 * 数据库仅提供 active 安装事实；Bundle 清单必须先经过契约、兼容性、逐资产
 * 摘要及稳定版签名验证。未安装、冲突、投影损坏或未登记行业全部失败关闭，
 * 绝不回退到酒店示例巡检。
 */
import type { BundleUiProjection } from "@workloom/base/bundles";
import type { InspectionAdapter } from "@workloom/base/inspection";
import { BUNDLED_INSPECTION_ADAPTERS } from "../industry/inspection-adapter-catalog.js";
import {
  bindVerifiedActiveBundle,
  resolveWorkspaceActiveBundle,
  type WorkspaceBundleFacts,
} from "./active-bundle.js";

export interface InspectionAdapterRegistration {
  adapter: InspectionAdapter;
  bundleIds: readonly string[];
  trustedSignerKeyIds?: readonly string[];
}

function buildRegistry(registrations: readonly InspectionAdapterRegistration[]) {
  const byAdapterId = new Map<string, InspectionAdapterRegistration>();
  const adapterIds = new Set<string>();
  for (const registration of registrations) {
    if (!registration.adapter.id.trim() || !registration.bundleIds.length) {
      throw new Error("巡检行业适配器必须声明标识和允许的 Bundle");
    }
    if (adapterIds.has(registration.adapter.id)) {
      throw new Error(`巡检行业适配器重复登记：${registration.adapter.id}`);
    }
    adapterIds.add(registration.adapter.id);
    byAdapterId.set(registration.adapter.id, registration);
    for (const bundleId of registration.bundleIds) {
      if ([...byAdapterId.values()].some((item) => item !== registration && item.bundleIds.includes(bundleId))) {
        throw new Error(`行业包重复登记巡检适配器：${bundleId}`);
      }
    }
  }
  return byAdapterId;
}

const ADAPTERS_BY_ID = buildRegistry(BUNDLED_INSPECTION_ADAPTERS);

export type InspectionBindingState =
  | "ready"
  | "not-installed"
  | "bundle-mismatch"
  | "projection-invalid"
  | "inspection-disabled"
  | "adapter-not-declared"
  | "adapter-not-registered"
  | "adapter-untrusted";

export interface InspectionAdapterBinding {
  state: InspectionBindingState;
  adapter: InspectionAdapter | null;
  bundleId: string | null;
  installId: string | null;
  /** 只供服务端诊断，不能原样释放给客户端。 */
  reason: string;
}

type ProjectionLoader = (bundleId: string) => BundleUiProjection;

/** 纯决策缝：只有经过 bindVerifiedActiveBundle 的 bundleId 才能查受控目录。 */
export function bindInspectionAdapter(
  binding: WorkspaceBundleFacts,
  loadProjection?: ProjectionLoader,
): InspectionAdapterBinding {
  const active = bindVerifiedActiveBundle(binding, loadProjection);
  if (active.state !== "ready" || !active.projection || !active.bundleId) {
    return {
      state: active.state,
      adapter: null,
      bundleId: active.bundleId,
      installId: active.installId,
      reason: active.reason,
    };
  }
  const declaration = active.projection.ui.inspection;
  if (declaration?.enabled === false) {
    return {
      state: "inspection-disabled",
      adapter: null,
      bundleId: active.bundleId,
      installId: active.installId,
      reason: "当前行业包已关闭巡检能力",
    };
  }
  if (!declaration?.enabled) {
    return {
      state: "adapter-not-declared",
      adapter: null,
      bundleId: active.bundleId,
      installId: active.installId,
      reason: "当前行业包未声明巡检适配器",
    };
  }
  const registration = ADAPTERS_BY_ID.get(declaration.adapterId);
  if (!registration) {
    return {
      state: "adapter-not-registered",
      adapter: null,
      bundleId: active.bundleId,
      installId: active.installId,
      reason: "当前行业包未登记巡检适配器",
    };
  }
  if (!registration.bundleIds.includes(active.bundleId)) {
    return {
      state: "adapter-untrusted",
      adapter: null,
      bundleId: active.bundleId,
      installId: active.installId,
      reason: "活动行业包无权选择该巡检适配器",
    };
  }
  if (registration.trustedSignerKeyIds?.length
    && (!active.projection.signatureKeyId || !registration.trustedSignerKeyIds.includes(active.projection.signatureKeyId))) {
    return {
      state: "adapter-untrusted",
      adapter: null,
      bundleId: active.bundleId,
      installId: active.installId,
      reason: "行业包签名方无权选择该巡检适配器",
    };
  }
  return {
    state: "ready",
    adapter: registration.adapter,
    bundleId: active.bundleId,
    installId: active.installId,
    reason: "活动行业包与巡检适配器已验证",
  };
}

export async function resolveWorkspaceInspectionAdapter(workspaceId: string): Promise<InspectionAdapterBinding> {
  const active = await resolveWorkspaceActiveBundle(workspaceId);
  const result = active.state === "ready" && active.projection
    ? bindInspectionAdapter({
      workspaceBundleId: active.bundleId,
      activeInstalls: [{ id: active.installId!, bundleId: active.bundleId! }],
    }, () => active.projection!)
    : {
      state: active.state,
      adapter: null,
      bundleId: active.bundleId,
      installId: active.installId,
      reason: active.reason,
    } satisfies InspectionAdapterBinding;
  if (result.state !== "ready" && result.state !== "adapter-not-registered") {
    console.warn(`[inspection] 行业巡检适配器失败关闭：${result.reason}`);
  }
  return result;
}

export function registeredInspectionBundleIds(): string[] {
  return [...new Set([...ADAPTERS_BY_ID.values()].flatMap((registration) => registration.bundleIds))].sort();
}
