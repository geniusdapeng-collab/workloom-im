/** Verify ordinary installed state against the desktop packer's single integrity verifier. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { publicDiagnostic } from "./live/safety.mjs";

const require = createRequire(import.meta.url);
const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const hash = (value) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const port = (value) => Number.isInteger(value) && value >= 1 && value <= 65535;
const validVersion = (value) => typeof value === "string" && /^[0-9A-Za-z][0-9A-Za-z._+-]{0,120}$/u.test(value);
const product = (value) => typeof value === "string" && /^[a-z][a-z0-9-]{0,79}$/u.test(value);

function ordinaryJson(path) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o444) === 0 || before.size < 2 || before.size > 1024 * 1024) throw new Error("invalid installed state");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const held = fstatSync(fd);
    const bytes = readFileSync(fd);
    const after = lstatSync(path);
    if (held.ino !== before.ino || held.dev !== before.dev || held.size !== before.size || bytes.length !== held.size || after.ino !== held.ino || after.dev !== held.dev || after.size !== held.size || after.isSymbolicLink()) throw new Error("installed state changed");
    return JSON.parse(bytes.toString("utf8"));
  } finally { closeSync(fd); }
}

function matchesPort(url, expected) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === "/"
      && Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)) === expected;
  } catch { return false; }
}

/** Missing helpers/bytes/state fail closed; no fixture fallback or database/.env read occurs. */
export function inspectClientIdentity({ supportDir, urls = {}, expectedProductId = null } = {}) {
  const failed = (category = "client_identity_invalid") => ({ ok: false, reason: "客户端缺少完整、当前且一致的普通安装状态/载荷/产品身份；不能作为 client-runtime 证据", diagnostic: { category } });
  try {
    if (typeof supportDir !== "string" || !supportDir || lstatSync(supportDir).isSymbolicLink()) return failed();
    const root = realpathSync(supportDir);
    const state = ordinaryJson(join(root, "install-state.json"));
    const identity = state?.runtimeIdentity;
    const updated = Date.parse(state?.updatedAt);
    if (state?.schemaVersion !== "workloom.install-state/v1" || state.status !== "complete" || state.phase !== "ready"
      || !validVersion(state.targetVersion) || typeof state.updatedAt !== "string" || !Number.isFinite(updated)
      || new Date(updated).toISOString() !== state.updatedAt || updated > Date.now() + 30_000
      || identity?.schemaVersion !== "workloom.client-runtime-identity/v1" || !uuid(identity.instanceId) || identity.supportDir !== root
      || !product(identity.productId) || !validVersion(identity.payloadVersion) || identity.payloadVersion !== state.targetVersion
      || !hash(identity.productManifestSha256) || !hash(identity.payloadIntegritySha256) || !port(identity.ports?.server) || !port(identity.ports?.web)
      || identity.ports.server === identity.ports.web || !matchesPort(urls.api, identity.ports.server) || !matchesPort(urls.pc, identity.ports.web)
      || expectedProductId !== null && identity.productId !== expectedProductId) return failed();
    const { verifyPayloadIntegrity } = require("../../../apps/desktop/electron/payload-integrity.cjs");
    if (typeof verifyPayloadIntegrity !== "function") return failed("payload_verifier_unavailable");
    const actual = verifyPayloadIntegrity(root, { expectedProductId: identity.productId, expectedVersion: identity.payloadVersion });
    if (!actual || actual.productId !== identity.productId || actual.payloadVersion !== identity.payloadVersion
      || actual.productManifestSha256 !== identity.productManifestSha256 || actual.payloadIntegritySha256 !== identity.payloadIntegritySha256) return failed();
    // Re-read after the full immutable tree check. A concurrent install/restart cannot borrow old ready state.
    const after = ordinaryJson(join(root, "install-state.json"));
    if (JSON.stringify(after.runtimeIdentity) !== JSON.stringify(identity) || after.schemaVersion !== state.schemaVersion || after.status !== "complete"
      || after.phase !== "ready" || after.targetVersion !== state.targetVersion || after.updatedAt !== state.updatedAt) return failed();
    return { ok: true, identity: { schemaVersion: identity.schemaVersion, instanceId: identity.instanceId, supportDir: root, productId: identity.productId,
      payloadVersion: identity.payloadVersion, productManifestSha256: identity.productManifestSha256, payloadIntegritySha256: identity.payloadIntegritySha256,
      ports: { server: identity.ports.server, web: identity.ports.web } }, installState: { status: "complete", phase: "ready", updatedAt: state.updatedAt } };
  } catch (error) {
    const diagnostic = publicDiagnostic(error, "client_identity_invalid");
    return failed(diagnostic.category === "storage_unavailable" ? "client_installation_unavailable" : "client_identity_invalid");
  }
}
