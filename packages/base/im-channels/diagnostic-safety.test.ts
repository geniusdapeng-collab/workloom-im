/** Synthetic driver/storage errors only. No remote IM message or model request occurs. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
const mocks = vi.hoisted(() => ({ append: vi.fn() }));
vi.mock("../workdata/gateway.js", () => ({ gatewayAppend: mocks.append }));
import { ChannelDriverError, composeApprovalCard, MockChannelDriver, sendApprovalCard } from "./cards.js";

const canary = ["SYNTHETIC", "IM", "private-detail"].join("_");
const scope = { tenantId: "synthetic-tenant", workspaceId: "synthetic-workspace" };
const card = () => composeApprovalCard({ approval_id: "synthetic-approval", event_id: "E-1", payload: {} });
afterEach(() => { vi.restoreAllMocks(); mocks.append.mockReset(); });

describe("IM public diagnostic safety", () => {
  it("unknown driver causes and objects are never retained in error message or enumerable fields", () => {
    for (const error of [new Error(canary), { message: canary, body: canary, status: 401 }, canary]) {
      const publicError = new ChannelDriverError("feishu", error);
      expect(publicError.message).not.toContain(canary);
      expect(JSON.stringify(publicError)).not.toContain(canary);
      expect(publicError.cause).toBeUndefined();
    }
  });

  it("a real driver failure prevents gateway writes and exposes only category/HTTP status", async () => {
    const driver = new MockChannelDriver("feishu");
    vi.spyOn(driver, "sendCard").mockRejectedValue(Object.assign(new Error(canary), { status: 403 }));
    try {
      await sendApprovalCard({} as pg.Pool, scope, driver, { conversationId: "synthetic-no-outbound" }, card(), "MEM-SYNTHETIC");
      throw new Error("Expected the synthetic driver failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelDriverError);
      expect((error as Error).message).not.toContain(canary);
      expect((error as Error).message).toContain("403");
    }
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("post-send recording failure emits one safe warning and a safe compensation event", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.append.mockRejectedValueOnce(Object.assign(new Error(canary), { code: "ETIMEDOUT" }))
      .mockResolvedValueOnce({ eventId: "E-2" });
    const driver = new MockChannelDriver("feishu");
    const out = await sendApprovalCard({} as pg.Pool, scope, driver, { conversationId: "synthetic-no-outbound" }, card(), "MEM-SYNTHETIC");
    expect(out.compensated).toBe(true); expect(out.eventId).toBe("E-2");
    expect(driver.outbox).toHaveLength(1); expect(mocks.append).toHaveBeenCalledTimes(2);
    expect(warnings).toHaveBeenCalledTimes(1); expect(JSON.stringify(warnings.mock.calls)).not.toContain(canary);
    const compensation = mocks.append.mock.calls[1]?.[2];
    expect(compensation.decision.action).toBe("im.outbound.unrecorded");
    expect(JSON.stringify(compensation)).not.toContain(canary);
    expect(compensation.decision.after.send_error).toContain("timeout");
  });

  it("a failed compensation remains a visible safe error and does not resend the card", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.append.mockRejectedValueOnce(new Error(canary)).mockRejectedValueOnce(Object.assign(new Error(canary), { statusCode: 503 }));
    const driver = new MockChannelDriver("feishu");
    await expect(sendApprovalCard({} as pg.Pool, scope, driver, { conversationId: "synthetic-no-outbound" }, card(), "MEM-SYNTHETIC")).rejects.toSatisfy((error: Error) => {
      expect(error.message).not.toContain(canary); expect(error.message).toContain("503"); return true;
    });
    expect(driver.outbox).toHaveLength(1); expect(mocks.append).toHaveBeenCalledTimes(2);
  });

  it("malformed HTTP states and hostile getters cannot inject or suppress a safe driver diagnostic", () => {
    const hostile = Object.defineProperty({}, "status", { get() { throw new Error(canary); } });
    const hostileValue = { toString() { throw new Error(canary); } };
    for (const error of [{ status: `401 ${canary}`, code: canary }, { statusCode: Infinity, body: canary }, hostile, { code: hostileValue, name: hostileValue }]) {
      const publicError = new ChannelDriverError("feishu", error);
      expect(publicError.message).not.toContain(canary); expect(publicError.message).toMatch(/unknown|未知/);
    }
  });
});
