#!/usr/bin/env node
/** Desktop production web host. Uses only the Node runtime shipped in the payload. */
import { createServer, request as httpRequest } from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, extname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".wasm": "application/wasm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".mp4": "video/mp4", ".txt": "text/plain; charset=utf-8",
};
const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

export function parseWebPort(value, name) {
  const text = String(value);
  if (!/^[0-9]+$/u.test(text) || Number(text) < 1 || Number(text) > 65535) {
    throw new Error(`${name} 端口必须是1到65535的整数`);
  }
  return Number(text);
}

function filteredHeaders(headers) {
  const result = { ...headers };
  for (const name of [...HOP_HEADERS, ...String(headers.connection ?? "").toLowerCase().split(",").map((v) => v.trim())]) {
    delete result[name];
  }
  return result;
}

function respond(res, status, message, extra = {}) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify({ error: message });
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(body);
}

function contained(root, target) {
  const tail = relative(root, target);
  return !isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

function proxy(req, res, backendPort, timeoutMs) {
  const headers = filteredHeaders(req.headers);
  headers.host = `127.0.0.1:${backendPort}`;
  const upstream = httpRequest({ hostname: "127.0.0.1", port: backendPort, path: req.url, method: req.method, headers });
  let failed = false;
  const fail = (status, message) => {
    if (failed) return;
    failed = true;
    respond(res, status, message);
    upstream.destroy();
  };
  // A hard deadline also covers a backend that drips bytes indefinitely.
  const deadline = setTimeout(() => fail(504, "BACKEND_TIMEOUT"), timeoutMs);
  deadline.unref();
  const cleanup = () => clearTimeout(deadline);
  res.once("finish", cleanup);
  res.once("close", () => { cleanup(); if (!res.writableEnded) upstream.destroy(); });
  req.once("aborted", () => { cleanup(); upstream.destroy(); });
  req.once("error", () => fail(502, "REQUEST_INTERRUPTED"));
  upstream.once("error", () => fail(502, "BACKEND_UNAVAILABLE"));
  upstream.once("response", (response) => {
    if (failed || res.destroyed) { response.destroy(); return; }
    res.writeHead(response.statusCode ?? 502, filteredHeaders(response.headers));
    response.once("aborted", () => fail(502, "BACKEND_INTERRUPTED"));
    response.once("error", () => fail(502, "BACKEND_INTERRUPTED"));
    response.pipe(res);
  });
  req.pipe(upstream);
}

export async function createDesktopWebServer({ distDirectory, backendPort = 8787, proxyTimeoutMs = 120_000 } = {}) {
  backendPort = parseWebPort(backendPort, "SERVER_PORT");
  if (!Number.isInteger(proxyTimeoutMs) || proxyTimeoutMs < 1 || proxyTimeoutMs > 600_000) {
    throw new Error("代理超时必须是1到600000毫秒的整数");
  }
  let root;
  let indexFile;
  try {
    root = await realpath(resolve(distDirectory ?? resolve(dirname(fileURLToPath(import.meta.url)), "../apps/web/dist")));
    indexFile = await realpath(resolve(root, "index.html"));
    if (!contained(root, indexFile) || !(await stat(indexFile)).isFile()) throw new Error("invalid index.html");
  } catch (error) {
    throw new Error("桌面工作台构建产物缺失或不可读（apps/web/dist/index.html）", { cause: error });
  }

  async function handle(req, res) {
    const port = server.address()?.port;
    if (!["127.0.0.1", "localhost"].some((host) => req.headers.host === `${host}:${port}`)) {
      respond(res, 403, "INVALID_HOST"); return;
    }
    let pathname;
    try { pathname = decodeURIComponent(String(req.url ?? "").split("?")[0]); }
    catch { respond(res, 400, "INVALID_URL"); return; }
    if (!pathname.startsWith("/") || pathname.startsWith("//") || /[\\\0]/u.test(pathname) || pathname.split("/").some((segment) => segment === ".." || segment.startsWith("."))) {
      respond(res, 403, "FORBIDDEN_PATH"); return;
    }
    if (["/trpc", "/api", "/c"].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) || pathname === "/health") {
      proxy(req, res, backendPort, proxyTimeoutMs); return;
    }
    if (!["GET", "HEAD"].includes(req.method)) { respond(res, 405, "METHOD_NOT_ALLOWED", { allow: "GET, HEAD" }); return; }

    let file = pathname === "/" ? indexFile : resolve(root, `.${pathname}`);
    let info;
    try {
      file = await realpath(file);
      if (!contained(root, file)) { respond(res, 403, "FORBIDDEN_PATH"); return; }
      info = await stat(file);
      if (!info.isFile()) { respond(res, 404, "NOT_FOUND"); return; }
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      const acceptsHtml = !req.headers.accept || /text\/html|\*\/\*/u.test(req.headers.accept);
      if (extname(pathname) || pathname.startsWith("/assets/") || !acceptsHtml) { respond(res, 404, "NOT_FOUND"); return; }
      file = indexFile;
      info = await stat(file);
    }
    const contentType = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    const hashedAsset = pathname.startsWith("/assets/") && /-[\w-]{8,}\.[\w]+$/u.test(pathname);
    res.writeHead(200, {
      "content-type": contentType, "content-length": info.size,
      "cache-control": hashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") { res.end(); return; }
    const stream = createReadStream(file);
    stream.once("error", () => respond(res, 500, "ASSET_UNAVAILABLE"));
    res.once("close", () => stream.destroy());
    stream.pipe(res);
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      // Deliberately omit URL, headers, body and absolute paths from error logs.
      console.error(`[desktop-web] request failed (${error.code ?? "INTERNAL_ERROR"})`);
      respond(res, 500, "WEB_UNAVAILABLE");
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  return server;
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let n = 0; n < args.length; n += 2) {
    const key = { "--dist": "dist", "--port": "port", "--server-port": "serverPort" }[args[n]];
    if (!key || !args[n + 1] || Object.hasOwn(options, key)) throw new Error("用法：desktop-web.mjs [--dist DIR] [--port PORT] [--server-port PORT]");
    options[key] = args[n + 1];
  }
  const port = parseWebPort(options.port ?? process.env.WEB_PORT ?? "5173", "WEB_PORT");
  const backendPort = parseWebPort(options.serverPort ?? process.env.SERVER_PORT ?? "8787", "SERVER_PORT");
  const server = await createDesktopWebServer({ distDirectory: options.dist, backendPort });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolveListen(); });
  });
  server.on("error", (error) => { console.error(`[desktop-web] server failed (${error.code ?? "INTERNAL_ERROR"})`); process.exitCode = 1; server.closeAllConnections(); server.close(); });
  console.log(`[desktop-web] 工作台已启动：http://127.0.0.1:${port}`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeIdleConnections();
    const force = setTimeout(() => server.closeAllConnections(), 5000);
    force.unref();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[desktop-web] ${error.message}`); process.exitCode = 1; });
}
