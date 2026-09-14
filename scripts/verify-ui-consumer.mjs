#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_CONTRACTS = Object.freeze([
  {
    packagePath: "apps/web/package.json",
    root: "apps/web",
    marker: "b-pc",
    groups: [
      ["OverlayManager"],
      ["SideNavigation"],
      ["TopContextBar"],
      ["Overlay", "Drawer", "Sheet", "ConfirmDialog"],
      ["Button", "IconButton", "Input", "Select", "Textarea", "Checkbox", "Switch"],
    ],
  },
  {
    packagePath: "apps/webb/package.json",
    root: "apps/webb",
    marker: "b-mobile",
    groups: [
      ["OverlayManager"],
      ["AppShell"],
      ["BottomTabs"],
      ["TopContextBar"],
      ["Overlay", "Drawer", "Sheet", "ConfirmDialog"],
      ["Button", "IconButton", "Input", "Select", "Textarea", "Checkbox", "Switch"],
    ],
  },
  {
    packagePath: "apps/webc/package.json",
    root: "apps/webc",
    marker: "c-mobile",
    groups: [
      ["OverlayManager"],
      ["AppShell"],
      ["BottomTabs"],
      ["TopContextBar"],
      ["Overlay", "Drawer", "Sheet", "ConfirmDialog"],
      ["Button", "IconButton", "Input", "Select", "Textarea", "Checkbox", "Switch"],
    ],
  },
]);

const DUPLICATE_COMPONENTS = new Map([
  ...[
    "AppShell", "Avatar", "Badge", "BottomTabs", "Button", "Card", "Chart", "Checkbox", "Combobox",
    "ConfirmDialog", "Delta", "Dialog", "Drawer", "EmptyState", "ErrorState", "ExportDialog", "FilterBar",
    "FullscreenSurface", "Grid", "IconButton", "Input", "Link", "Overlay", "OverlayManager", "Popover", "Radio",
    "ResizablePanel", "Select", "Sheet", "SideNav", "SideNavigation", "Skeleton", "SplitView", "StatusChip", "Switch",
    "Table", "Tag", "Textarea", "Timeline", "Toast", "Tooltip", "TopContextBar", "WorkspaceSwitcher",
  ].map((name) => [name, name]),
  ["SkeletonBlock", "Skeleton"],
  ["SkeletonList", "Skeleton"],
  ["LoadingSkeleton", "Skeleton"],
  ["EmptyView", "EmptyState"],
  ["NoDataState", "EmptyState"],
  ["StatusBadge", "StatusChip"],
]);
const REQUIRED_STYLES = ["tokens.css", "content-safety.css", "components.css"];
const DEFAULT_ALLOWED_TOKENS = ["--wl-brand-primary", "--wl-brand-on-primary", "--wl-brand-accent"];

function walk(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", ".git", "coverage"].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function collectNamedImports(source) {
  const imported = new Map();
  for (const match of source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']@workloom\/ui["']/g)) {
    for (const raw of (match[1] ?? "").split(",")) {
      const part = raw.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const [original, alias] = part.split(/\s+as\s+/).map((value) => value.trim());
      if (original) imported.set(original, alias || original);
    }
  }
  return imported;
}

function isRendered(source, alias) {
  return new RegExp(`<${alias}(?:\\s|/?>)`).test(source);
}

function contractLabel(group) {
  return group.length === 1 ? group[0] : `以下任一组件：${group.join("、")}`;
}

