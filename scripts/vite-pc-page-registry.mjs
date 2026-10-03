/** PC 构建时绑定真实路由、来源和最终客户端文件；服务端只消费这些静态登记。 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  assertPcPageSources,
  pcPageArtifactHashes,
  PC_PAGE_REGISTRY_SOURCE,
  sealPcPageRegistry,
} from "../packages/base/bundles/pc-page-registry.mjs";
import { generatePcPageRegistry } from "./generate-pc-page-registry.mjs";

export function workloomPcPageRegistry() {
  let root;
  let webRoot;
  let outDir;
  let registry;
  return {
    name: "workloom-pc-page-registry",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      root = resolve(config.root, "../..");
      webRoot = config.root;
      outDir = config.build.outDir;
    },
    buildStart() {
      registry = generatePcPageRegistry(root);
      const source = join(root, PC_PAGE_REGISTRY_SOURCE);
      mkdirSync(dirname(source), { recursive: true });
      writeFileSync(source, `${JSON.stringify(registry, null, 2)}\n`);
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        if (!registry) throw new Error("生产构建缺少真实工作台页面登记");
        assertPcPageSources(registry, root);
        const artifacts = {};
        for (const [name, artifact] of Object.entries(bundle)) {
          if (!/\.(?:js|mjs|html|css)$/.test(name)) continue;
          const bytes = artifact.type === "chunk" ? artifact.code : artifact.source;
          artifacts[name] = createHash("sha256").update(bytes).digest("hex");
        }
        if (!artifacts["index.html"] || !Object.keys(artifacts).some((name) => /\.(?:js|mjs)$/.test(name))) {
          throw new Error("真实工作台构建没有产出入口页面及脚本");
        }
        this.emitFile({
          type: "asset",
          fileName: "pc-page-registry.json",
          source: `${JSON.stringify(sealPcPageRegistry({ ...registry, artifacts }), null, 2)}\n`,
        });
      },
    },
    writeBundle: {
      order: "post",
      handler(options) {
        if (!registry) throw new Error("生产构建缺少真实工作台页面登记");
        assertPcPageSources(registry, root);
        const directory = resolve(webRoot, options.dir ?? outDir);
        const artifacts = pcPageArtifactHashes(directory);
        writeFileSync(join(directory, "pc-page-registry.json"), `${JSON.stringify(sealPcPageRegistry({ ...registry, artifacts }), null, 2)}\n`);
      },
    },
  };
}
