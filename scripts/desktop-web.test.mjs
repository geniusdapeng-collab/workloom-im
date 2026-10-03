import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDesktopWebServer, parseWebPort } from "./desktop-web.mjs";

const script = fileURLToPath(new URL("./desktop-web.mjs", import.meta.url));

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function fixture(t, backendHandler = (_req, res) => res.end("backend"), timeoutMs = 500) {
  const root = await mkdtemp(join(tmpdir(), "客户 运行时-workloom-web-"));
  const dist = join(root, "dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(dist, "index.html"), "<!doctype html><title>酒店工作台</title>");
  await writeFile(join(dist, "assets", "app-abcdefgh.js"), "export default '酒店';");
  await writeFile(join(dist, "酒店 图标.svg"), "<svg></svg>");
  const backend = createServer(backendHandler);
  const backendPort = await listen(backend);
  const server = await createDesktopWebServer({ distDirectory: dist, backendPort, proxyTimeoutMs: timeoutMs });
  const port = await listen(server);
  t.after(async () => {
    await close(server);
    await close(backend);
    await rm(root, { recursive: true, force: true });
  });
  return { root, dist, backendPort, server, port, url: `http://127.0.0.1:${port}` };
}

function raw(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("静态工作台：首屏、深链接、中文资源、HEAD和构建缓存", async (t) => {
  const f = await fixture(t);
  const home = await raw(f.port, "/");
  assert.equal(home.status, 200);
  assert.match(home.body, /酒店工作台/u);
  assert.equal(home.headers["cache-control"], "no-cache");
  assert.match(home.headers["content-type"], /text\/html/u);
  const route = await raw(f.port, "/workspace/%E9%85%92%E5%BA%97?tab=events", { headers: { accept: "text/html" } });
  assert.equal(route.body, home.body);
  assert.equal((await raw(f.port, "/workspace/none", { headers: { accept: "application/json" } })).status, 404);
  const asset = await raw(f.port, "/assets/app-abcdefgh.js");
  assert.match(asset.headers["cache-control"], /immutable/u);
  assert.match(asset.headers["content-type"], /javascript/u);
  const head = await raw(f.port, "/assets/app-abcdefgh.js", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(head.headers["content-length"], asset.headers["content-length"]);
  assert.equal((await raw(f.port, `/${encodeURIComponent("酒店 图标.svg")}`)).body, "<svg></svg>");
  assert.equal((await raw(f.port, "/assets/missing.js")).status, 404);
  assert.equal((await raw(f.port, "/", { method: "POST" })).status, 405);
});

test("静态边界：原始遍历、编码遍历、隐藏文件、恶意Host与外部软链均不可读取", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "secret.txt"), "not-public");
  await writeFile(join(f.dist, ".env"), "not-public");
  await symlink(join(f.root, "secret.txt"), join(f.dist, "escape.txt"));
  for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/%2eenv", "/.env", "/a%5c..%5csecret.txt", "/%00"]) {
    const response = await raw(f.port, path);
    assert.equal(response.status, 403, path);
    assert.doesNotMatch(response.body, /not-public/u);
  }
  assert.equal((await raw(f.port, "/%ZZ")).status, 400);
  assert.equal((await raw(f.port, "/escape.txt")).status, 403);
  assert.equal((await raw(f.port, "/", { headers: { host: "customer.attacker.invalid" } })).status, 403);
  assert.equal((await raw(f.port, "/", { headers: { host: `localhost:${f.port}` } })).status, 200);
});

test("API代理保留方法、正文、查询、鉴权、Cookie和错误状态；不误代理相似前缀", async (t) => {
  const seen = [];
  const f = await fixture(t, (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(401, { "content-type": "application/json", "set-cookie": ["session=test-only; HttpOnly"], "x-backend": "preserved" });
      res.end('{"error":"unauthorized"}');
    });
  });
  const response = await raw(f.port, "/trpc/dispatch?batch=1", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-only", cookie: "demo=test-only" }, body: '{"question":"你好"}',
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers["x-backend"], "preserved");
  assert.equal(response.headers["set-cookie"][0], "session=test-only; HttpOnly");
  assert.deepEqual({ method: seen[0].method, url: seen[0].url, body: seen[0].body }, { method: "POST", url: "/trpc/dispatch?batch=1", body: '{"question":"你好"}' });
  assert.equal(seen[0].headers.authorization, "Bearer test-only");
  assert.equal(seen[0].headers.cookie, "demo=test-only");
  assert.equal(seen[0].headers.host, `127.0.0.1:${f.backendPort}`);
  for (const path of ["/health", "/api/voice/status", "/c/session"]) assert.equal((await raw(f.port, path)).status, 401);
  const before = seen.length;
  assert.equal((await raw(f.port, "/trpc-other", { headers: { accept: "application/json" } })).status, 404);
  assert.equal(seen.length, before);
});

test("代理后端未运行返回502，挂起返回504，失败后静态服务继续工作", async (t) => {
  const f = await fixture(t, () => {}, 60);
  assert.equal((await raw(f.port, "/health")).status, 504);
  const deadBackend = createServer();
  const deadPort = await listen(deadBackend);
  await close(deadBackend);
  const server = await createDesktopWebServer({ distDirectory: f.dist, backendPort: deadPort, proxyTimeoutMs: 60 });
  const port = await listen(server);
  t.after(() => close(server));
  assert.equal((await raw(port, "/api/voice/status")).status, 502);
  assert.equal((await raw(port, "/")).status, 200);
});

test("并发静态和代理请求互不阻塞，流式返回不会改写结果", async (t) => {
  const f = await fixture(t, (_req, res) => { res.write("first"); setTimeout(() => res.end("last"), 10); });
  const responses = await Promise.all(Array.from({ length: 24 }, (_, n) => raw(f.port, n % 2 ? "/health" : "/")));
  assert.equal(responses.every((r) => r.status === 200), true);
  assert.equal(responses.filter((r) => r.body === "firstlast").length, 12);
});

test("配置非法及缺少构建产物时失败关闭，不加载任何开发依赖", async (t) => {
  for (const value of ["", "0", "65536", " 5173", "5173.5", "abc"]) assert.throws(() => parseWebPort(value, "WEB_PORT"), /端口/u);
  assert.equal(parseWebPort("5173", "WEB_PORT"), 5173);
  const root = await mkdtemp(join(tmpdir(), "no-developer-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(createDesktopWebServer({ distDirectory: root, backendPort: 8787 }), /构建产物/u);
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "index.html"), "isolated-runtime-ok");
  await writeFile(join(root, "vite.config.ts"), 'throw new Error("development config must never run")');
  const portServer = createServer();
  const port = await listen(portServer);
  await close(portServer);
  const child = spawn(process.execPath, [script, "--dist", join(root, "dist"), "--port", String(port), "--server-port", "8787"], {
    cwd: root, env: { PATH: "", NODE_PATH: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  for (let retry = 0; retry < 100 && !output.includes("http://"); retry += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(output, /http:\/\/127\.0\.0\.1/u, errors);
  assert.equal((await raw(port, "/")).body, "isolated-runtime-ok");
  child.kill("SIGTERM");
  const [code] = await once(child, "exit");
  assert.equal(code, 0, errors);
});
