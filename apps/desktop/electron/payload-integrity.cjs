"use strict";

// Keep this verifier independent of desktop/Electron and product helper imports. The
// installer and the acceptance runner use the same no-follow enumeration and bytes.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SCHEMA = "workloom.payload-integrity/v1";
const INDEX_FILE = "payload-integrity.json";
const ROOTS = ["runtime", "node", "pg", "nats"];
const ALLOWED_ROOTS = new Set([...ROOTS, "python"]);
const MUTABLE_PATHS = ["runtime/.env"];
const MARKERS = ["VERSION", "PAYLOAD_VERSION"];

function reject(reason) { throw new Error(`载荷完整性校验失败：${reason}`); }
function inside(root, file) { return file === root || file.startsWith(root + path.sep); }
function safePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !/[\\\0\r\n:]/u.test(value) && !value.startsWith("/")
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}
function ordinary(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { reject(`${label}缺失`); }
  if (!stat.isFile() || stat.isSymbolicLink()) reject(`${label}必须是普通文件`);
  return stat;
}
function readSmall(file, label, maxBytes = 1_000_000) {
  const stat = ordinary(file, label);
  if (stat.size > maxBytes) reject(`${label}过大`);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) reject(`${label}在读取前发生替换`);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    if (bytes.length !== stat.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || !current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) reject(`${label}在读取时发生变化`);
    return bytes;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function fileDigest(file) {
  // O_NOFOLLOW and the before/after file identity checks also reject a substitution
  // between enumeration and hashing. No mutable .env bytes ever enter the verifier.
  const expected = ordinary(file, "索引资产");
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) reject("资产在读取前发生替换");
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (let count = fs.readSync(fd, buffer, 0, buffer.length, null); count > 0; count = fs.readSync(fd, buffer, 0, buffer.length, null)) {
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs || current.dev !== before.dev || current.ino !== before.ino
        || current.isSymbolicLink()) reject("资产在读取时发生变化");
    return { bytes, sha256: hash.digest("hex") };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function context(payloadDir, options) {
  let root;
  try { root = fs.realpathSync.native(payloadDir); } catch { reject("载荷目录缺失"); }
  if (!fs.statSync(root).isDirectory()) reject("载荷目录无效");
  let runtime;
  try { runtime = fs.lstatSync(path.join(root, "runtime")); } catch { reject("运行载荷缺失"); }
  if (!runtime.isDirectory() || runtime.isSymbolicLink()) reject("运行载荷根必须是普通目录");
  const productBytes = readSmall(path.join(root, "runtime", "product.manifest.json"), "产品清单");
  let product;
  try { product = JSON.parse(productBytes); } catch { reject("产品清单不是合法 JSON"); }
  if (typeof product.productId !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(product.productId)) reject("产品身份无效");
  const versions = [...MARKERS, "runtime/VERSION"].map((file) => readSmall(path.join(root, file), "版本标记", 1024).toString("utf8").trim());
  const version = versions[0];
  if (!version || version === "unknown" || /[\0\r\n]/u.test(version) || versions.some((value) => value !== version)) reject("版本标记不一致");
  if (options.expectedProductId !== undefined && product.productId !== options.expectedProductId) reject("产品身份与期望不一致");
  if (options.expectedVersion !== undefined && version !== options.expectedVersion) reject("版本与期望不一致");
  return { root, productId: product.productId, payloadVersion: version,
    productManifestSha256: crypto.createHash("sha256").update(productBytes).digest("hex") };
}
function requiredRoots(root) {
  let extension = [];
  const contractFile = path.join(root, "runtime", "industry-runtime.json");
  if (fs.existsSync(contractFile)) {
    let contract;
    try { contract = JSON.parse(readSmall(contractFile, "行业运行契约", 100_000)); } catch { reject("行业运行契约无效"); }
    if (contract.schemaVersion !== "workloom.industry-runtime/v1" || !Array.isArray(contract.requiredParts)
        || contract.requiredParts.some((part) => !ALLOWED_ROOTS.has(part))) reject("行业载荷组件无效");
    extension = contract.requiredParts;
  }
  // A bundled optional runtime is immutable too: an undeclared Python tree cannot
  // escape indexing just because it is absent from the product contract.
  let optionalPython;
  try { optionalPython = fs.lstatSync(path.join(root, "python")); }
  catch (error) { if (error.code !== "ENOENT") reject("可选组件根不可读取"); }
  if (optionalPython) {
    if (!optionalPython.isDirectory() || optionalPython.isSymbolicLink()) reject("载荷组件根必须是普通目录");
    extension = [...extension, "python"];
  }
  return [...new Set([...ROOTS, ...extension])].sort();
}
function enumerate(root, roots) {
  const files = [];
  const links = [];
  const directories = new Set();
  const visit = (relative) => {
    if (!safePath(relative)) reject("资产路径无效");
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (MUTABLE_PATHS.includes(relative)) {
      if (!stat.isFile() || stat.isSymbolicLink()) reject("可变配置必须是普通文件");
      return;
    }
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      if (!target || /[\0\r\n]/u.test(target) || path.isAbsolute(target) || /^[A-Za-z]:/u.test(target)) reject("链接目标必须为相对路径");
      links.push({ path: relative, target });
    } else if (stat.isDirectory()) {
      directories.add(relative);
      for (const name of fs.readdirSync(absolute).sort()) visit(`${relative}/${name}`);
    } else if (stat.isFile()) files.push({ path: relative, ...fileDigest(absolute) });
    else reject("载荷包含不支持的文件类型");
  };
  for (const part of roots) {
    const stat = fs.lstatSync(path.join(root, part));
    if (!stat.isDirectory() || stat.isSymbolicLink()) reject("载荷组件根必须是普通目录");
    visit(part);
  }
  for (const file of MARKERS) visit(file);
  const indexedFiles = new Set(files.map((entry) => entry.path));
  for (const link of links) {
    let real;
    try { real = fs.realpathSync.native(path.join(root, link.path)); } catch { reject("链接悬空或形成循环"); }
    if (!roots.some((part) => inside(path.join(root, part), real))) reject("链接越出不可变载荷");
    const relative = path.relative(root, real).split(path.sep).join("/");
    if (!indexedFiles.has(relative) && !directories.has(relative)) reject("链接目标未被索引");
  }
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  links.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { files, links };
}
function assertRequiredFiles(files) {
  const entries = new Set(files.map((entry) => entry.path));
  for (const file of [...MARKERS, "runtime/VERSION", "runtime/product.manifest.json", "runtime/.env.defaults", "runtime/scripts/desktop-bootstrap-db.mjs"]) {
    if (!entries.has(file)) reject("必需资产未被索引");
  }
  const win = entries.has("node/node.exe");
  for (const file of [win ? "node/node.exe" : "node/bin/node", ...["postgres", "pg_ctl", "initdb"].map((name) => `pg/bin/${name}${win ? ".exe" : ""}`), `nats/nats-server${win ? ".exe" : ""}`]) {
    if (!entries.has(file)) reject("内嵌运行时入口未被索引");
  }
}
function validateIndex(index, ctx, roots) {
  if (index?.schemaVersion !== SCHEMA || index.productId !== ctx.productId || index.payloadVersion !== ctx.payloadVersion
      || !Array.isArray(index.immutableRoots) || JSON.stringify(index.immutableRoots) !== JSON.stringify(roots)
      || !Array.isArray(index.mutablePaths) || JSON.stringify(index.mutablePaths) !== JSON.stringify(MUTABLE_PATHS)
      || !Array.isArray(index.files) || !Array.isArray(index.links) || index.files.length > 500_000 || index.links.length > 100_000) reject("索引契约或产品版本不匹配");
  const seen = new Set();
  const validEntryPath = (entry) => {
    if (!safePath(entry?.path) || seen.has(entry.path) || MUTABLE_PATHS.includes(entry.path)
        || !(MARKERS.includes(entry.path) || roots.some((part) => entry.path.startsWith(part + "/")))) reject("索引路径无效或重复");
    seen.add(entry.path);
  };
  for (const entry of index.files) {
    validEntryPath(entry);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256)) reject("索引文件摘要无效");
  }
  for (const entry of index.links) {
    validEntryPath(entry);
    if (typeof entry.target !== "string" || !entry.target || /[\0\r\n]/u.test(entry.target)) reject("索引链接目标无效");
  }
  assertRequiredFiles(index.files);
}
function verifyPayloadIntegrity(payloadDir, options = {}) {
  const ctx = context(payloadDir, options);
  const bytes = readSmall(path.join(ctx.root, INDEX_FILE), "完整性索引", 64 * 1024 * 1024);
  let index;
  try { index = JSON.parse(bytes); } catch { reject("完整性索引不是合法 JSON"); }
  const roots = requiredRoots(ctx.root);
  validateIndex(index, ctx, roots);
  const actual = enumerate(ctx.root, roots);
  if (JSON.stringify(actual.files) !== JSON.stringify(index.files) || JSON.stringify(actual.links) !== JSON.stringify(index.links)) reject("资产集合、文件字节或链接目标不匹配");
  return { schemaVersion: SCHEMA, productId: ctx.productId, payloadVersion: ctx.payloadVersion,
    productManifestSha256: ctx.productManifestSha256,
    payloadIntegritySha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    immutableRoots: roots, fileCount: actual.files.length, linkCount: actual.links.length };
}
function generatePayloadIntegrity(payloadDir, options = {}) {
  const ctx = context(payloadDir, options);
  const roots = requiredRoots(ctx.root);
  const actual = enumerate(ctx.root, roots);
  assertRequiredFiles(actual.files);
  const index = { schemaVersion: SCHEMA, productId: ctx.productId, payloadVersion: ctx.payloadVersion,
    immutableRoots: roots, mutablePaths: MUTABLE_PATHS, ...actual };
  const file = path.join(ctx.root, INDEX_FILE);
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return verifyPayloadIntegrity(ctx.root, options);
}

module.exports = { SCHEMA, INDEX_FILE, verifyPayloadIntegrity, generatePayloadIntegrity };
