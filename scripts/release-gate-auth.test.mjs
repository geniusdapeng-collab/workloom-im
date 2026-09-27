import assert from "node:assert/strict";
import test from "node:test";
import { releaseGateLogin } from "./release-gate-auth.mjs";

const target = { base: "http://127.0.0.1:8787/", workspaceSlug: "example", memberNo: "MEM-001" };
const accountEmail = ["owner", "example.test"].join("@");
const accountPassword = ["test", "password"].join("-");
const demoToken = ["local", "demo", "token"].join("-");
const formalToken = ["formal", "access", "token"].join("-");

function reply(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

test("本机发布门禁可用演示身份，目标与请求体固定到目标工作区", async () => {
  const calls = [];
  const token = await releaseGateLogin({
    ...target, nodeEnv: "development", email: "", password: "",
    request: async (url, options) => {
      calls.push({ url, options });
      return reply({ result: { data: { token: demoToken } } });
    },
  });
  assert.equal(token, demoToken);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8787/trpc/auth.loginAs");
  assert.deepEqual(JSON.parse(calls[0].options.body), { workspaceSlug: "example", memberNo: "MEM-001" });
});

test("生产发布门禁缺少正式账号时在网络调用前失败", async () => {
  let called = false;
  await assert.rejects(releaseGateLogin({
    ...target, nodeEnv: "production", email: "", password: "",
    request: async () => { called = true; throw new Error("不应调用网络"); },
  }), /生产发布门禁必须注入正式账号凭据/);
  assert.equal(called, false);
});

test("正式账号登录不回退演示身份，使用 accessToken 且不写出凭据", async () => {
  const calls = [];
  const token = await releaseGateLogin({
    ...target, nodeEnv: "production", email: ` ${accountEmail} `, password: accountPassword,
    request: async (url, options) => {
      calls.push({ url, options });
      return reply({ result: { data: { accessToken: formalToken } } });
    },
  });
  assert.equal(token, formalToken);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8787/trpc/accounts.auth.loginWithPassword");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    email: accountEmail, password: accountPassword, workspaceSlug: "example", device: "release-gate",
  });
});

test("正式账号凭据只填一项时拒绝发送请求", async () => {
  for (const credentials of [
    { email: accountEmail, password: "" },
    { email: "", password: accountPassword },
  ]) {
    await assert.rejects(releaseGateLogin({
      ...target, nodeEnv: "development", ...credentials,
      request: async () => { throw new Error("不应调用网络"); },
    }), /需同时设置/);
  }
});

test("正式账号凭据不会发往远端明文 HTTP 或含 URL 凭据的地址", async () => {
  const credentialUrl = new URL("https://release.example.test");
  credentialUrl.username = "user";
  credentialUrl.password = ["test", "credential"].join("-");
  for (const base of ["http://release.example.test:8787", credentialUrl.href]) {
    let called = false;
    await assert.rejects(releaseGateLogin({
      ...target, base, nodeEnv: "production", email: accountEmail, password: accountPassword,
      request: async () => { called = true; throw new Error("不应调用网络"); },
    }), /只能通过 HTTPS|不得包含 URL 凭据/);
    assert.equal(called, false);
  }
});

test("正式账号可通过远端 HTTPS 登录", async () => {
  const token = await releaseGateLogin({
    ...target, base: "https://release.example.test", nodeEnv: "production",
    email: accountEmail, password: accountPassword,
    request: async (url) => {
      assert.equal(url, "https://release.example.test/trpc/accounts.auth.loginWithPassword");
      return reply({ result: { data: { accessToken: formalToken } } });
    },
  });
  assert.equal(token, formalToken);
});

test("远端关闭演示入口时明确失败，不能回退为其他身份", async () => {
  let count = 0;
  await assert.rejects(releaseGateLogin({
    ...target, nodeEnv: "development", email: "", password: "",
    request: async () => {
      count += 1;
      return reply({ error: { data: { code: "FORBIDDEN" } } }, 403);
    },
  }), /目标服务已关闭演示身份入口/);
  assert.equal(count, 1);
});

test("身份入口异常响应不被当作成功", async () => {
  await assert.rejects(releaseGateLogin({
    ...target, nodeEnv: "production", email: accountEmail, password: accountPassword,
    request: async () => reply({ result: { data: { token: demoToken } } }),
  }), /正式身份校验失败/);
  await assert.rejects(releaseGateLogin({
    ...target, nodeEnv: "production", email: accountEmail, password: accountPassword,
    request: async () => ({ status: 502, ok: false, json: async () => { throw new SyntaxError("invalid"); } }),
  }), /返回非 JSON 响应/);
});

test("身份服务网络失败或超时会明确失败，且不输出底层异常", async () => {
  await assert.rejects(releaseGateLogin({
    ...target, nodeEnv: "production", email: accountEmail, password: accountPassword,
    request: async () => { throw new Error("underlying request details"); },
  }), /^Error: 发布门禁身份服务请求失败$/);
  await assert.rejects(releaseGateLogin({
    ...target, nodeEnv: "production", email: accountEmail, password: accountPassword, timeoutMs: 5,
    request: async (_url, options) => new Promise((_, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  }), /发布门禁身份请求超时/);
});
