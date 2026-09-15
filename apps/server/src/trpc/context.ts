/**
 * tRPC 上下文（B5 中间件栈落地）：Bearer JWT → Identity；无令牌 = 未认证（null）
 * 纪律：
 *  - 未认证调受保护过程 → UNAUTHORIZED（401）
 *  - 越版调用 → FORBIDDEN（403）+ 升级提示（H-10），且留痕事件（G8）
 *  - 越权查询返回空而非 403（L7.1）：RLS + 过程内强制 identity scope
 */
import { initTRPC, TRPCError } from "@trpc/server";
import {
  hasCapability,
  verifySessionToken,
  type CapabilityKey,
  type Identity,
  type PartnerSessionIdentity,
  type SessionIdentity,
} from "@workloom/base/tenancy";
import {
  AccessAuthorityError,
  currentMemberAuthority,
  memberAccessGrants,
  type BaseActionPermission,
} from "../service/access-authority.js";

export interface TrpcContext {
  /** 已验签会话；伙伴与成员严格分域。 */
  session: SessionIdentity | null;
  identity: Identity | null;
  partnerIdentity: PartnerSessionIdentity | null;
  /** 原始请求头（P0-1 通道验签 x-channel-* / 服务间密钥 x-workloom-key 读取面） */
  headers: Headers;
}

export async function createContext(req: Request): Promise<TrpcContext> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return { session: null, identity: null, partnerIdentity: null, headers: req.headers };
  const session = await verifySessionToken(auth.slice(7));
  if (!session) return { session: null, identity: null, partnerIdentity: null, headers: req.headers };
  return session.kind === "partner"
    ? { session, identity: null, partnerIdentity: session, headers: req.headers }
    : { session, identity: session, partnerIdentity: null, headers: req.headers };
}

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/** 401 守卫 */
export const sessionProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED", message: "未认证（缺少有效会话）" });
  return next({ ctx: { ...ctx, session: ctx.session } });
});

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.identity) throw new TRPCError({ code: "UNAUTHORIZED", message: "未认证（缺少有效 JWT）" });
  try {
    // JWT 只证明会话来源；角色、套餐、成员/租户状态每次从当前服务端事实刷新。
    const current = await currentMemberAuthority(ctx.identity);
    return next({
      ctx: {
        ...ctx,
        identity: current.identity,
        session: current.identity,
        memberPermissions: current.permissions,
      },
    });
  } catch (error) {
    if (error instanceof AccessAuthorityError) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: error.message });
    }
    throw error;
  }
});

/** 403 越版守卫（H-10：403 + 升级提示） */
export const capabilityProcedure = (cap: CapabilityKey) =>
  protectedProcedure.use(({ ctx, next }) => {
    const plan = ctx.identity.plan;
    if (!hasCapability(plan, cap)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `当前版本「${plan}」不含能力「${cap}」，请升级（F7.2）`,
      });
    }
    return next();
  });

/**
 * 动作权限守卫：与 access.me 下发给三端的 actionPermissions 使用同一计算器。
 * JWT 只证明会话，role/plan/member.permissions 已由 protectedProcedure 实时刷新；
 * 因而 deny、readonly、guest 与套餐降级既影响按钮，也同样阻止 API 直调。
 */
export const actionProcedure = (permission: BaseActionPermission) =>
  protectedProcedure.use(({ ctx, next }) => {
    const grants = memberAccessGrants({
      role: ctx.identity.role,
      plan: ctx.identity.plan,
      guest: ctx.identity.memberNo === "GUEST",
      permissions: ctx.memberPermissions,
    });
    if (!grants.actionPermissions.includes(permission)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `当前成员没有动作权限「${permission}」（服务端权威授权）`,
      });
    }
    return next();
  });

/** 通用写操作仍需显式 workspace.write；不再仅按角色粗粒度放行。 */
export const writeProcedure = actionProcedure("workspace.write");

/** 越版（plan 能力）+ 写操作（role）双守卫 */
export const capabilityWriteProcedure = (cap: CapabilityKey) =>
  writeProcedure.use(({ ctx, next }) => {
    const plan = ctx.identity.plan;
    if (!hasCapability(plan, cap)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `当前版本「${plan}」不含能力「${cap}」，请升级（F7.2）`,
      });
    }
    return next();
  });

/** 套餐能力 + 具体动作权限双守卫，用于任务、夜班等高风险 API。 */
export const capabilityActionProcedure = (cap: CapabilityKey, permission: BaseActionPermission) =>
  actionProcedure(permission).use(({ ctx, next }) => {
    const plan = ctx.identity.plan;
    if (!hasCapability(plan, cap)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `当前版本「${plan}」不含能力「${cap}」，请升级（F7.2）`,
      });
    }
    return next();
  });

/** 身份 scope 快捷访问（过程内强制使用，杜绝跨工作区读取） */
export function scopeOf(identity: Identity): { tenantId: string; workspaceId: string } {
  return { tenantId: identity.tenantId, workspaceId: identity.workspaceId };
}
