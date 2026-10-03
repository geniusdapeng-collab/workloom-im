/**
 * 活库契约：适配器选择经 serviceTx/RLS 读取活动装配；AI PM 默认包即使与
 * 酒店夹具同库，也不能访问酒店订单/会员接口数据。
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { runWithServiceScope } from "../scope.js";

process.env.DATABASE_URL ??= "postgres://postgres:workloom@localhost:5432/workloom";
process.env.DATABASE_APP_URL ??= "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";
process.env.DATABASE_GATEWAY_URL ??= "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom";
process.env.SERVICE_C_DEMO_AUTH = "true";

const HOTEL_FIXTURE_WORKSPACE_ID = process.env.SERVICE_C_TEST_WORKSPACE_ID?.trim() || null;
const AI_PM_FIXTURE_WORKSPACE_ID = process.env.RELEASE_WORKSPACE_ID?.trim() || null;
const HOTEL_FIXTURE_TENANT_ID = process.env.SERVICE_C_TEST_TENANT_ID?.trim() || null;
const AI_PM_FIXTURE_TENANT_ID = process.env.RELEASE_TENANT_ID?.trim() || null;
const RUN_DB = process.env.RUN_DB_TESTS === "1"
  && Boolean(process.env.DATABASE_APP_URL);

describe.runIf(RUN_DB)("活动 Bundle 服务前台适配器 PG 契约", () => {
  let app: Hono;
  let token = "";
  let resolveWorkspaceBusinessAdapter: typeof import("./business-registry.js").resolveWorkspaceBusinessAdapter;

  beforeAll(async () => {
    if (!HOTEL_FIXTURE_WORKSPACE_ID || !HOTEL_FIXTURE_TENANT_ID
        || !AI_PM_FIXTURE_WORKSPACE_ID || !AI_PM_FIXTURE_TENANT_ID) {
      throw new Error("PG adapter contract requires explicit SERVICE_C_TEST_WORKSPACE_ID/SERVICE_C_TEST_TENANT_ID and RELEASE_WORKSPACE_ID/RELEASE_TENANT_ID");
    }
    ({ serviceGateway: app } = await import("../gateway.js"));
    ({ resolveWorkspaceBusinessAdapter } = await import("./business-registry.js"));
    const { issueCToken, cSecret } = await import("../channels.js");
    token = await issueCToken({
      tenantId: AI_PM_FIXTURE_TENANT_ID!,
      workspaceId: AI_PM_FIXTURE_WORKSPACE_ID!,
      cUserId: "contract-no-industry-subject",
      channel: "h5",
      secret: cSecret(),
    });
  });

  it("同库活动装配经 RLS 分别选择 hotel，且 AI PM 不选择任何酒店适配器", async () => {
    const hotel = await runWithServiceScope({ tenantId: HOTEL_FIXTURE_TENANT_ID!, workspaceId: HOTEL_FIXTURE_WORKSPACE_ID! },
      () => resolveWorkspaceBusinessAdapter(HOTEL_FIXTURE_WORKSPACE_ID!));
    const aiPm = await runWithServiceScope({ tenantId: AI_PM_FIXTURE_TENANT_ID!, workspaceId: AI_PM_FIXTURE_WORKSPACE_ID! },
      () => resolveWorkspaceBusinessAdapter(AI_PM_FIXTURE_WORKSPACE_ID!));
    expect(hotel).toMatchObject({ state: "ready", adapter: { id: "hotel.service-front-v1" } });
    expect(aiPm).toMatchObject({ state: "adapter-not-declared", adapter: null, bundleId: "ai-pm" });
  });

  it("AI PM 的公开订单与身份摘要端点失败关闭为空，不读取同库酒店夹具", async () => {
    const headers = { Authorization: `Bearer ${token}` };
    const ordersResponse = await app.request("/orders", { headers });
    const memberResponse = await app.request("/member", { headers });
    expect(ordersResponse.status).toBe(200);
    expect(memberResponse.status).toBe(200);
    expect(await ordersResponse.json()).toMatchObject({ orders: [], demo: false, available: false });
    expect(await memberResponse.json()).toMatchObject({
      title: "权益信息不可用", benefits: [], demo: false, available: false,
    });
  });
});
