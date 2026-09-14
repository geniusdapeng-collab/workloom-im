/**
 * trpc/accounts-router —— 账号体系端点（PRD §4 登录模块 / §6 我的体系 / §5 审批 / 伙伴域 / API 密钥）
 *
 * 命名空间：
 *  - accounts.auth.*      公开：验证码/密码登录、注册开通、激活、邀请接受、refresh、伙伴登录
 *  - accounts.my.*        登录态：资料/成员关系/会话/登录日志/快切 PIN/登出
 *  - accounts.admin.*     owner/manager：分级管理；移除/改角色/伙伴授权等高风险动作仅 owner
 *  - accounts.inbox.*     统一待办（跨 membership 聚合）
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getAppPool, getOwnerPool, withWorkspace } from "@workloom/db";
import {
  requestCode, consumeCode, loginWithCode, loginWithPassword, refreshSession, logout,
  listMemberships, listSessions, revokeSession, revokeAllSessions, registerTenantOwner,
  inviteMember, acceptInvite, removeMember, updateMemberRole, setQuickPin, myLoginEvents,
  loginEvent, createSmsSender, type AccountsDeps, type QueryFn,
} from "@workloom/base/accounts";
import {
  ensurePartner, issueGrant, revokeGrant, listGrantsForTenant, listGrantsForPartner,
  partnerLogin, partnerRefresh, issueWorkorderPass, PARTNER_CAPABILITIES,
} from "@workloom/base/accounts";
import {
  applyApprovalTemplate, listApprovalPolicies, createApiKey, listApiKeys, revokeApiKey,
  linkTenant, childTenants, type Archetype,
} from "@workloom/base/accounts";
import { router, publicProcedure, protectedProcedure, writeProcedure, scopeOf } from "./context.js";
import { signDemoToken, type Identity } from "@workloom/base/tenancy";
import { listSelfServiceBundles } from "@workloom/base/bundles";

const sms = createSmsSender({
  driver: process.env.ACCOUNTS_SMS_DRIVER ?? process.env.SMS_PROVIDER,
  nodeEnv: process.env.NODE_ENV,
});
const deps = (): AccountsDeps => ({ q: (t: string, p?: unknown[]) => getAppPool().query(t, p as never[]) as Promise<{ rows: Record<string, unknown>[] }>, sms });
// 登录引导例外点（F7.1 同 loginAs）：身份未建立前的工作区解析走 owner 池
const ownerDeps = (): AccountsDeps => ({ q: (t: string, p?: unknown[]) => getOwnerPool().query(t, p as never[]) as Promise<{ rows: Record<string, unknown>[] }>, sms });
const ownerQuery: QueryFn = (t, p) => getOwnerPool().query(t, p as never[]) as Promise<{ rows: Record<string, unknown>[] }>;

/**
 * 账号域中带 workspace_id / tenant_id 的表同样受 RLS 保护。
 * 每个受保护过程必须在一个事务里设置两项身份上下文，不能把 set_config 和业务 SQL
 * 分发到连接池的不同连接上，否则会出现“有权限但查不到”或跨租户串读。
 */
async function withIdentityDeps<T>(identity: Identity, fn: (scoped: AccountsDeps) => Promise<T>): Promise<T> {
  return withWorkspace(getAppPool(), scopeOf(identity), async (_db, client) => fn({
    q: (t, p) => client.query(t, p as never[]) as Promise<{ rows: Record<string, unknown>[] }>,
    sms,
  }));
}

async function withIdentityQuery<T>(identity: Identity, fn: (q: QueryFn) => Promise<T>): Promise<T> {
  return withIdentityDeps(identity, (scoped) => fn(scoped.q));
}

const device = z.string().max(200).optional();
const ip = z.string().max(64).optional();

