import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router.js";

const anonymous = {
  session: null,
  identity: null,
  partnerIdentity: null,
  headers: new Headers(),
};

afterEach(() => vi.unstubAllEnvs());

describe("演示身份入口服务端门禁", () => {
  it("生产环境即使从回环地址直调 procedure 也拒绝签发成员 JWT", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_HOST", "127.0.0.1");

    await expect(appRouter.createCaller(anonymous).auth.loginAs({
      workspaceSlug: "any-workspace",
      memberNo: "MEM-001",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("非生产进程监听非回环地址时也拒绝演示身份直调", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SERVER_HOST", "0.0.0.0");

    await expect(appRouter.createCaller(anonymous).auth.loginAs({
      workspaceSlug: "any-workspace",
      memberNo: "MEM-001",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("生产环境的 tRPC 批量请求不能绕过同一门禁", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_HOST", "127.0.0.1");
    const input = { workspaceSlug: "any-workspace", memberNo: "MEM-001" };
    const req = new Request("http://localhost/trpc/auth.loginAs,auth.loginAs?batch=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ 0: input, 1: input }),
    });

    const response = await fetchRequestHandler({
      endpoint: "/trpc",
      req,
      router: appRouter,
      createContext: () => anonymous,
    });
    const body = await response.json() as Array<{ error?: { data?: { code?: string } } }>;
    expect(body).toHaveLength(2);
    for (const item of body) expect(item.error?.data?.code).toBe("FORBIDDEN");
  });
});
