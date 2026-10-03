/**
 * PC 页面登记的运行时边界。只读取构建产物与源码摘要，不导入 React、Vite 或测试运行器。
 * 页面登记由 PC 实際路由生成；行业包的 cases.pages 只是说明，不能自行授予页面能力。
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PC_PAGE_REGISTRY_SCHEMA = "workloom.pc-pages/v1";
export const PC_PAGE_REGISTRY_SOURCE = "apps/web/src/projections/pc-page-registry.json";
export const PC_PAGE_REGISTRY_ARTIFACT = "apps/web/dist/pc-page-registry.json";
const HERE = dirname(fileURLToPath(import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/;
const CAPABILITY = /^[a-z0-9][a-z0-9-]{1,31}\.[a-z0-9][a-z0-9.-]{1,95}$/;
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|js|mjs|json)$/;
const byName = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort(byName).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function pcPageRegistryDigest(value) {
  const { digest: _digest, ...payload } = value;
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

function relativePath(path) {
  return typeof path === "string" && path.length > 0 && !isAbsolute(path)
    && !path.includes("\\") && path.split("/").every((part) => part && part !== "." && part !== "..");
}

function ordinaryFile(root, path) {
  if (!relativePath(path)) throw new Error(`页面登记包含非规范文件路径：${String(path)}`);
  const target = resolve(root, path);
  const entry = lstatSync(target);
  const outside = relative(realpathSync(root), realpathSync(target));
  if (!entry.isFile() || entry.isSymbolicLink() || outside.startsWith("..") || isAbsolute(outside)) {
    throw new Error(`页面登记文件必须位于当前产品目录：${path}`);
  }
  return target;
}

function routePath(path) {
  return typeof path === "string" && (path === "/" || /^\/[a-z0-9][a-z0-9-]*(?:\/(?:[a-z0-9][a-z0-9-]*|:[a-z][A-Za-z0-9]*))*$/.test(path));
}

function routeShape(path) {
  return path.split("/").map((segment) => segment.startsWith(":") ? ":" : segment).join("/");
}

function routeParameters(path) {
  return path.split("/").filter((segment) => segment.startsWith(":")).sort(byName).join("/");
}

function hashes(input, label, allowEmpty) {
  if (!object(input) || (!allowEmpty && Object.keys(input).length === 0)) throw new Error(`页面登记缺少${label}摘要`);
  for (const [path, digest] of Object.entries(input)) {
    if (!relativePath(path) || typeof digest !== "string" || !SHA256.test(digest)) throw new Error(`页面登记的${label}摘要无效：${path}`);
  }
}

/** 无默认值、无部分加载：任何冲突或不认识的字段都拒绝整个登记。 */
export function parsePcPageRegistry(input) {
  if (!object(input) || input.schemaVersion !== PC_PAGE_REGISTRY_SCHEMA
    || Object.keys(input).some((key) => !["schemaVersion", "routes", "sources", "artifacts", "digest"].includes(key))
    || !Array.isArray(input.routes) || input.routes.length === 0 || input.routes.length > 1000) {
    throw new Error("工作台页面登记格式无效");
  }
  hashes(input.sources, "来源", false);
  if (input.artifacts !== undefined) hashes(input.artifacts, "构建文件", false);
  const seen = new Set();
  for (const definition of input.routes) {
    if (!object(definition) || !routePath(definition.path)
      || !["base", "industry"].includes(definition.source)
      || !Array.isArray(definition.legacyPaths)
      || Object.keys(definition).some((key) => !["path", "source", "legacyPaths", "capabilityId"].includes(key))) {
      throw new Error("工作台页面登记存在无效路由");
    }
    if (definition.source === "base" && definition.capabilityId !== undefined) throw new Error("公共页面不能声明行业能力");
    if (definition.source === "industry"
      && (typeof definition.capabilityId !== "string" || !CAPABILITY.test(definition.capabilityId)
        || definition.capabilityId.startsWith("workloom.") || /^\/p\d+(?:\/|$)/.test(definition.path))) {
      throw new Error("行业页面缺少有效的独立能力声明");
    }
    for (const path of [definition.path, ...definition.legacyPaths]) {
      if (!routePath(path) || routeParameters(path) !== routeParameters(definition.path)) throw new Error("页面登记的历史地址与主路由不一致");
      const shape = routeShape(path);
      if (seen.has(shape)) throw new Error(`页面登记包含重复路由：${path}`);
      seen.add(shape);
    }
  }
  if (typeof input.digest !== "string" || !SHA256.test(input.digest) || input.digest !== pcPageRegistryDigest(input)) {
    throw new Error("工作台页面登记与完整性摘要不一致");
  }
  return input;
}

export function sealPcPageRegistry({ routes, sources, artifacts }) {
  const value = {
    schemaVersion: PC_PAGE_REGISTRY_SCHEMA,
    routes: [...routes].sort((left, right) => byName(left.path, right.path)),
    sources: Object.fromEntries(Object.entries(sources).sort(([left], [right]) => byName(left, right))),
    ...(artifacts === undefined ? {} : { artifacts: Object.fromEntries(Object.entries(artifacts).sort(([left], [right]) => byName(left, right))) }),
  };
  return parsePcPageRegistry({ ...value, digest: pcPageRegistryDigest(value) });
}

