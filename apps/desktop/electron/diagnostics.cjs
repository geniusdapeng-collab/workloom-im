"use strict";

// Standalone desktop diagnostics must also work before the payload is installed.
// Keep this module in the Electron ASAR, with only bundled Node built-ins.
const fs = require("node:fs");
const path = require("node:path");

const MASK = "[已脱敏]";
const MAX_LOG_FILES = 12;
const MAX_LOG_TAIL_BYTES = 200_000;
const MAX_LOG_SOURCE_BYTES = 4_000_000;
const MAX_ENCODING_DEPTH = 12;

function textValue(value, fallback = "无") {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (["number", "boolean", "bigint"].includes(typeof value)) return String(value);
  try { return JSON.stringify(value) ?? fallback; }
  catch { return "[诊断字段不可序列化]"; }
}

function decodePercent(value) {
  // Decode valid groups independently: a damaged %ZZ must not defeat redaction
  // of a neighboring encoded credential URL or field name.
  return value.replace(/(?:%[\da-f]{2})+/giu, (part) => {
    try { return decodeURIComponent(part); }
    catch { return part; }
  });
}

function quotedEnd(text, start) {
  const quote = text[start];
  for (let n = start + 1; n < text.length; n += 1) {
    if (text[n] === "\\") { n += 1; continue; }
    if (text[n] === quote) return { end: n + 1, closed: true };
  }
  return { end: text.length, closed: false };
}

