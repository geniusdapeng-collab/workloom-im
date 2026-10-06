/** Public acceptance evidence never reflects an unknown upstream diagnostic. */
const localErrors = new WeakMap();
const REDACTED = "[REDACTED]";
const credentialName = /API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY/iu;
const secretField = /^(?:authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|private[-_]?key)$/iu;

/** Only locally authored failures may keep their diagnostic text. No cause is retained. */
export class PublicBoundaryError extends Error {
  constructor(message, category = "invalid_evidence", httpStatus = null) {
    super(message);
    this.name = "PublicBoundaryError";
    const diagnostic = { category, ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}) };
    localErrors.set(this, { message, diagnostic });
    this.diagnostic = Object.freeze(diagnostic);
  }
}

/** Read data descriptors only; an external getter is never part of diagnostics. */
function property(value, key) {
  if (!value || !["object", "function"].includes(typeof value)) return undefined;
  try {
    for (let current = value, depth = 0; current && depth < 5; current = Object.getPrototypeOf(current), depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    }
  } catch { return undefined; }
  return undefined;
}

export function publicDiagnostic(error, fallback = "upstream_unknown") {
  if (error && typeof error === "object" && localErrors.has(error)) return { ...localErrors.get(error).diagnostic };
  const status = [property(error, "status"), property(error, "statusCode")].find((value) => Number.isInteger(value) && value >= 100 && value <= 599);
  const code = property(error, "code");
  const name = property(error, "name");
  const category = ["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNABORTED", "ABORT_ERR"].includes(code) || ["AbortError", "TimeoutError"].includes(name) ? "timeout"
    : [401, 403].includes(status) ? "upstream_authentication"
      : status === 429 ? "upstream_quota"
        : status >= 500 ? "upstream_unavailable"
          : status >= 400 ? "upstream_http"
            : ["ENOENT", "EACCES", "EPERM", "ELOOP", "ENOTDIR", "EISDIR", "EIO"].includes(code) ? "storage_unavailable" : fallback;
  return { category, ...(status === undefined ? {} : { httpStatus: status }) };
}

export function diagnosticReason(error, context, fallback = "upstream_unknown") {
  if (error && typeof error === "object" && localErrors.has(error)) return localErrors.get(error).message;
  const diagnostic = publicDiagnostic(error, fallback);
  return `${context}（${diagnostic.category}${diagnostic.httpStatus ? `；HTTP ${diagnostic.httpStatus}` : ""}）`;
}

export function safeError(error, context, fallback = "upstream_unknown") {
  const diagnostic = publicDiagnostic(error, fallback);
  return new PublicBoundaryError(diagnosticReason(error, context, fallback), diagnostic.category, diagnostic.httpStatus);
}

export function credentialValues({ env = process.env, credentialEnvs = [], secrets = [] } = {}) {
  const explicit = new Set(credentialEnvs.filter((key) => typeof key === "string"));
  return [...new Set([...Object.entries(env ?? {}).filter(([key]) => credentialName.test(key) || explicit.has(key)).map(([, value]) => value), ...secrets]
    .filter((value) => typeof value === "string" && value.length > 0))];
}

/**
 * Percent-encoding is not canonical: every `%XX` escape has an upper- and a
 * lower-case spelling, and URL/query serialization adds spellings the literal
 * credential does not contain (`%20` and `+` for a space, `%20` for `+` after a
 * decode). A provider that echoes the credential inside a URL can therefore
 * return a byte sequence that matches none of the literal/encode/base64 forms.
 * Enumerate both hex cases for both encodeURI/encodeURIComponent families so
 * "contains the credential" stays true however the transport spelled it.
 */
function encodedSpellings(value) {
  const component = encodeURIComponent(value);
  const uri = encodeURI(value);
  const reduce = (text) => text.replace(/%[0-9A-Fa-f]{2}/gu, (part) => part.toLowerCase());
  const raise = (text) => text.replace(/%[0-9A-Fa-f]{2}/gu, (part) => part.toUpperCase());
  return [component, uri, ...new Set([component, uri].flatMap((form) => [reduce(form), raise(form)]))];
}

