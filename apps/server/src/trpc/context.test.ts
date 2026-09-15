import { describe, expect, it, vi } from "vitest";
import { signPartnerToken } from "@workloom/base/accounts";
import type { Identity } from "@workloom/base/tenancy";

const currentMemberAuthorityMock = vi.hoisted(() => vi.fn());

vi.mock("../service/access-authority.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../service/access-authority.js")>();
  return { ...actual, currentMemberAuthority: currentMemberAuthorityMock };
});

import { actionProcedure, createContext, protectedProcedure, router } from "./context.js";

describe("会话域隔离", () => {
  it("伙伴 JWT 不能调用普通成员 protectedProcedure", async () => {
    const token = await signPartnerToken({
      kind: "partner",
      partnerId: "ptr-1",
      contactAccountId: "acc-1",
      name: "服务伙伴",
      grants: [{ grantId: "grt-1", tenantId: "tenant-1", workspaces: ["ws-1"], capabilities: ["report.view"] }],
    });
    const context = await createContext(new Request("http://local.test", {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(context.identity).toBeNull();
    expect(context.partnerIdentity).toMatchObject({ partnerId: "ptr-1" });

    const testRouter = router({ memberOnly: protectedProcedure.query(() => "不应到达") });
    await expect(testRouter.createCaller(context).memberOnly()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("客户端隐藏动作后，同一 member.permissions deny 也拒绝 API 直调", async () => {
    const identity: Identity = {
      kind: "member",
      memberId: "mem-owner",
      memberNo: "MEM-001",
      name: "负责人",
      role: "owner",
      tenantId: "tenant-1",
      workspaceId: "ws-1",
      plan: "pro",
    };
    currentMemberAuthorityMock.mockResolvedValueOnce({
      identity,
      permissions: { deny: ["guardrail.manage"] },
    });
    const context = {
      session: identity,
      identity,
      partnerIdentity: null,
      headers: new Headers(),
    };
    const testRouter = router({
      mutateGuardrail: actionProcedure("guardrail.manage").mutation(() => "不应到达"),
    });
    await expect(testRouter.createCaller(context).mutateGuardrail()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("guardrail.manage"),
    });
  });

  it.each([
    ["只读成员", "readonly", "pro", "workspace.write"],
    ["降级社区版负责人", "owner", "community", "night.manage"],
  ] as const)("%s不能绕过客户端直调受限动作", async (_label, role, plan, action) => {
    const identity: Identity = {
      kind: "member",
      memberId: `mem-${role}`,
      memberNo: "MEM-002",
      name: "受限成员",
      role,
      tenantId: "tenant-1",
      workspaceId: "ws-1",
      plan,
    };
    currentMemberAuthorityMock.mockResolvedValueOnce({ identity, permissions: {} });
    const context = {
      session: identity,
      identity,
      partnerIdentity: null,
      headers: new Headers(),
    };
    const testRouter = router({
      mutate: actionProcedure(action).mutation(() => "不应到达"),
    });
    await expect(testRouter.createCaller(context).mutate()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
