/** 酒店专属种子脚本的零写入前置门禁。 */
import { isAbsolute, relative, resolve } from "node:path";
import { loadVerifiedBundleManifest } from "@workloom/base/bundles";

export function resolveHotelSeedBundle(repoRoot: string, configuredPath?: string): string {
  const requested = configuredPath?.trim();
  if (!requested) {
    throw new Error("酒店种子拒绝执行：必须显式设置 BUNDLE_DIR=bundles/hotel，数据库尚未写入");
  }
  const allowedRoot = resolve(repoRoot, "bundles");
  const target = resolve(repoRoot, requested);
  const rel = relative(allowedRoot, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("\\")) {
    throw new Error("酒店种子拒绝执行：BUNDLE_DIR 必须指向仓库 bundles 下的显式行业包，数据库尚未写入");
  }
  const segments = rel.split("/");
  if (segments.length !== 1 || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(segments[0]!)) {
    throw new Error("酒店种子拒绝执行：BUNDLE_DIR 不是有效的单一行业包目录，数据库尚未写入");
  }
  const manifest = loadVerifiedBundleManifest(segments[0]!, allowedRoot);
  if (manifest.workloom.industry !== "hotel") {
    throw new Error(`酒店种子拒绝执行：当前显式 Bundle 为 ${manifest.workloom.industry}，数据库尚未写入`);
  }
  return target;
}