export function secretVariants(options = {}) {
  return [...new Set(credentialValues(options).flatMap((value) => {
    const forms = new Set([value, JSON.stringify(value).slice(1, -1), Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url")]);
    for (const encoded of encodedSpellings(value)) {
      // A provider that decodes once before echoing exposes the double-encoded form.
      forms.add(encoded);
      forms.add(encodeURIComponent(encoded));
    }
    // URL form serialization materializes a space as '+' (and '+' back as '%2B').
    if (value.includes(" ")) {
      for (const form of [...forms]) if (form.includes("%20")) forms.add(form.replaceAll("%20", "+"));
    }
    return [...forms];
  }))].sort((a, b) => b.length - a.length);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
function replaceSecrets(text, variants) {
  for (const secret of variants) {
    // A one-character test credential cannot censor every letter in a hostname.
    // Short secrets are still removed as complete values or delimited tokens.
    if (secret.length < 4) text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(secret)}(?![\\p{L}\\p{N}_])`, "gu"), REDACTED);
    else text = text.split(secret).join(REDACTED);
  }
  return text;
}

/** Metadata URLs omit credentials, query strings and fragments, including malformed inputs. */
export function publicUrl(value) {
  if (typeof value !== "string") return "(invalid URL)";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "(invalid URL)";
    if (!url.username && !url.password && !url.search && !url.hash && value.trim() === value) return value;
    return `${url.origin}${url.pathname}`;
  } catch { return "(invalid URL)"; }
}

/** Logical receipts such as db://entity/id are metadata, never download transports. */
export function publicResourceUrl(value) {
  if (typeof value !== "string") return "(invalid URL)";
  try {
    const url = new URL(value);
    if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return "(invalid URL)";
    if (!url.username && !url.password && !url.search && !url.hash && value.trim() === value) return value;
    return url.origin === "null" ? `${url.protocol}//${url.host}${url.pathname}` : `${url.origin}${url.pathname}`;
  } catch { return "(invalid URL)"; }
}

export function safeHttpEndpoint(value) {
  if (typeof value !== "string" || !value || value.trim() !== value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? value.replace(/\/+$/u, "") : null;
  } catch { return null; }
}

export function redactText(value, options = {}) {
  const text = typeof value === "string" ? value : "(unavailable diagnostic)";
  let clean = replaceSecrets(text, secretVariants(options));
  clean = clean.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/giu, (url) => publicResourceUrl(url));
  clean = clean.replace(/\b(?:proxy[-_ ]?)?authorization\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\r\n,;]+/giu, `Authorization: ${REDACTED}`);
  clean = clean.replace(/\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret)\s*[:=]\s*[^\s,;]+/giu, (match) => `${match.split(/[:=]/u)[0]}=${REDACTED}`);
  return clean;
}

/** Clone JSON evidence without invoking toJSON/getters; mark every required disclosure change. */
export function sanitizePublic(value, options = {}) {
  let changed = false;
  const seen = new WeakSet();
  const cleanText = (text) => { const clean = redactText(text, options); changed ||= clean !== text; return clean; };
  const withheld = () => { changed = true; return REDACTED; };
  const walk = (item, depth = 0) => {
    if (typeof item === "string") return cleanText(item);
    if (item === null || ["boolean", "number", "undefined"].includes(typeof item)) return item;
    if (typeof item !== "object" || depth > 80 || seen.has(item)) return withheld();
    seen.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Array.isArray(item)) return Array.from({ length: item.length }, (_, index) => {
        const descriptor = descriptors[index];
        return descriptor && Object.hasOwn(descriptor, "value") ? walk(descriptor.value, depth + 1) : withheld();
      });
      const result = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) continue;
        const cleanKey = cleanText(key);
        const child = !Object.hasOwn(descriptor, "value") ? withheld()
          : secretField.test(key) && descriptor.value !== null && descriptor.value !== undefined ? withheld() : walk(descriptor.value, depth + 1);
        Object.defineProperty(result, cleanKey, { enumerable: true, configurable: true, writable: true, value: child });
      }
      return result;
    } catch { return withheld(); }
    finally { seen.delete(item); }
  };
  return { value: walk(value), changed };
}

/** Measured usage survives redaction; disclosure failure always revokes successful evidence. */
export function publicResult(value, options = {}) {
  const clean = sanitizePublic(value, options);
  if (!clean.changed) return clean.value;
  const result = clean.value && typeof clean.value === "object" ? clean.value : {};
  result.publicSafety = { redacted: true, category: "evidence_redacted" };
  if (!["failed", "blocked", "skipped"].includes(result.status)) {
    result.status = "blocked";
    result.reason = "公开证据包含需脱敏内容，已移除；不能作为成功证据";
  }
  if (result.receipt && typeof result.receipt === "object") result.receipt = { ...result.receipt, synced: false };
  if (result.verification && typeof result.verification === "object") result.verification = { ...result.verification, ok: false };
  return result;
}
