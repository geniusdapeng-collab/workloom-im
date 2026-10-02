import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const CURRENT_WORKFLOW = ".github/workflows/desktop-production-release.yml";
const LEGACY_WORKFLOW = ".github/workflows/build-desktop.yml";
const CNB_WORKFLOW = ".cnb.yml";

export function resolveDesktopWorkflowPath(repositoryRoot, product = {}) {
  const configured = String(product?.release?.workflow ?? "").trim();
  if (configured && (configured.includes("..") || (configured !== CNB_WORKFLOW && !configured.startsWith(".github/workflows/")))) {
    throw new Error("产品清单 release.workflow 必须为 .cnb.yml 或位于 .github/workflows/ 且不得越界");
  }
  const candidates = configured ? [configured] : [CURRENT_WORKFLOW, LEGACY_WORKFLOW];
  const relative = candidates.find((candidate) => existsSync(join(repositoryRoot, candidate))) ?? candidates[0];
  // A monorepo's governance subdirectory can carry the same protected manifest,
  // while the canonical CNB workflow belongs to its immediate Git repository root.
  if (relative === CNB_WORKFLOW && !existsSync(join(repositoryRoot, relative))) {
    const parent = dirname(resolve(repositoryRoot));
    const parentManifest = join(parent, "product.manifest.json");
    if (existsSync(join(parent, ".git")) && existsSync(parentManifest) && existsSync(join(parent, relative))) {
      let owner;
      try { owner = JSON.parse(readFileSync(parentManifest, "utf8")); }
      catch { throw new Error("CNB 工作流归属清单不是合法 JSON"); }
      if (typeof product.productId === "string" && product.productId.length > 0
          && typeof product.repository === "string" && product.repository.length > 0
          && owner.productId === product.productId && owner.repository === product.repository && owner.release?.workflow === relative) {
        return { relative, absolute: join(parent, relative), configured: Boolean(configured) };
      }
    }
  }
  return { relative, absolute: join(repositoryRoot, relative), configured: Boolean(configured) };
}

export { CURRENT_WORKFLOW, LEGACY_WORKFLOW, CNB_WORKFLOW };