/** 覆盖整个 PC 源码树，新增/移除扩展或改变页面实现都会使旧登记失效。 */
export function pcPageSourceHashes(root) {
  const directory = join(root, "apps/web/src");
  const paths = [];
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("工作台源码树不接受符号链接");
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) {
        const name = relative(root, path).replaceAll("\\", "/");
        if (name !== PC_PAGE_REGISTRY_SOURCE) paths.push(name);
      }
    }
  }
  visit(directory);
  for (const required of ["apps/web/src/App.tsx", "apps/web/src/shell/IndustryRoutes.tsx"]) {
    if (!paths.includes(required)) throw new Error(`当前产品缺少真实路由入口：${required}`);
  }
  return Object.fromEntries(paths.sort(byName).map((path) => [
    path, createHash("sha256").update(readFileSync(ordinaryFile(root, path))).digest("hex"),
  ]));
}

export function assertPcPageSources(registry, root) {
  const current = pcPageSourceHashes(root);
  if (canonical(current) !== canonical(registry.sources)) throw new Error("工作台页面登记已过期或来自其他产品，请重新生成当前工作台登记");
}

/** Vite 还会复制 public 的页面、脚本和样式；登记必须绑定完整的最终 PC 文件集合。 */
export function pcPageArtifactHashes(directory) {
  const artifacts = {};
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("工作台构建目录不接受符号链接");
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(?:js|mjs|html|css)$/.test(entry.name)) {
        const name = relative(directory, path).replaceAll("\\", "/");
        artifacts[name] = createHash("sha256").update(readFileSync(ordinaryFile(directory, name))).digest("hex");
      }
    }
  }
  visit(directory);
  if (!artifacts["index.html"] || !Object.keys(artifacts).some((name) => /\.(?:js|mjs)$/.test(name))) {
    throw new Error("真实工作台构建缺少入口页面及脚本");
  }
  return Object.fromEntries(Object.entries(artifacts).sort(([left], [right]) => byName(left, right)));
}

/** 仓库与扁平 node_modules 载荷各有固定根；自定义 Bundle 目录不能换掉 PC 产品根。 */
export function pcPageProductRoot() {
  for (const candidate of [resolve(HERE, "../../.."), resolve(HERE, "../../../..")]) {
    if (existsSync(join(candidate, "apps/web/src/App.tsx"))) return candidate;
  }
  throw new Error("当前产品缺少工作台页面来源");
}

export function loadPcPageRegistry({ root = pcPageProductRoot(), production = process.env.NODE_ENV === "production" } = {}) {
  const path = production ? PC_PAGE_REGISTRY_ARTIFACT : PC_PAGE_REGISTRY_SOURCE;
  let registry;
  try {
    registry = parsePcPageRegistry(JSON.parse(readFileSync(ordinaryFile(root, path), "utf8")));
  } catch (error) {
    throw new Error(`工作台页面登记不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  assertPcPageSources(registry, root);
  if (production) {
    if (!registry.artifacts?.["index.html"] || !Object.keys(registry.artifacts).some((name) => /\.(?:js|mjs)$/.test(name))) {
      throw new Error("生产工作台页面登记缺少真实客户端构建文件");
    }
    const current = pcPageArtifactHashes(join(root, "apps/web/dist"));
    if (canonical(Object.keys(current)) !== canonical(Object.keys(registry.artifacts).sort(byName))) {
      throw new Error("生产工作台构建文件清单与页面登记不一致");
    }
    for (const [name, digest] of Object.entries(registry.artifacts)) {
      if (current[name] !== digest) {
        throw new Error(`生产工作台构建文件与页面登记不一致：${name}`);
      }
    }
  }
  return registry;
}

function definitionCaseIds(definition) {
  return [definition.path, ...definition.legacyPaths].flatMap((path) => {
    const numbered = /^\/(p\d+)(?:\/|$)/.exec(path);
    return numbered ? [path, numbered[1]] : [path];
  });
}

/** 行业页面必须属于本 Bundle，并有同能力、覆盖该路径的 PC 导航及显式自有权限。 */
export function registeredBundlePcPages(registry, manifest) {
  const pages = new Set();
  const namespace = `${manifest.workloom.industry}.`;
  const ui = manifest.workloom.ui;
  const permissions = new Set(ui.permissions);
  for (const definition of registry.routes) {
    if (definition.source === "industry") {
      if (!definition.capabilityId.startsWith(namespace)) continue;
      const representative = definition.path.replace(/:[a-z][A-Za-z0-9]*/g, "example");
      const slot = ui.navigation.slots.find((entry) => entry.capabilityId === definition.capabilityId
        && entry.clients.includes("pc")
        && (representative === entry.route || representative.startsWith(`${entry.route}/`))
        && entry.permissions.length > 0
        && entry.permissions.every((permission) => permission.startsWith(namespace) && permissions.has(permission)));
      if (!slot) continue;
    }
    for (const page of definitionCaseIds(definition)) pages.add(page);
  }
  return [...pages].sort(byName);
}

export function validateBundlePcCases(casesDocument, registry, manifest) {
  if (!object(casesDocument) || !Array.isArray(casesDocument.cases) || casesDocument.cases.length === 0) {
    return { ok: false, pages: [], caseCount: 0, detail: "缺少非空的界面状态用例清单" };
  }
  const cases = casesDocument.cases;
  if (cases.some((item) => !object(item) || typeof item.page !== "string" || !item.page.trim()
    || typeof item.name !== "string" || !item.name.trim())) {
    return { ok: false, pages: [], caseCount: cases.length, detail: "界面状态用例缺少有效页面或用例名称" };
  }
  const pages = [...new Set(cases.map((item) => item.page))].sort(byName);
  const registered = new Set(registeredBundlePcPages(registry, manifest));
  const unknown = pages.filter((page) => !registered.has(page));
  return unknown.length
    ? { ok: false, pages, caseCount: cases.length, detail: `用例引用了未注册或未获本行业授权的页面：${unknown.join("、")}` }
    : { ok: true, pages, caseCount: cases.length, detail: `${pages.length} 个页面 · ${cases.length} 条界面状态用例已就位` };
}
