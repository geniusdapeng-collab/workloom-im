/**
 * 三端 Vite 构建身份桥的类型声明（与 scripts/vite-product.mjs 同源）。
 *
 * plugin 直接绑定 Vite 真实 `Plugin` 类型，而不是手工缩减的 connect/Vite 结构：
 * 手工结构在 strictFunctionTypes 下与真实 hook 参数不构成可赋值关系，
 * 一旦 Vite 的 server 类型演进就会静默失信。这里由 Vite 自己保证契约。
 */
import type { Plugin } from "vite";

export interface WorkLoomViteProduct {
  readonly define: Readonly<Record<string, string>>;
  readonly plugin: Plugin & { readonly name: "workloom-product-identity" };
}

export function workloomProductVite(clientLabel: string): WorkLoomViteProduct;
