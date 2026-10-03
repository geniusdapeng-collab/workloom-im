/** 无生产依赖；结构与 Vite 构建插件契约一致，供 web 的 TypeScript 配置校验。 */
export interface WorkLoomPcPageRegistryPlugin {
  readonly name: string;
  readonly apply: "build";
  readonly enforce: "post";
  configResolved(config: { root: string; build: { outDir: string } }): void;
  buildStart(): void;
  readonly generateBundle: {
    readonly order: "post";
    handler(options: unknown, bundle: Record<string, unknown>): void;
  };
  readonly writeBundle: {
    readonly order: "post";
    handler(options: { dir?: string }): void;
  };
}
export function workloomPcPageRegistry(): WorkLoomPcPageRegistryPlugin;
