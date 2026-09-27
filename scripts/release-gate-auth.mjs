/**
 * 发布门禁的身份入口。托管环境使用已有正式账号；本机开发环境才可使用演示身份。
 * 凭据只来自进程环境，不能写入报告或回退到演示身份。
 */
export async function releaseGateLogin({
  base,
  workspaceSlug,
  memberNo,
  email = process.env.RELEASE_GATE_EMAIL,
  password = process.env.RELEASE_GATE_PASSWORD,
  nodeEnv = process.env.NODE_ENV,
  request = fetch,
  timeoutMs = 30_000,
}) {
  const accountEmail = typeof email === "string" ? email.trim() : "";
  const accountPassword = typeof password === "string" ? password : "";
  if (Boolean(accountEmail) !== Boolean(accountPassword)) {
    throw new Error("发布门禁正式账号需同时设置 RELEASE_GATE_EMAIL 和 RELEASE_GATE_PASSWORD");
  }
  if (nodeEnv === "production" && !accountEmail) {
    throw new Error("生产发布门禁必须注入正式账号凭据 RELEASE_GATE_EMAIL 和 RELEASE_GATE_PASSWORD");
  }

  const formal = Boolean(accountEmail);
  let serviceUrl;
  try {
    serviceUrl = new URL(base);
  } catch {
    throw new Error("SERVER_BASE 必须是有效的服务 URL");
  }
  if (serviceUrl.username || serviceUrl.password) {
    throw new Error("SERVER_BASE 不得包含 URL 凭据");
  }
  if (!["http:", "https:"].includes(serviceUrl.protocol)) {
    throw new Error("SERVER_BASE 必须使用 HTTP 或 HTTPS");
  }
  if (formal && serviceUrl.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(serviceUrl.hostname)) {
    throw new Error("正式账号凭据只能通过 HTTPS 或本机回环连接提交");
  }
  const procedure = formal ? "accounts.auth.loginWithPassword" : "auth.loginAs";
  const input = formal
    ? { email: accountEmail, password: accountPassword, workspaceSlug, device: "release-gate" }
    : { workspaceSlug, memberNo };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let payload;
  try {
    response = await request(`${base.replace(/\/$/, "")}/trpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    payload = await response.json();
  } catch {
    if (controller.signal.aborted) throw new Error("发布门禁身份请求超时");
    if (!response) throw new Error("发布门禁身份服务请求失败");
    throw new Error(`发布门禁身份入口返回非 JSON 响应（HTTP ${response.status}）`);
  } finally {
    clearTimeout(timer);
  }
  const token = formal ? payload?.result?.data?.accessToken : payload?.result?.data?.token;
  if (!response.ok || typeof token !== "string" || !token) {
    if (!formal && payload?.error?.data?.code === "FORBIDDEN") {
      throw new Error("目标服务已关闭演示身份入口；请注入发布门禁正式账号凭据");
    }
    throw new Error(`发布门禁正式身份校验失败（HTTP ${response.status}）`);
  }
  return token;
}
