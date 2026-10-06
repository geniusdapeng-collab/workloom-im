/** Generic product-manifest runtime extension; business names and commands live in the payload contract. */
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = "workloom.industry-runtime/v1";
const PAYLOAD_PARTS = new Set(["runtime", "node", "pg", "nats", "python"]);
const SYSTEM_ENV = new Set(["HOME", "USERPROFILE", "CODEX_HOME", "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]);
/**
 * Desktop-managed product configuration. `industryEnv` is layered on top of the
 * .env values that bootstrap itself derives (database URLs, generated secrets,
 * ports), so an industry contract that is allowed to name these keys would be
 * able to point the runtime at another database or replace a generated secret.
 * The spread order is therefore not the only defence: the contract is refused
 * outright, and every platform-managed family stays reserved.
 */
const RESERVED_ENV = Object.freeze([
  /^DATABASE_URL$/u,
  /^DATABASE_APP_URL$/u,
  /^DATABASE_GATEWAY_URL$/u,
  /^(?:APP|GATEWAY)_DB_PASSWORD$/u,
  /^JWT_SECRET$/u,
  /^PII_SALT$/u,
  /^SERVICE_C_/u,
  /^WORKLOOM_/u,
  /_(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|KEY|SALT)$/u,
]);

function reservedEnvKey(key) {
  return RESERVED_ENV.some((pattern) => pattern.test(key));
}

function readIndustryContract(runtimeRoot) {
  const file = path.join(runtimeRoot, "industry-runtime.json");
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000) throw new Error("行业运行契约必须为受控普通 JSON 文件");
  let contract;
  try { contract = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("行业运行契约不是合法 JSON"); }
  if (contract?.schemaVersion !== SCHEMA || !Array.isArray(contract.requiredParts)
      || contract.requiredParts.some((part) => !PAYLOAD_PARTS.has(part))
      || new Set(contract.requiredParts).size !== contract.requiredParts.length) throw new Error("行业运行契约格式或载荷组件无效");
  return contract;
}

function requiredIndustryParts(sourceRoot) {
  return readIndustryContract(path.join(sourceRoot, "runtime"))?.requiredParts ?? [];
}

function runtimeReference(value, roots, { required = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(roots, value.root)
      || typeof value.path !== "string" || !value.path || value.path.includes("\0") || path.isAbsolute(value.path)
      || value.path.split(/[\\/]/u).some((part) => !part || part === ".." || part === ".")) throw new Error("行业运行引用路径无效");
  const root = path.resolve(roots[value.root]);
  const file = path.resolve(root, value.path);
  if (!file.startsWith(root + path.sep)) throw new Error("行业运行引用越出载荷根目录");
  let ancestor = file;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realRoot = fs.realpathSync(root);
  const realAncestor = fs.realpathSync(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) throw new Error("行业运行引用通过链接越出载荷根目录");
  if (fs.existsSync(file)) {
    const real = fs.realpathSync(file);
    if (!real.startsWith(realRoot + path.sep)) throw new Error("行业运行引用通过链接越出载荷根目录");
    if (required && !fs.statSync(real).isFile()) throw new Error("行业运行必需入口不是普通文件");
  } else if (required || value.required === true) throw new Error(`行业运行必需入口缺失：${value.path}`);
  return file;
}

function resolveIndustryRuntime({ runtimeRoot, supportDir, platform = process.platform, arch = process.arch }) {
  const contract = readIndustryContract(runtimeRoot);
  if (!contract) return { environment: {}, selftests: [] };
  const target = platform === "darwin" ? `mac-${arch}` : platform === "win32" ? `win-${arch}` : `${platform}-${arch}`;
  const product = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "product.manifest.json"), "utf8"));
  if (typeof contract.productId !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(contract.productId)
      || contract.productId !== product?.productId || contract.target !== target) throw new Error("行业运行契约的产品身份或目标平台不匹配");
  const roots = { runtime: runtimeRoot, support: supportDir };
  if (!Array.isArray(contract.requiredFiles) || !contract.requiredFiles.length) throw new Error("行业运行契约缺少必需入口清单");
  for (const file of contract.requiredFiles) runtimeReference(file, roots, { required: true });
  if (!contract.environment || typeof contract.environment !== "object" || Array.isArray(contract.environment)) throw new Error("行业运行契约缺少环境定义");
  const environment = {};
  for (const [key, value] of Object.entries(contract.environment)) {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/u.test(key) || SYSTEM_ENV.has(key)) throw new Error("行业运行契约不得覆盖宿主系统环境");
    if (reservedEnvKey(key)) throw new Error("行业运行契约不得覆盖桌面受管配置");
    if (typeof value === "string") {
      if (value.includes("\0") || value.length > 10000) throw new Error("行业运行环境值无效");
      environment[key] = value;
    } else environment[key] = runtimeReference(value, roots);
  }
  if (!Array.isArray(contract.selftests) || !contract.selftests.length || contract.selftests.length > 8) throw new Error("行业运行契约必须提供离线自检");
  const selftests = contract.selftests.map((check) => {
    if (typeof check?.name !== "string" || !/^[A-Za-z0-9_-]{1,80}$/u.test(check.name)
        || !Array.isArray(check.args) || check.args.length > 40
        || check.args.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 10000)
        || typeof check.expectedStdout !== "string" || check.expectedStdout.length > 1000) throw new Error("行业运行离线自检定义无效");
    return { name: check.name, executable: runtimeReference(check.executable, roots, { required: true }),
      args: check.args, expectedStdout: check.expectedStdout };
  });
  return { environment, selftests };
}

module.exports = { readIndustryContract, requiredIndustryParts, reservedEnvKey, runtimeReference, resolveIndustryRuntime };