export function verifyUiConsumerRepo(repoPath, { allowMissingClients = false } = {}) {
  const repo = resolve(repoPath);
  const errors = [];
  const statePath = join(repo, ".workloom-ui.json");
  if (!existsSync(statePath)) return ["缺少 .workloom-ui.json，无法证明行业仓消费的是已发布基座 UI"];

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return [".workloom-ui.json 不是有效 JSON"];
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(state.version ?? "")) errors.push("UI 版本必须是精确 semver，禁止 latest、范围或 workspace 引用");
  if (state.updatePolicy !== "upgrade-pr-only") errors.push("更新策略必须为 upgrade-pr-only");
  if (existsSync(join(repo, "packages/ui"))) errors.push("行业仓存在 packages/ui 公共源码副本；必须删除并消费 registry 制品");

  const required = state.requiredClientPackages ?? CLIENT_CONTRACTS.map((client) => client.packagePath);
  const allowedTokens = new Set(state.allowedIndustryOverrides ?? DEFAULT_ALLOWED_TOKENS);
  for (const relativePath of required) {
    if (!CLIENT_CONTRACTS.some((client) => client.packagePath === relativePath)) {
      errors.push(`未知生产客户端契约：${relativePath}`);
    }
  }

  for (const client of CLIENT_CONTRACTS.filter((candidate) => required.includes(candidate.packagePath))) {
    const packagePath = join(repo, client.packagePath);
    if (!existsSync(packagePath)) {
      if (!allowMissingClients) errors.push(`缺少生产客户端：${client.packagePath}`);
      continue;
    }
    let packageJson;
    try {
      packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    } catch {
      errors.push(`${client.packagePath} 不是有效 JSON`);
      continue;
    }
    const actual = packageJson.dependencies?.[state.package];
    if (actual !== state.version) errors.push(`${client.packagePath} 必须精确依赖 ${state.package}@${state.version}，当前为 ${actual ?? "未接入"}`);

    const entryPath = join(repo, client.root, "src/main.tsx");
    if (!existsSync(entryPath)) {
      errors.push(`${client.root} 缺少生产入口 src/main.tsx`);
      continue;
    }
    const entry = readFileSync(entryPath, "utf8");
    for (const style of REQUIRED_STYLES) {
      if (!entry.includes(`@workloom/ui/${style}`)) errors.push(`${client.root}/src/main.tsx 缺少共享样式 ${style}`);
    }

    const sourceFiles = walk(join(repo, client.root, "src"))
      .filter((file) => /\.(?:tsx|jsx)$/.test(file) && !/\.test\.(?:tsx|jsx)$/.test(file));
    const source = sourceFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    if (!source.includes(`data-workloom-client="${client.marker}"`)) {
      errors.push(`${client.root} 缺少客户端身份标记 data-workloom-client="${client.marker}"`);
    }
    const imports = collectNamedImports(source);
    for (const group of client.groups) {
      const consumed = group.some((name) => {
        const alias = imports.get(name);
        return alias && isRendered(source, alias);
      });
      if (!consumed) errors.push(`${client.root} 未实际渲染共享基座组件 ${contractLabel(group)}`);
    }

    for (const file of sourceFiles) {
      const base = file.split("/").pop()?.replace(/\.(?:tsx|jsx)$/, "") ?? "";
      const fileCanonical = DUPLICATE_COMPONENTS.get(base);
      if (fileCanonical) errors.push(`${relative(repo, file)} 与共享基座组件 ${fileCanonical} 同义，疑似本地复制分叉`);
      const localSource = readFileSync(file, "utf8");
      for (const [name, canonical] of DUPLICATE_COMPONENTS) {
        if (new RegExp(`(?:export\\s+)?(?:function|class)\\s+${name}\\b|(?:export\\s+)?const\\s+${name}\\s*=`).test(localSource)) {
          errors.push(`${relative(repo, file)} 本地定义 ${name}（共享语义 ${canonical}），必须改为共享组件或使用明确的行业复合组件名`);
        }
      }
    }

    for (const file of walk(join(repo, client.root, "src")).filter((candidate) => /\.(?:css|scss)$/.test(candidate))) {
      const css = readFileSync(file, "utf8");
      for (const match of css.matchAll(/(--wl-[A-Za-z0-9-]+)\s*:/g)) {
        if (!allowedTokens.has(match[1])) errors.push(`${relative(repo, file)} 重新定义共享令牌 ${match[1]}，行业仓只允许品牌变量`);
      }
    }
  }

  for (const file of walk(join(repo, "apps"))) {
    if (!/\.(?:css|scss|tsx?|jsx?|html)$/.test(file)) continue;
    const source = readFileSync(file, "utf8");
    if (/design-system\/(?:tokens|components)/.test(source)) errors.push(`${relative(repo, file)} 仍引用旧版设计副本`);
  }
  return [...new Set(errors)];
}

function main() {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const repo = resolve(value("--repo", "."));
  const errors = verifyUiConsumerRepo(repo, { allowMissingClients: args.includes("--allow-missing-clients") });
  if (errors.length) {
    console.error(`❌ 行业仓 UI 消费门禁失败（${errors.length} 项）`);
    for (const error of errors) console.error(`  · ${error}`);
    process.exit(1);
  }
  const state = JSON.parse(readFileSync(join(repo, ".workloom-ui.json"), "utf8"));
  console.log(`✅ 三端实际消费 ${state.package}@${state.version} 的共享壳、弹层、表单与样式；未发现公共 UI 源码副本`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