export const accountsRouter = router({
  auth: router({
    /** 首次开通选项只能来自通过契约/兼容性/完整性校验的稳定自助 Bundle。 */
    activationOptions: publicProcedure.query(() => {
      const registry = listSelfServiceBundles();
      return { registryVersion: registry.version, bundles: registry.entries };
    }),

    /** 发送验证码（login/activate/invite/danger-confirm） */
    requestCode: publicProcedure
      .input(z.object({
        channel: z.enum(["phone", "email"]).default("phone"),
        target: z.string().min(5).max(64),
        purpose: z.enum(["login", "activate", "invite", "danger-confirm"]),
      }))
      .mutation(async ({ input }) => {
        const r = await requestCode(deps(), input);
        return { sent: r.sent, devCode: r.devCode };
      }),

    loginWithCode: publicProcedure
      .input(z.object({ phone: z.string().min(6).max(20), code: z.string().length(6), workspaceSlug: z.string(), device, ip }))
      .mutation(async ({ input }) => loginWithCode(ownerDeps(), input)),

    loginWithPassword: publicProcedure
      .input(z.object({ email: z.string().email(), password: z.string().min(6).max(128), workspaceSlug: z.string(), device, ip }))
      .mutation(async ({ input }) => loginWithPassword(ownerDeps(), input)),

    /** 自助注册开通（老板首店） */
    register: publicProcedure
      .input(z.object({
        phone: z.string().min(6).max(20), code: z.string().length(6), displayName: z.string().min(1).max(50),
        tenantName: z.string().min(1).max(100), workspaceName: z.string().min(1).max(100),
        workspaceSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/).optional(), industry: z.string().min(1).max(40),
        password: z.string().min(8).max(128).optional(), ip,
      }))
      .mutation(async ({ input }) => {
        const registry = listSelfServiceBundles();
        if (!registry.entries.some((entry) => entry.slug === input.industry)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "所选起步方案当前不可用于自助开通，请刷新后重新选择" });
        }
        return registerTenantOwner(ownerDeps(), input);
      }),

    acceptInvite: publicProcedure
      .input(z.object({ phone: z.string().min(6).max(20), code: z.string().length(6), workspaceSlug: z.string(), displayName: z.string().max(50).optional(), ip }))
      .mutation(async ({ input }) => acceptInvite(ownerDeps(), input)),

    refresh: publicProcedure
      .input(z.object({ refreshToken: z.string().min(20), workspaceSlug: z.string(), device, ip }))
      .mutation(async ({ input }) => refreshSession(ownerDeps(), input)),

    logout: publicProcedure
      .input(z.object({ refreshToken: z.string().min(20) }))
      .mutation(async ({ input }) => { await logout(deps(), input.refreshToken); return { ok: true }; }),

    partnerLogin: publicProcedure
      .input(z.object({ phone: z.string().min(6).max(20), code: z.string().length(6), device, ip }))
      .mutation(async ({ input }) => partnerLogin(ownerDeps(), input)),

    partnerRefresh: publicProcedure
      .input(z.object({ refreshToken: z.string().min(20) }))
      .mutation(async ({ input }) => partnerRefresh(ownerDeps(), input)),

    /**
     * 游客进场（F-GUEST1 首次装机体验口径）：
     * 默认游客身份直接进系统——可完整浏览示例工作区（数字人/汇报/页面能力），
     * 直至进入配置引导（/onboarding）才要求正式登录。
     * 纪律：① 不写死工作区 slug——自动发现 is_example 工作区（各行业包种子均建一个）；
     *      ② 游客=readonly 角色——writeProcedure 服务端 403 一切写操作（E2.6 已有守卫），
     *         体验全程零写入、零审批、零扣费；
     *      ③ 24h 令牌与演示 JWT 同构（Identity），前端以 GUEST memberNo 识别并展示「游客体验中」。
     */
    guestEnter: publicProcedure
      .input(z.object({ device, ip }))
      .mutation(async () => {
        // 登录引导例外点（F7.1 同 loginAs）：身份未建立前的示例工作区发现走 owner 池
        const ws = await getOwnerPool().query<{ id: string; tenant_id: string; slug: string; name: string }>(
          `SELECT id, tenant_id, slug, name FROM workspaces WHERE is_example=true ORDER BY id LIMIT 1`);
        const row = ws.rows[0];
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "示例工作区未就绪（首启种子未完成）" });
        const t = await getOwnerPool().query<{ plan: Identity["plan"] }>(`SELECT plan FROM tenants WHERE id=$1`, [row.tenant_id]);
        // 使用工作区内真实成员主键承载只读游客身份。旧值 "guest" 不存在于 members，
        // 任何需要成员关联/RLS 的产品查询都会在部分行业包中静默返回空或失败。
        const member = await getOwnerPool().query<{ id: string }>(
          `SELECT id FROM members WHERE workspace_id=$1
           ORDER BY CASE WHEN role='readonly' THEN 0 ELSE 1 END, member_no LIMIT 1`,
          [row.id],
        );
        if (!member.rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "示例工作区没有可承载游客会话的成员" });
        const identity: Identity = {
          memberId: member.rows[0].id,
          memberNo: "GUEST",
          name: "游客",
          role: "readonly",
          tenantId: row.tenant_id,
          workspaceId: row.id,
          plan: t.rows[0]?.plan ?? "pro",
        };
        return { token: await signDemoToken(identity), identity, workspace: { slug: row.slug, name: row.name } };
      }),
  }),

  my: router({
    /** 我的成员关系（统一待办与切店数据源） */
    memberships: protectedProcedure.query(async ({ ctx }) => {
      const accId = await accountIdOf(ctx.identity!);
      if (!accId) return [];
      // “我的全部工作区”天然跨 RLS scope；先用当前身份确认 account_id，再由受控 owner 查询按该账号聚合。
      return listMemberships(ownerQuery, accId);
    }),

    sessions: protectedProcedure.query(async ({ ctx }) => {
      const accId = await accountIdOf(ctx.identity!);
      return accId ? listSessions(getAppPool().query.bind(getAppPool()), accId) : [];
    }),

    revokeSession: writeProcedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const accId = await accountIdOf(ctx.identity!);
        if (accId) await revokeSession(getAppPool().query.bind(getAppPool()), accId, input.sessionId);
        return { ok: true };
      }),

    revokeAllSessions: writeProcedure.mutation(async ({ ctx }) => {
      const accId = await accountIdOf(ctx.identity!);
      if (accId) await revokeAllSessions(getAppPool().query.bind(getAppPool()), accId);
      return { ok: true };
    }),

    loginEvents: protectedProcedure.query(async ({ ctx }) => {
      const accId = await accountIdOf(ctx.identity!);
      return accId ? myLoginEvents(getAppPool().query.bind(getAppPool()), accId) : [];
    }),

    setQuickPin: writeProcedure
      .input(z.object({ pin: z.string().regex(/^\d{4,6}$/) }))
      .mutation(async ({ ctx, input }) => {
        await withIdentityDeps(ctx.identity!, (scoped) =>
          setQuickPin(scoped, { memberId: ctx.identity!.memberId, pin: input.pin }));
        return { ok: true };
      }),

    /** 伙伴域：我的授权（伙伴联系人视角） */
    myPartnerGrants: protectedProcedure.query(async ({ ctx }) => {
      const accId = await accountIdOf(ctx.identity!);
      if (!accId) return [];
      const p = await getAppPool().query(`SELECT id FROM partners WHERE contact_account_id=$1 AND status='active'`, [accId]);
      if (!p.rows[0]) return [];
      return withIdentityQuery(ctx.identity!, (q) => listGrantsForPartner(q, p.rows[0].id as string));
    }),
  }),

  admin: router({
    invite: writeProcedure
      .input(z.object({
        phone: z.string().min(6).max(20), name: z.string().min(1).max(50),
        role: z.enum(["owner", "manager", "staff", "readonly"]),
      }))
      .mutation(async ({ ctx, input }) => {
        assertOwnerOrManager(ctx.identity!.role);
        if (ctx.identity!.role === "manager" && (input.role === "owner" || input.role === "manager")) {
          throw new TRPCError({ code: "FORBIDDEN", message: "管理员只能邀请普通成员或只读成员" });
        }
        const r = await withIdentityDeps(ctx.identity!, (scoped) => inviteMember(scoped, {
          workspaceId: ctx.identity!.workspaceId, phone: input.phone, name: input.name,
          role: input.role, invitedBy: ctx.identity!.memberId,
        }));
        return r;
      }),

    remove: writeProcedure
      .input(z.object({ memberId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.identity!.role !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: "移除成员仅限工作区负责人" });
        if (input.memberId === ctx.identity!.memberId) throw new TRPCError({ code: "BAD_REQUEST", message: "不能移除自己" });
        await withIdentityDeps(ctx.identity!, async (scoped) => {
          await removeMember(scoped, { workspaceId: ctx.identity!.workspaceId, memberId: input.memberId });
          await loginEvent(scoped.q, { kind: "member.removed", workspaceId: ctx.identity!.workspaceId, detail: { memberId: input.memberId, by: ctx.identity!.memberNo } });
        });
        return { ok: true };
      }),

    updateRole: writeProcedure
      .input(z.object({
        memberId: z.string(), role: z.enum(["owner", "manager", "staff", "readonly"]),
        permissions: z.record(z.string(), z.unknown()).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.identity!.role !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: "修改角色仅限工作区负责人" });
        if (input.memberId === ctx.identity!.memberId) throw new TRPCError({ code: "BAD_REQUEST", message: "不能修改自己的负责人角色" });
        await withIdentityDeps(ctx.identity!, (scoped) =>
          updateMemberRole(scoped, { workspaceId: ctx.identity!.workspaceId, ...input }));
        return { ok: true };
      }),

    approvalPolicies: protectedProcedure.query(async ({ ctx }) =>
      withIdentityQuery(ctx.identity!, (q) => listApprovalPolicies(q, ctx.identity!.workspaceId))),

    applyApprovalTemplate: writeProcedure
      .input(z.object({ archetype: z.enum(["single", "unmanned", "group-store"]) }))
      .mutation(async ({ ctx, input }) => {
        assertOwnerOrManager(ctx.identity!.role);
        return withIdentityDeps(ctx.identity!, (scoped) => applyApprovalTemplate(scoped, {
          workspaceId: ctx.identity!.workspaceId,
          archetype: input.archetype as Archetype, updatedBy: ctx.identity!.memberId,
        }));
      }),

    createApiKey: writeProcedure
      .input(z.object({
        name: z.string().min(1).max(60), capabilities: z.array(z.string()).min(1),
        rateLimit: z.number().int().min(1).max(6000).optional(), ttlDays: z.number().int().min(1).max(365).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        assertOwnerOrManager(ctx.identity!.role);
        return withIdentityDeps(ctx.identity!, (scoped) => createApiKey(scoped, {
          workspaceId: ctx.identity!.workspaceId, name: input.name, capabilities: input.capabilities,
          rateLimit: input.rateLimit, ttlDays: input.ttlDays, createdBy: ctx.identity!.memberId,
        }));
      }),

    apiKeys: protectedProcedure.query(async ({ ctx }) =>
      withIdentityQuery(ctx.identity!, (q) => listApiKeys(q, ctx.identity!.workspaceId))),

    revokeApiKey: writeProcedure
      .input(z.object({ keyId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        assertOwnerOrManager(ctx.identity!.role);
        await withIdentityQuery(ctx.identity!, (q) => revokeApiKey(q, ctx.identity!.workspaceId, input.keyId));
        return { ok: true };
      }),

    registerPartner: writeProcedure
      .input(z.object({ name: z.string().min(1).max(100), type: z.enum(["agency", "contractor", "observer"]), contactPhone: z.string().min(6).max(20) }))
      .mutation(async ({ ctx, input }) => {
        assertOwnerOrManager(ctx.identity!.role);
        return ensurePartner(deps(), input);
      }),

    issueGrant: writeProcedure
      .input(z.object({
        partnerId: z.string(), workspaces: z.array(z.string()).min(1),
        capabilities: z.array(z.enum(PARTNER_CAPABILITIES)).min(1),
        ttlDays: z.number().int().min(1).max(730),
      }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.identity!.role !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: "伙伴授权仅 owner 可签发" });
        return withIdentityDeps(ctx.identity!, (scoped) => issueGrant(scoped, {
          partnerId: input.partnerId, tenantId: ctx.identity!.tenantId,
          workspaces: input.workspaces, capabilities: input.capabilities,
          ttlDays: input.ttlDays, issuedBy: ctx.identity!.memberId,
        }));
      }),

    grants: protectedProcedure.query(async ({ ctx }) =>
      withIdentityQuery(ctx.identity!, (q) => listGrantsForTenant(q, ctx.identity!.tenantId))),

    revokeGrant: writeProcedure
      .input(z.object({ grantId: z.string(), reason: z.string().trim().min(2).max(200) }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.identity!.role !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: "吊销仅 owner 可操作" });
        await withIdentityDeps(ctx.identity!, (scoped) =>
          revokeGrant(scoped, input.grantId, input.reason, ctx.identity!.tenantId));
        return { ok: true };
      }),

    issueWorkorderPass: writeProcedure
      .input(z.object({
        phone: z.string().min(6).max(20), name: z.string().min(1).max(50),
        ticketId: z.string(), ttlHours: z.number().int().min(1).max(168).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        assertOwnerOrManager(ctx.identity!.role);
        return withIdentityDeps(ctx.identity!, (scoped) => issueWorkorderPass(scoped, {
          phone: input.phone, name: input.name, tenantId: ctx.identity!.tenantId,
          workspaceId: ctx.identity!.workspaceId, ticketId: input.ticketId,
          ttlHours: input.ttlHours, issuedBy: ctx.identity!.memberId,
        }));
      }),

    linkTenant: writeProcedure
      .input(z.object({
        childTenantId: z.string(),
        relation: z.enum(["direct", "franchise"]),
        settlement: z.enum(["group_pool", "self_pay"]),
      }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.identity!.role !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: "集团层级仅集团 owner 可维护" });
        await withIdentityDeps(ctx.identity!, (scoped) =>
          linkTenant(scoped, { parentTenantId: ctx.identity!.tenantId, ...input }));
        return { ok: true };
      }),

    childTenants: protectedProcedure.query(async ({ ctx }) =>
      // 集团视图要读取子租户名称；parentTenantId 来自签名身份，owner 查询只按该父租户聚合。
      childTenants(ownerQuery, ctx.identity!.tenantId)),
  }),

  inbox: router({
    /** 统一待办：跨 membership 聚合（审批/告警/工单占位——按店分组返回工作区清单与各自待办计数） */
    unified: protectedProcedure.query(async ({ ctx }) => {
      const accId = await accountIdOf(ctx.identity!);
      if (!accId) return { groups: [] };
      const ships = await listMemberships(ownerQuery, accId);
      const groups = [];
      for (const m of ships) {
        // 各工作区待办计数（审批卡 pending；告警/工单由行业包数据面补充，结构先行）
        const approvals = await withWorkspace(getAppPool(), {
          tenantId: m.tenant_id as string,
          workspaceId: m.workspace_id as string,
        }, async (_db, client) => client.query(
          `SELECT count(*)::int AS c FROM approvals WHERE workspace_id=$1 AND status='pending'`,
          [m.workspace_id])).catch(() => ({ rows: [{ c: 0 }] }));
        groups.push({
          workspaceId: m.workspace_id, slug: m.slug, workspaceName: m.workspace_name,
          tenantName: m.tenant_name, role: m.role, industry: m.industry,
          pendingApprovals: (approvals.rows[0] as { c: number }).c,
        });
      }
      return { groups };
    }),
  }),
});

function assertOwnerOrManager(role: string): void {
  if (role !== "owner" && role !== "manager") {
    throw new TRPCError({ code: "FORBIDDEN", message: "仅 owner/manager 可管理成员与授权" });
  }
}

async function accountIdOf(identity: Identity): Promise<string | undefined> {
  return withIdentityQuery(identity, async (q) => {
    const r = await q(`SELECT account_id FROM members WHERE id=$1 AND workspace_id=$2`, [identity.memberId, identity.workspaceId]);
    return r.rows[0]?.account_id as string | undefined;
  });
}
