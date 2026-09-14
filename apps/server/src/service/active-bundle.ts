/**
 * 工作区活动 Bundle 的唯一运行时解析入口。
 *
 * 数据库通过 RLS 只提供“哪个安装处于 active”的事实；磁盘清单还必须通过
 * 契约、兼容性、摘要以及生产签名校验。指针冲突、多个活动安装或投影异常
 * 一律失败关闭，调用方不得回退到示例行业。
 */
import { loadBundleUiProjection, type BundleUiProjection } from "@workloom/base/bundles";
import { serviceTx } from "./events.js";

export type ActiveBundleState =
  | "ready"
  | "not-installed"
  | "bundle-mismatch"
  | "projection-invalid";

export interface WorkspaceBundleFacts {
  workspaceBundleId: string | null;
  activeInstalls: Array<{ id: string; bundleId: string }>;
}

export interface ActiveBundleResolution {
  state: ActiveBundleState;
  bundleId: string | null;
  installId: string | null;
  projection: BundleUiProjection | null;
  /** 仅用于服务端诊断，禁止直接回显给客户端。 */
  reason: string;
}

type ProjectionLoader = (bundleId: string) => BundleUiProjection;

export function bindVerifiedActiveBundle(
  facts: WorkspaceBundleFacts,
  loadProjection: ProjectionLoader = loadBundleUiProjection,
): ActiveBundleResolution {
  if (facts.activeInstalls.length !== 1) {
    return {
      state: "not-installed",
      bundleId: null,
      installId: null,
      projection: null,
      reason: facts.activeInstalls.length === 0 ? "工作区没有生效装配" : "工作区存在多个生效装配",
    };
  }
  const active = facts.activeInstalls[0]!;
  if (facts.workspaceBundleId && facts.workspaceBundleId !== active.bundleId) {
    return {
      state: "bundle-mismatch",
      bundleId: active.bundleId,
      installId: active.id,
      projection: null,
      reason: "工作区指针与生效装配不一致",
    };
  }
  try {
    const projection = loadProjection(active.bundleId);
    if (!projection.integrityDigest || projection.bundleStatus === "draft") {
      return {
        state: "projection-invalid",
        bundleId: active.bundleId,
        installId: active.id,
        projection: null,
        reason: "活动行业包缺少完整性摘要或仍处于草稿状态",
      };
    }
    return {
      state: "ready",
      bundleId: active.bundleId,
      installId: active.id,
      projection,
      reason: "活动行业包投影已验证",
    };
  } catch (error) {
    return {
      state: "projection-invalid",
      bundleId: active.bundleId,
      installId: active.id,
      projection: null,
      reason: error instanceof Error ? error.message : "行业投影校验失败",
    };
  }
}

export async function resolveWorkspaceActiveBundle(workspaceId: string): Promise<ActiveBundleResolution> {
  const facts = await serviceTx(workspaceId, async (client) => {
    const workspace = await client.query<{ bundle_id: string | null }>(
      `SELECT bundle_id FROM workspaces WHERE id=$1`,
      [workspaceId],
    );
    const active = await client.query<{ id: string; bundle_id: string }>(
      `SELECT id, bundle_id FROM bundle_installs
       WHERE workspace_id=$1 AND status='active' ORDER BY installed_at DESC`,
      [workspaceId],
    );
    return {
      workspaceBundleId: workspace.rows[0]?.bundle_id ?? null,
      activeInstalls: active.rows.map((row) => ({ id: row.id, bundleId: row.bundle_id })),
    } satisfies WorkspaceBundleFacts;
  });
  return bindVerifiedActiveBundle(facts);
}
