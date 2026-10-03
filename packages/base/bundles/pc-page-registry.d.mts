import type { BundleManifest } from "@workloom/industry-contract";

export interface PcPageDefinition {
  path: string;
  source: "base" | "industry";
  legacyPaths: string[];
  capabilityId?: string;
}
export interface PcPageRegistry {
  schemaVersion: "workloom.pc-pages/v1";
  routes: PcPageDefinition[];
  sources: Record<string, string>;
  artifacts?: Record<string, string>;
  digest: string;
}
export interface PcCaseValidation {
  ok: boolean;
  pages: string[];
  caseCount: number;
  detail: string;
}
export const PC_PAGE_REGISTRY_SCHEMA: "workloom.pc-pages/v1";
export const PC_PAGE_REGISTRY_SOURCE: string;
export const PC_PAGE_REGISTRY_ARTIFACT: string;
export function pcPageRegistryDigest(value: unknown): string;
export function parsePcPageRegistry(value: unknown): PcPageRegistry;
export function sealPcPageRegistry(value: { routes: PcPageDefinition[]; sources: Record<string, string>; artifacts?: Record<string, string> }): PcPageRegistry;
export function pcPageSourceHashes(root: string): Record<string, string>;
export function assertPcPageSources(registry: PcPageRegistry, root: string): void;
export function pcPageArtifactHashes(directory: string): Record<string, string>;
export function pcPageProductRoot(): string;
export function loadPcPageRegistry(options?: { root?: string; production?: boolean }): PcPageRegistry;
export function registeredBundlePcPages(registry: PcPageRegistry, manifest: BundleManifest): string[];
export function validateBundlePcCases(casesDocument: unknown, registry: PcPageRegistry, manifest: BundleManifest): PcCaseValidation;