function decodeQuoted(token, closed) {
  if (closed && token[0] === '"') {
    try { return JSON.parse(token); }
    catch { /* Malformed log fragments still use the conservative lexical path. */ }
  }
  return token.slice(1, closed ? -1 : undefined)
    .replace(/\\u([\da-f]{4})/giu, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\([\\'"`])/gu, "$1")
    .replace(/\\n/gu, "\n").replace(/\\r/gu, "\r").replace(/\\t/gu, "\t");
}

function sensitiveKey(value) {
  const normalized = decodePercent(value).normalize("NFKC").replace(/[\s_.-]/gu, "").toLowerCase();
  return /(?:apikey|passwords?|passwd|pwd|secrets?|tokens?|piisalt|credentials?|(?:signing|encryption|private|secret|client)key)$/u.test(normalized)
    || /^(?:proxy)?authorization$/u.test(normalized)
    || /(?:^|set|session)cookie$/u.test(normalized);
}

function aggregateEnd(text, start) {
  const stack = [text[start] === "{" ? "}" : "]"];
  for (let n = start + 1; n < text.length; n += 1) {
    if (['"', "'", "`"].includes(text[n])) { n = quotedEnd(text, n).end - 1; continue; }
    if (text[n] === "{") stack.push("}");
    else if (text[n] === "[") stack.push("]");
    else if (text[n] === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return n + 1;
    }
  }
  // An unfinished sensitive object/array is withheld through EOF, rather than
  // exposing an unlabelled continuation of its credential values.
  return text.length;
}

function credentialReplacement(key, raw, quote = "") {
  const auth = /authorization$/iu.test(key.replace(/[_.-]/gu, ""));
  const scheme = auth ? raw.trim().match(/^(Bearer|Basic)\s+/iu)?.[1] : null;
  const replacement = scheme ? `${scheme} ${MASK}` : MASK;
  return quote ? `${quote}${replacement}${quote}` : replacement;
}

function nextToken(text, start) {
  // Scan each character once. A regex for complete quoted strings can restart
  // at every escaped quote in a malformed string, causing quadratic work.
  for (let n = start; n < text.length; n += 1) {
    if (['"', "'", "`"].includes(text[n])) {
      const span = quotedEnd(text, n);
      return { index: n, end: span.end, quoted: true, closed: span.closed };
    }
    if (/[A-Za-z_]/u.test(text[n])) {
      let end = n + 1;
      while (end < text.length && /[A-Za-z\d_.%\-]/u.test(text[end])) end += 1;
      return { index: n, end, quoted: false, closed: false };
    }
  }
  return null;
}

function redactAssignments(text, depth) {
  let output = "";
  let cursor = 0;
  let search = 0;
  let match;
  while ((match = nextToken(text, search))) {
    const token = text.slice(match.index, match.end);
    const quoted = match.quoted;
    const key = quoted ? decodeQuoted(token, match.closed) : token;
    const end = match.end;
    search = end;
    const delimiter = /^[ \t]*[:=][ \t]*/u.exec(text.slice(end));
    if (delimiter && sensitiveKey(key)) {
      let start = end + delimiter[0].length;
      // Pretty-printed JSON may place the value on the following line. Empty
      // env values do not consume the next independent line.
      if (quoted && delimiter[0].includes(":")) {
        while (/\s/u.test(text[start] ?? "") && start < text.length) start += 1;
      }
      let valueEnd = start;
      let replacement;
      if (['"', "'", "`"].includes(text[start])) {
        const span = quotedEnd(text, start);
        valueEnd = span.end;
        replacement = credentialReplacement(key, text.slice(start + 1, valueEnd - (span.closed ? 1 : 0)), text[start]);
      } else if (text[start] === "{" || text[start] === "[") {
        valueEnd = aggregateEnd(text, start);
        replacement = `"${MASK}"`;
      } else {
        let preceding = match.index - 1;
        while (preceding >= 0 && /[ \t]/u.test(text[preceding])) preceding -= 1;
        const query = ["?", "&"].includes(text[preceding]);
        const structural = quoted || ["{", "[", ","].includes(text[preceding]);
        while (valueEnd < text.length) {
          const char = text[valueEnd];
          if (query && ["&", "#", " ", "\t", "\r", "\n", '"', "'", "`"].includes(char)) break;
          if (structural && [",", "}", "]", "\r", "\n"].includes(char)) break;
          if (char === "\r" || char === "\n") {
            let backslashes = 0;
            for (let n = valueEnd - 1; n >= start && text[n] === "\\"; n -= 1) backslashes += 1;
            if (backslashes % 2 === 0) break;
            if (char === "\r" && text[valueEnd + 1] === "\n") valueEnd += 1;
          }
          valueEnd += 1;
        }
        replacement = credentialReplacement(key, text.slice(start, valueEnd));
      }
      output += text.slice(cursor, start) + replacement;
      cursor = valueEnd;
      search = valueEnd;
    } else if (quoted && !delimiter) {
      // Error.message may contain a serialized JSON object inside a JSON
      // string. Decode that string, sanitize it, then retain its representation.
      const clean = sanitizeText(key, depth + 1);
      if (clean !== key) {
        const encoded = token[0] === '"' ? JSON.stringify(clean)
          : `${token[0]}${clean.replaceAll("\\", "\\\\").replaceAll(token[0], `\\${token[0]}`).replaceAll("\n", "\\n").replaceAll("\r", "\\r")}${token[0]}`;
        output += text.slice(cursor, match.index) + encoded;
        cursor = end;
      }
    }
  }
  return output + text.slice(cursor);
}

function redactUrls(text) {
  // A bounded scheme prevents quadratic backtracking on a long log value that
  // contains no URL. Desktop credential protocols fit comfortably in 32 chars.
  return text.replace(/\b([a-z][a-z\d+.-]{0,31}:(?:\\?\/){2})([^\s"'`<>]+)/giu, (_match, scheme, rest) => {
    const separator = rest.search(/[\\/?#]/u);
    const authority = separator < 0 ? rest : rest.slice(0, separator);
    const at = authority.lastIndexOf("@");
    if (at < 0) return scheme + rest;
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(":");
    const safeUserinfo = colon < 0 ? MASK : `${userinfo.slice(0, colon)}:${MASK}`;
    return scheme + safeUserinfo + rest.slice(at);
  });
}

function redactEncodedTokens(text, depth) {
  const escapes = /%[\da-f]{2}/giu;
  const boundary = /[\s"'`<>]/u;
  let output = "";
  let cursor = 0;
  let match;
  while ((match = escapes.exec(text))) {
    let start = match.index;
    while (start > cursor && !boundary.test(text[start - 1])) start -= 1;
    let end = escapes.lastIndex;
    while (end < text.length && !boundary.test(text[end])) end += 1;
    const part = text.slice(start, end);
    const decoded = decodePercent(part);
    const sanitized = decoded === part ? decoded : sanitizeText(decoded, depth + 1);
    output += text.slice(cursor, start) + (sanitized === decoded ? part : encodeURIComponent(sanitized));
    cursor = end;
    escapes.lastIndex = end;
  }
  return output + text.slice(cursor);
}

function sanitizeText(text, depth = 0) {
  if (depth > MAX_ENCODING_DEPTH) return "[诊断嵌套内容超出安全解析上限]";
  let clean = text.replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/gu, MASK);
  // Redact raw/JSON-escaped userinfo before decoding percent escapes. Decoding
  // an encoded '/' or '@' in a password first would destroy the URL boundary.
  clean = redactUrls(clean);
  clean = redactEncodedTokens(clean, depth);
  clean = redactAssignments(clean, depth);
  return clean.replace(/\b(Bearer|Basic)[ \t]+[^\s"'`<>,}\]]+/giu, (_match, scheme) => `${scheme} ${MASK}`);
}

function sanitizeDiagnosticText(value) {
  return sanitizeText(textValue(value, ""));
}

function safeTail(text) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_LOG_TAIL_BYTES) return text;
  let start = bytes.length - MAX_LOG_TAIL_BYTES;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return `[已省略较早诊断内容；保留脱敏后的末尾 ${bytes.length - start} 字节]\n${bytes.subarray(start).toString("utf8")}`;
}

function readLog(file, canonicalLogDir, fsImpl) {
  const before = fsImpl.lstatSync(file);
  if (before.isSymbolicLink()) throw new Error("已跳过符号链接，避免读取日志目录之外的内容");
  if (!before.isFile()) throw new Error("已跳过非常规日志项");
  if (before.nlink > 1) throw new Error("已跳过存在多个硬链接的日志，避免读取其他目录的私密文件");
  if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > MAX_LOG_SOURCE_BYTES) {
    throw new Error(`日志超出安全读取上限（${MAX_LOG_SOURCE_BYTES} 字节），请缩小日志后重新导出`);
  }
  if (fsImpl.realpathSync(file) !== path.join(canonicalLogDir, path.basename(file))) {
    throw new Error("日志物理路径越过当前日志目录，已跳过");
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  const fd = fsImpl.openSync(file, flags);
  try {
    const opened = fsImpl.fstatSync(fd);
    if (!opened.isFile() || opened.nlink > 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) {
      throw new Error("日志在打开时发生变化，请重新导出");
    }
    const buffer = Buffer.alloc(before.size);
    let read = 0;
    while (read < buffer.length) {
      const bytes = fsImpl.readSync(fd, buffer, read, buffer.length - read, read);
      if (!Number.isInteger(bytes) || bytes <= 0 || bytes > buffer.length - read) {
        throw new Error("日志在读取时发生变化或提前结束，请重新导出");
      }
      read += bytes;
    }
    const completed = fsImpl.fstatSync(fd);
    if (completed.size !== opened.size || completed.mtimeMs !== opened.mtimeMs || completed.ctimeMs !== opened.ctimeMs) {
      throw new Error("日志在读取过程中发生变化，请重新导出");
    }
    // Sanitizing the whole bounded source before clipping is essential: an old
    // 200k tail may begin in the middle of a long multiline secret value.
    return safeTail(sanitizeDiagnosticText(buffer.toString("utf8")));
  } finally {
    fsImpl.closeSync(fd);
  }
}

function collectStartupDiagnostics({ supportDir, version, platform, arch, reference, error, fsImpl = fs } = {}) {
  const sections = [
    "WorkLoom 启动诊断",
    `导出时间：${new Date().toISOString()}`,
    `应用版本：${sanitizeDiagnosticText(textValue(version))}`,
    `系统：${sanitizeDiagnosticText(textValue(platform))} ${sanitizeDiagnosticText(textValue(arch))}`,
    `支持参考：${sanitizeDiagnosticText(textValue(reference))}`,
    `最近错误：${sanitizeDiagnosticText(textValue(error))}`,
  ];
  try {
    if (typeof supportDir !== "string" || supportDir.length === 0) throw new Error("应用支持目录无效");
    const logDir = path.join(supportDir, "logs");
    sections.push(`日志目录：${sanitizeDiagnosticText(logDir)}`);
    const directory = fsImpl.lstatSync(logDir);
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error("日志目录不是本机常规目录，已拒绝读取");
    const canonicalLogDir = fsImpl.realpathSync(logDir);
    const names = fsImpl.readdirSync(logDir).filter((name) => (
      typeof name === "string" && path.basename(name) === name && /\.(?:log|json)$/iu.test(name)
      && !/^(?:\.env(?:[.-]|$)|database-state(?:[.-]|$)|credentials?(?:[.-]|$))/iu.test(name)
    )).sort().slice(-MAX_LOG_FILES);
    for (const name of names) {
      const safeName = sanitizeDiagnosticText(name);
      try {
        const content = readLog(path.join(logDir, name), canonicalLogDir, fsImpl);
        sections.push(`\n===== ${safeName}（脱敏后的日志末尾）=====\n${content}`);
      } catch (readError) {
        sections.push(`\n日志读取失败（${safeName}）：${sanitizeDiagnosticText(textValue(readError))}`);
      }
    }
  } catch (readError) {
    sections.push(`\n日志读取失败：${sanitizeDiagnosticText(textValue(readError))}`);
  }
  return sanitizeDiagnosticText(sections.join("\n"));
}

module.exports = {
  sanitizeDiagnosticText,
  collectStartupDiagnostics,
  MAX_LOG_FILES,
  MAX_LOG_TAIL_BYTES,
  MAX_LOG_SOURCE_BYTES,
};
