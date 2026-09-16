// pack-nm-merge.mjs —— 合并 monorepo 运行期直接依赖为单一 package.json
// 用途：pack-windows.sh 在其输出目录执行 npm install，得到扁平无链接的 node_modules
//      （pnpm 的 symlink 布局无法经受 Windows zip 打包-解压往返，见 v2.0.8 冒烟实证）
// 规则：
//   收集 root.dependencies + apps/server.dependencies + packages/{shared,db,base,runtime}.dependencies
//   + 运行期工具：tsx（启动器执行 .ts）、vite（preview 静态服务）
//   过滤：workspace:* 协议（内部包，源码随包）/ electron* / playwright*（运行期不需要）
//   冲突：后写覆盖先写并告警（monorepo 版本基本对齐，运行期可容忍）
// 用法：node scripts/pack-nm-merge.mjs <输出 package.json 路径>
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPayloadPolicy } from "./payload-policy.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_VALUE = (v) => typeof v === "string" && v.startsWith("workspace:");
const SKIP_NAME = (n) => /^(electron|electron-builder|@electron|playwright|@playwright)/.test(n);

export function runtimeDependencySources(root, policy) {
  // packages/*/package.json 动态收集（行业仓有自定义包，如 @hyperreality/video-studio——
  // v1.0.0 硬编码四包漏收集其运行依赖实证）
  const pkgSources = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => [`packages/${d.name}/package.json`, ["dependencies"]]);

  // platform-ops 的物理存在不是授权。只有仙女座精确产品身份允许收集；
  // 身份允许却缺包时也必须失败，避免发布一个名义上是运营中枢、实际残缺的载荷。
  if (policy.includePlatformOps) {
    if (!existsSync(join(root, "platform-ops/package.json"))) {
      throw new Error("仙女座正式载荷缺少 platform-ops/package.json");
    }
    pkgSources.push(["platform-ops/package.json", ["dependencies"]]);
  }

  return [
    ["package.json", ["dependencies"]],
    ["apps/server/package.json", ["dependencies"]],
    ...pkgSources,
    // 运行期工具（来自 devDependencies，仅取这两个）
    ["package.json", ["devDependencies"], ["tsx"]],
    ["apps/web/package.json", ["devDependencies"], ["vite", "@tailwindcss/vite", "@vitejs/plugin-react"]],
  ];
}

export function buildMergedRuntimeManifest(root, policy) {
  const deps = {};
  for (const [file, fields, only] of runtimeDependencySources(root, policy)) {
    let pkg;
    try { pkg = JSON.parse(readFileSync(join(root, file), "utf8")); }
    catch { console.warn(`⚠️ 缺 ${file}，跳过`); continue; }
    for (const field of fields) {
      for (const [name, ver] of Object.entries(pkg[field] ?? {})) {
        if (SKIP_NAME(name) || SKIP_VALUE(ver)) continue;
        if (only && !only.includes(name)) continue;
        if (deps[name] && deps[name] !== ver) console.warn(`⚠️ 版本冲突 ${name}: ${deps[name]} → ${ver}（${file}，后者生效）`);
        deps[name] = ver;
      }
    }
  }
  return {
    name: "workloom-runtime-payload",
    private: true,
    version: "0.0.0",
    description: "正式桌面运行期依赖合成（npm 扁平化安装用，自动生成勿手改）",
    dependencies: Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function main() {
  const out = process.argv[2];
  if (!out) throw new Error("用法：node scripts/pack-nm-merge.mjs <输出路径>");
  const policy = loadPayloadPolicy(ROOT);
  const merged = buildMergedRuntimeManifest(ROOT, policy);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(merged, null, 2) + "\n");
  console.log(`✅ 合成 ${out}：${Object.keys(merged.dependencies).length} 个直接依赖（platform-ops: ${policy.includePlatformOps ? "include" : "exclude"}）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
