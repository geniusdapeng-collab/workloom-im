/**
 * F11 行业装配测试（P7 舰船换装坞）：
 * 纯函数/文件：草稿骨架 scaffold（五要素 §2.3）/  slug 校验 / 草稿保护移除
 * PG 集成：hotel profile 六槽全装配 + 五项校验全绿（F2.10）/ 校验留痕（P7E3）/
 *          激活幂等（bundle.activate 事件）/ 草稿校验失败拒绝激活（不静默 L9.2）
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash, generateKeyPairSync, sign as signValue } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  BundleError, REGISTERED_PAGES, computeAssembly, listProfileSlugs, scaffoldDraft, removeDraft,
  listSelfServiceBundles, loadBundleUiProjection, loadVerifiedBundleManifest,
  loadVerifiedBundleWorkforcePresets, verifyBundleManifestDocument,
} from "./assembly.js";
import { canonicalBundleArtifactPayload, parseBundleManifest } from "@workloom/industry-contract";

describe("草稿骨架与校验（P7E5/§2.3，文件级）", () => {
  it("五要素向导产出草稿骨架：五槽目录 + bundle.json status=draft（不进分发）", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundles-"));
    scaffoldDraft({
      slug: "retail", displayName: "零售版", version: "0.1.0",
      changelog: "首版草稿", fenceRef: "hotel-baseline/v1", ownerMemberNo: "MEM-001",
    }, root);
    for (const sub of ["schemas", "presets", "fences", "skills", "ui"]) {
      expect(existsSync(join(root, "retail", sub))).toBe(true);
    }
    const bj = JSON.parse(readFileSync(join(root, "retail/bundle.json"), "utf-8"));
    expect(bj.workloom.status).toBe("draft");
    expect(bj.workloom.owner).toBe("MEM-001");
    // v3.0 第⑦槽：草稿自带 model-policy.yml 骨架（默认继承底座策略）
    expect(existsSync(join(root, "retail", "model-policy.yml"))).toBe(true);
    expect(listProfileSlugs(root)).toEqual(["retail"]);
    // 草稿可移除；移除后注册表为空
    removeDraft("retail", root);
    expect(listProfileSlugs(root)).toEqual([]);
  });

  it("slug 非法拒绝；重复 slug 拒绝（幂等键保护）", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundles-"));
    const bad = { slug: "Retail!!", displayName: "x", version: "0.1.0", changelog: "x", fenceRef: "f", ownerMemberNo: "MEM-001" };
    expect(() => scaffoldDraft(bad, root)).toThrowError(BundleError);
    const good = { ...bad, slug: "retail" };
    scaffoldDraft(good, root);
    expect(() => scaffoldDraft(good, root)).toThrowError(/已存在/);
  });

  it("已激活/已分发 profile 不可移除（§2.3 保护）", () => {
    // hotel 非草稿（真实仓库 bundles/hotel）
    expect(() => removeDraft("hotel")).toThrowError(/仅草稿态/);
  });

  it("页面注册表覆盖九大页（UI 用例同步校验基准）", () => {
    expect(REGISTERED_PAGES).toContain("p7");
    expect(REGISTERED_PAGES.length).toBe(9);
  });

  it("候选行业包篡改后完整性校验失败关闭", () => {
    const source = new URL("../../../bundles/hotel/bundle.json", import.meta.url);
    const manifest = JSON.parse(readFileSync(source, "utf8"));
    expect(verifyBundleManifestDocument(manifest, "hotel").workloom.ui.serviceFront.enabled).toBe(true);
    manifest.workloom.displayName = "被篡改的名称";
    expect(() => verifyBundleManifestDocument(manifest, "hotel"))
      .toThrow(/完整性摘要不一致/);
  });

  it("候选行业包任一声明资产被篡改后运行时拒绝装载", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundle-asset-integrity-"));
    const source = new URL("../../../bundles/hotel", import.meta.url).pathname;
    cpSync(source, join(root, "hotel"), { recursive: true });
    const asset = join(root, "hotel/presets/pricing-agent.yml");
    writeFileSync(asset, `${readFileSync(asset, "utf8")}\n# 未经封装的篡改\n`, "utf8");
    expect(() => loadVerifiedBundleManifest("hotel", root))
      .toThrow(/资产.*内容与摘要不一致/);
  });

  it("稳定包无条件使用独立 Ed25519 公钥环验签，并拒绝同目录换根、错钥与撤销密钥", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundle-ed25519-"));
    const source = new URL("../../../bundles/hotel", import.meta.url).pathname;
    cpSync(source, join(root, "hotel"), { recursive: true });
    const manifestPath = join(root, "hotel/bundle.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.workloom.status = "stable";
    const normalizedStable = parseBundleManifest(manifest);
    manifest.integrity.digest = createHash("sha256")
      .update(canonicalBundleArtifactPayload(normalizedStable, normalizedStable.integrity?.assets))
      .digest("hex");
    const first = generateKeyPairSync("ed25519");
    const second = generateKeyPairSync("ed25519");
    const publicPem = (key: typeof first.publicKey) => key.export({ type: "spki", format: "pem" }).toString();
    const ring = (revoked: string[] = []) => ({
      schemaVersion: "workloom.bundle.trust/v1",
      keys: {
        "release-v1": { algorithm: "ed25519", publicKey: publicPem(first.publicKey) },
        "release-v2": { algorithm: "ed25519", publicKey: publicPem(second.publicKey) },
      },
      revoked,
    });
    const signWith = (keyId: string, privateKey: typeof first.privateKey) => {
      manifest.integrity.signature = {
        algorithm: "ed25519",
        keyId,
        value: signValue(null, Buffer.from(manifest.integrity.digest, "hex"), privateKey).toString("base64"),
      };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    };
    const previousNodeEnv = process.env.NODE_ENV;
    const previousVerificationKeys = process.env.BUNDLE_VERIFICATION_KEYS;
    const previousTrustPath = process.env.BUNDLE_TRUST_PATH;
    try {
      delete process.env.NODE_ENV;
      delete process.env.BUNDLE_TRUST_PATH;
      process.env.BUNDLE_VERIFICATION_KEYS = JSON.stringify(ring());
      signWith("release-v1", first.privateKey);
      expect(loadVerifiedBundleManifest("hotel", root).workloom.industry).toBe("hotel");

      // 攻击者即使替换 Bundle 目录中的伪公钥环并自签，运行时也不把它当成信任根。
      writeFileSync(join(root, ".verification-keys.json"), `${JSON.stringify({
        ...ring(),
        keys: { "release-v1": { algorithm: "ed25519", publicKey: publicPem(second.publicKey) } },
      }, null, 2)}\n`);
      signWith("release-v1", second.privateKey);
      expect(() => loadVerifiedBundleManifest("hotel", root)).toThrow(/无法验证/);

      signWith("release-v2", second.privateKey);
      expect(loadVerifiedBundleManifest("hotel", root).integrity?.signature?.keyId).toBe("release-v2");
      process.env.BUNDLE_VERIFICATION_KEYS = JSON.stringify(ring(["release-v2"]));
      expect(() => loadVerifiedBundleManifest("hotel", root)).toThrow(/已撤销/);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousVerificationKeys === undefined) delete process.env.BUNDLE_VERIFICATION_KEYS;
      else process.env.BUNDLE_VERIFICATION_KEYS = previousVerificationKeys;
      if (previousTrustPath === undefined) delete process.env.BUNDLE_TRUST_PATH;
      else process.env.BUNDLE_TRUST_PATH = previousTrustPath;
    }
  });

  it("三端 UI 只读取通过完整性校验的当前行业投影", () => {
    const projection = loadBundleUiProjection("ai-pm");
    expect(projection.bundleId).toBe("ai-pm");
    expect(projection.ui.navigation.slots[0]?.title).toBe("开发场域");
    expect(projection.ui.home.widgets[0]?.component).toBe("QuickTaskList");
    expect(projection.ui.terminology["actor.requirement-analyst"]).toBe("需求分析官");
    expect(() => loadBundleUiProjection("missing-industry")).toThrow(/不存在或不可读取/);
  });

  it.each([
    {
      label: "缺少 coverage",
      mutate: (root: string) => {
        const path = join(root, "hotel/presets/pricing-agent.yml");
        const preset = YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        delete preset.coverage;
        writeFileSync(path, YAML.stringify(preset));
      },
      expected: /pricing-agent\.yml.*coverage/s,
    },
    {
      label: "缺少 night_shift",
      mutate: (root: string) => {
        const path = join(root, "hotel/presets/pricing-agent.yml");
        const preset = YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        delete preset.night_shift;
        writeFileSync(path, YAML.stringify(preset));
      },
      expected: /pricing-agent\.yml.*night_shift/s,
    },
    {
      label: "重复事件前缀",
      mutate: (root: string) => {
        const path = join(root, "hotel/presets/review-agent.yml");
        const preset = YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        preset.coverage = [{ eventPrefix: "price.", label: "重复覆盖" }];
        writeFileSync(path, YAML.stringify(preset));
      },
      expected: /事件前缀 price\. 已由岗位 pricing-agent 认领/,
    },
  ])("运行时装配在 $label 时失败关闭", ({ mutate, expected }) => {
    const root = mkdtempSync(join(tmpdir(), "wl-workforce-contract-"));
    const source = new URL("../../../bundles/hotel", import.meta.url).pathname;
    cpSync(source, join(root, "hotel"), { recursive: true });
    const manifestPath = join(root, "hotel/bundle.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.workloom.status = "draft";
    delete manifest.integrity;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    mutate(root);

    expect(() => loadVerifiedBundleWorkforcePresets("hotel", root)).toThrow(expected);
  });

  it("开发通道公开通过校验且明确开放的候选包，生产通道只公开稳定包", () => {
    const registry = listSelfServiceBundles();
    expect(registry.version).toMatch(/^[a-f0-9]{16}$/);
    expect(registry.entries.map((entry) => entry.slug)).toEqual(["ai-pm", "hotel"]);
    expect(registry.entries.every((entry) => entry.provisioningMode === "guided-assembly")).toBe(true);
    expect(registry.rejected).toContainEqual(expect.objectContaining({ slug: "platform", reason: "未开放自助开通" }));
    const previousNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const productionRegistry = listSelfServiceBundles();
      expect(productionRegistry.entries).toEqual([]);
      expect(productionRegistry.rejected).toContainEqual(expect.objectContaining({
        slug: "hotel",
        reason: "尚未进入稳定发布状态",
      }));
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });
});

/* ---------------- PG 集成（同一数据库可重跑） ---------------- */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
describe.runIf(RUN_DB)("行业装配 PG 集成（F2.10 铁律）", async () => {
  const pg = await import("pg");
  const {
    activateBundle, recheckBundle, createBundleDraft,
  } = await import("./assembly.js");
  const app = new pg.default.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gw = new pg.default.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const owner = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
  const fixtureSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const scope = { tenantId: "tenant-demo", workspaceId: `ws-bundle-${fixtureSuffix}` };

  beforeAll(async () => {
    // 每个测试进程复制一份最小 hotel 装配实物，避免并行的 onboarding/Bundle 用例
    // 共同翻转 ws-yunqi.industry，造成状态断言与草稿激活互相污染。
    const workspace = await owner.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage, night_config)
       SELECT $1, tenant_id, '行业装配隔离夹具', $2, industry, stage, night_config
       FROM workspaces WHERE id='ws-yunqi' RETURNING id`,
      [scope.workspaceId, `bundle-${fixtureSuffix}`],
    );
    if (!workspace.rows[0]) throw new Error("行业装配测试缺少显式 hotel 种子工作区 ws-yunqi");
    await owner.query(
      `INSERT INTO profiles (workspace_id, tenant_id, industry, archive, forbidden, pii_vault)
       SELECT $1, tenant_id, industry, archive, forbidden, pii_vault
       FROM profiles WHERE workspace_id='ws-yunqi'`,
      [scope.workspaceId],
    );
    await owner.query(
      `INSERT INTO agents
         (id, workspace_id, preset_key, name, version, kind, readonly, fence_bindings, skills, status, invalid_reason, meta)
       SELECT id || '-' || $2, $1, preset_key, name, version, kind, readonly,
              fence_bindings, skills, status, invalid_reason, meta
       FROM agents WHERE workspace_id='ws-yunqi'`,
      [scope.workspaceId, fixtureSuffix],
    );
    await owner.query(
      `INSERT INTO fence_rules
         (id, rule_id, version, workspace_id, name, level, match_spec, action,
          is_baseline, status, created_by, approved_event_id)
       SELECT id || '-' || $2, rule_id, version, $1, name, level, match_spec, action,
              is_baseline, status, created_by, approved_event_id
       FROM fence_rules WHERE workspace_id='ws-yunqi'`,
      [scope.workspaceId, fixtureSuffix],
    );
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM fence_rules WHERE workspace_id=$1`, [scope.workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM agents WHERE workspace_id=$1`, [scope.workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM profiles WHERE workspace_id=$1`, [scope.workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM workspaces WHERE id=$1`, [scope.workspaceId]).catch(() => undefined);
    await Promise.all([app.end(), gw.end(), owner.end()]);
  });
  /** app 池断言查询辅助：事务内设 RLS 上下文（与生产口径一致；池直查在 RLS 下恒 0 行） */
  const qApp = async <T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []) => {
    const c = await app.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const r = await c.query<T>(sql, params);
      await c.query("COMMIT");
      return r;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  };


  it("hotel profile：七槽 7/7 已装配 + 起飞前检查单七项全绿（F2.10 + v3.0 第⑦槽）", async () => {
    const p = await computeAssembly(app, scope, "hotel");
    expect(p.status).toBe("active");
    expect(p.filledCount).toBe(7);
    // GR-03 起检查单新增第⑥项「围栏-工具词表交叉校验」
    expect(p.checks.map((c) => c.ok)).toEqual([true, true, true, true, true, true, true]);
    expect(p.canActivate).toBe(true);
    // 班组卡：7 preset 全注册且围栏绑定合法（P7E2）
    expect(p.agents.length).toBe(7);
    expect(p.agents.every((a) => a.fenceOk)).toBe(true);
    // 槽摘要口径（2026-09-23 文案接地气批次）：客户档案 N 组字段 · 硬约束 M 条；
    // 界面 N 个页面 · M 条界面状态用例；第⑦槽模型与成本策略
    expect(p.slots[0]!.summary).toContain("组字段");
    expect(p.slots[0]!.summary).toContain("硬约束");
    expect(p.slots[5]!.summary).toBe("6 个页面 · 42 条界面状态用例");
    expect(p.slots[6]!.id).toBe("model-policy");
    expect(p.slots[6]!.summary).toContain("个使用场景");
  });

  it("校验留痕：recheck 写 bundle.check_run 事件（P7E3 留痕可查）", async () => {
    const r = await recheckBundle(app, gw, scope, "hotel", "MEM-001");
    expect(r.eventId).toMatch(/^E-\d+$/);
    const ev = await qApp(
      `SELECT payload->'decision'->>'action' AS action FROM biz_events WHERE event_id=$1`, [r.eventId]);
    expect(ev.rows[0]!.action).toBe("bundle.check_run");
  });

  it("激活幂等：hotel 已激活仍可重激活并留痕 bundle.activate", async () => {
    const r = await activateBundle(app, gw, scope, "hotel", "MEM-001");
    expect(r.eventId).toMatch(/^E-\d+$/);
    const ind = await qApp(`SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
    expect(ind.rows[0]!.industry).toBe("hotel");
  });

  it("H-15 第三行业五要素填充即可运行：填满五槽 → 6/6 全绿 → 激活切换 → 底座代码零改动（§2.3/§2.4）", async () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundles-h15-"));
    // 五要素填充 = 复制 hotel 实物资产作为第三行业草稿内容（演示口径：资产由行业方提供，非底座代码）
    // #25 修复：用 import.meta.url 定位仓库根（原 process.cwd() 相对路径仅在包目录下跑测试才成立）
    const hotelDir = new URL("../../../bundles/hotel", import.meta.url).pathname;
    cpSync(hotelDir, join(root, "copycat"), { recursive: true });
    const bjPath = join(root, "copycat", "bundle.json");
    const bj = JSON.parse(readFileSync(bjPath, "utf-8"));
    bj.name = "@workloom/copycat"; bj.workloom.industry = "copycat"; bj.workloom.status = "draft";
    delete bj.integrity;
    writeFileSync(bjPath, `${JSON.stringify(bj, null, 2)}\n`, "utf-8");

    // finally 还原演示工作区（hotel）：断言中断也不残留 industry 污染（测试纪律：不跨用例污染）
    try {
      const p0 = await computeAssembly(app, scope, "copycat", root);
      expect(p0.status).toBe("draft");
      expect(p0.filledCount).toBe(7); // 五要素填满 + 第⑦槽 model-policy.yml（随 hotel 资产复制） → 七槽全装配
      expect(p0.canActivate).toBe(true); // 检查单六项全绿

      const act = await activateBundle(app, gw, scope, "copycat", "MEM-001", root);
      expect(act.eventId).toMatch(/^E-\d+$/);
      const ind = await qApp(`SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
      expect(ind.rows[0]!.industry).toBe("copycat"); // profile 切换生效（§2.3）

      // 激活态复核：档案/阶段一致性校验同样全绿（isActive 分支）
      const p1 = await computeAssembly(app, scope, "copycat", root);
      expect(p1.status).toBe("active");
      expect(p1.checks.every((c) => c.ok)).toBe(true);
    } finally {
      await activateBundle(app, gw, scope, "hotel", "MEM-001"); // 还原演示工作区
    }
    const back = await qApp(`SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
    expect(back.rows[0]!.industry).toBe("hotel");
  }, 20000);

  it("草稿 Bundle：六槽待填充 + 校验五项全红（第⑦槽骨架自带不阻断）+ 拒绝激活（F2.10 不静默 L9.2）", async () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundles-"));
    const slug = `draft-${Date.now().toString(36)}`;
    const created = await createBundleDraft(gw, scope, {
      slug, displayName: "草稿行业", version: "0.1.0",
      changelog: "测试草稿", fenceRef: "hotel-baseline/v1", ownerMemberNo: "MEM-002",
    }, "MEM-002", root);
    expect(created.eventId).toMatch(/^E-\d+$/);

    const p = await computeAssembly(app, scope, slug, root);
    expect(p.status).toBe("draft");
    // v3.0：草稿自带第⑦槽 model-policy.yml 骨架（filled=1）；其余六槽待填充
    expect(p.filledCount).toBe(1);
    expect(p.canActivate).toBe(false);
    const failed = p.checks.filter((c) => !c.ok);
    expect(failed.length).toBe(5); // 五项铁律校验全红
    expect(failed.every((c) => c.fix)).toBe(true); // 每项失败都带修复指引（FixList）
    expect(p.checks.find((c) => c.key === "model_policy")?.ok).toBe(true); // 第⑦槽骨架即合法（非阻断）

    await expect(activateBundle(app, gw, scope, slug, "MEM-002", root))
      .rejects.toMatchObject({ code: "ASSEMBLY_CHECK_FAILED" });
  }, 20000);
});
