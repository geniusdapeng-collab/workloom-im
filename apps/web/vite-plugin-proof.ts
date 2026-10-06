/**
 * 编译期契约证明：scripts/vite-product.d.mts 声明的 plugin 必须真正满足 Vite 的 Plugin。
 *
 * 落在 apps/web typecheck 范围内（`pnpm -r --if-present typecheck` 与 static-gate 都会执行），
 * 而 apps/web 能解析真实的 vite 类型。声明一旦与 Vite 真实 hook 契约脱节——手工缩减结构、
 * 参数不兼容或 hook 名写错——这里会直接编译失败，而不是只靠文本断言“提及了 hook 名”蒙混过关。
 */
import type { Plugin } from "vite";
import { workloomProductVite } from "../../scripts/vite-product.mjs";

// 正向证明 1：声明的 plugin 类型可赋给 Vite 的真实 Plugin。
type DeclaredPlugin = ReturnType<typeof workloomProductVite>["plugin"];
export const declaredPluginIsVitePlugin: Plugin = null as unknown as DeclaredPlugin;

// 正向证明 2：真实实现满足声明（含 name 字面量），并经声明赋给 Vite Plugin。
const product = workloomProductVite("B 端工作台");
export const implementation: DeclaredPlugin = product.plugin;
export const implementationAsVitePlugin: Plugin = implementation;

// 反向证明：不兼容的 hook 结构必须被判为不可赋值；若这里成立则说明断言失去意义，
// 会因 false 不可赋给 true 而编译失败。
type IsAssignable<From, To> = [From] extends [To] ? true : false;
export const rejectsIncompatibleHook: IsAssignable<
  { readonly name: string; configureServer(server: { readonly totallyWrong: true }): void },
  Plugin
> = false;
