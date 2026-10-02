"use strict";

const MASK = "[已脱敏]";
const SECRET_KEY = /(?:secret|token|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key|pii[_-]?salt|^pwd$)/iu;

/** Redact before persistence and again before export; error/log strings are untrusted input. */
function redactPlainText(value) {
  return value
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/gu, MASK)
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*$/u, MASK)
    .replace(/^[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/u, MASK)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, `$1${MASK}@`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, `$1 ${MASK}`)
    .replace(/((?:[\\]*["'])?[\w.-]*(?:secret|token|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key|pii[_-]?salt|pwd)[\w.-]*(?:[\\]*["'])?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;\}\]]+)/giu,
      (_all, prefix, secret) => `${prefix}${secret.startsWith('"') ? `"${MASK}"` : secret.startsWith("'") ? `'${MASK}'` : MASK}`);
}

function redactText(value, secretValues = []) {
  const original = String(value ?? "");
  let decoded = original;
  // Only select decoded text if it exposes an actual sensitive pattern. Ordinary
  // percent-bearing support paths and public identity fields retain exact bytes.
  for (let pass = 0; pass < 3; pass += 1) {
    decoded = decoded.replace(/(?:%[a-f0-9]{2})+/giu, (encoded) => {
      try { return decodeURIComponent(encoded); } catch { return encoded; }
    });
  }
  const decodedSafe = redactPlainText(decoded);
  const variants = [];
  for (const secret of secretValues) {
    if (typeof secret !== "string" || !secret) continue;
    const values = [secret, encodeURIComponent(secret), encodeURIComponent(encodeURIComponent(secret)), JSON.stringify(secret).slice(1, -1)];
    if (secret.length >= 8) values.push(Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url"));
    variants.push({ values: [...new Set(values)], short: secret.length < 16 });
  }
  const maskKnown = (text) => {
    let safe = text;
    for (const { values, short } of variants) for (const variant of values) {
      if (short) {
        const escaped = variant.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        safe = safe.replace(new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_.-])`, "gu"), MASK);
      } else safe = safe.split(variant).join(MASK);
    }
    return safe;
  };
  const decodedKnownSafe = maskKnown(decodedSafe);
  return decodedSafe !== decoded || decodedKnownSafe !== decodedSafe
    ? decodedKnownSafe : maskKnown(redactPlainText(original));
}

function redactDiagnostic(value, seen = new WeakSet(), secretValues = []) {
  if (typeof value === "string") return redactText(value, secretValues);
  if (value instanceof Error) return redactText(value.stack || value.message, secretValues);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[循环引用]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactDiagnostic(item, seen, secretValues));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SECRET_KEY.test(key) ? MASK : redactDiagnostic(item, seen, secretValues);
  }
  return result;
}

module.exports = { redactText, redactDiagnostic };
