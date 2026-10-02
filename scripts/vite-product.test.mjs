import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workloomProductVite } from "./vite-product.mjs";
import { loadProductRuntime } from "./product-runtime.mjs";
const product = loadProductRuntime(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

test("product transform derives one protected meta/title from the manifest", () => {
  const { plugin } = workloomProductVite("测试客户端");
  const html = plugin.transformIndexHtml('<html><head><meta name="workloom-product-id" content="stale-fixture"><title data-workloom-product-title>fixture</title></head><body></body></html>');
  assert.equal((html.match(/name="workloom-product-id"/gu) ?? []).length, 1);
  assert.ok(html.includes(`<meta name="workloom-product-id" content="${product.productId}">`));
  assert.ok(html.includes(`${product.displayName} · 测试客户端`));
  assert.equal(html.includes("stale-fixture"), false);
  assert.throws(() => plugin.transformIndexHtml("<title>uncontrolled</title>"), /受控产品标题/u);
});
for (const hook of ["configureServer", "configurePreviewServer"]) {
  test(`actual ${hook} middleware serves current product and launch headers`, async () => {
    const old = process.env.WORKLOOM_INSTANCE_ID;
    const uuid = "6f0f4549-17c9-44ab-9b45-3ce8ba3feef0";
    let middleware;
    const productPlugin = workloomProductVite("测试客户端").plugin;
    productPlugin[hook]({ middlewares: { use(value) { middleware = value; } } });
    const server = createServer((request, response) => middleware(request, response, () => response.end("fixture-ok")));
    try {
      process.env.WORKLOOM_INSTANCE_ID = uuid;
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const first = await fetch(`http://127.0.0.1:${server.address().port}`);
      assert.equal(first.headers.get("x-workloom-product-id"), product.productId);
      assert.equal(first.headers.get("x-workloom-instance-id"), uuid);
      assert.equal(await first.text(), "fixture-ok");
      delete process.env.WORKLOOM_INSTANCE_ID;
      const second = await fetch(`http://127.0.0.1:${server.address().port}`);
      assert.equal(second.headers.get("x-workloom-instance-id"), null);
      assert.equal(second.headers.get("x-workloom-product-id"), product.productId);
      await second.text();
    } finally {
      if (old === undefined) delete process.env.WORKLOOM_INSTANCE_ID; else process.env.WORKLOOM_INSTANCE_ID = old;
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
