/**
 * service/aipm · AI 产品经理技能真实执行面（方案 V4 P1）
 * 真实接线纪律：github-pulse 真实调 GitHub API；industry-radar 真实拉 RSS；
 * competitor-scan 真实抓取竞品页面；prd-forge 真实 LLM 生成可导出 MD。
 * 凭据走 credentials 表（L4 Patch 注入纪律：secret_enc 不进事件明文、不回传给前端）。
 * LLM 缺配置时返回 mock:true 的确定性兜底（D4 离线可跑），绝不假装真实。
 */
import { createHash } from "node:crypto";
import { svcQuery, serviceTx } from "./events.js";
import { llmCall } from "./llm.js";
import { requireServiceScope, type ServiceScope } from "./scope.js";

const UA = { "User-Agent": "WorkLoom-AIPM/1.0 (+https://github.com/workloom-ai/workloom-im)" };

/* ---------------- 凭据读取（仅服务端；secret 不出进程） ---------------- */
async function readCredential(workspaceId: string, provider: string): Promise<string | null> {
  const rows = await svcQuery<{ secret_enc: string }>(workspaceId,
    `SELECT secret_enc FROM credentials WHERE provider=$1 AND health != 'revoked' LIMIT 1`, [provider]);
  // 注意：当前 credentials 为开发态明文占位（正式环境接 KMS 解密层）；绝不写入事件/日志/响应体外
  return rows[0]?.secret_enc ?? process.env[`AIPM_${provider.toUpperCase().replace(/-/g, "_")}_TOKEN`] ?? null;
}

/* ---------------- github-pulse：仓库脉搏（真实 GitHub API） ---------------- */
/**
 * API base 回退链：直连 api.github.com 优先；不可达时走公共镜像（gh-proxy.com）。
 * 可用 GITHUB_API_BASE 环境变量覆盖整条链（逗号分隔多个 base 按序尝试）。
 * 数据源不等于凭据目的地：默认只授权 https://api.github.com；企业 API 须另列
 * GITHUB_TRUSTED_API_ORIGINS（HTTPS origin，不能含路径/用户信息/查询/片段）。
 * 每条重定向链最多 5 跳，跨 origin 后持续匿名；禁止 HTTPS 降级和 URL 用户信息。
 * 纪律：无论走哪个 base 都是真实 GitHub 数据；全部失败才落 mock（D4 绝不假装真实）。
 */
const GITHUB_API_BASES = (process.env.GITHUB_API_BASE ??
  "https://api.github.com,https://gh-proxy.com/https://api.github.com"
).split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);

const GITHUB_TRUSTED_API_ORIGINS = new Set(["https://api.github.com"]);
for (const value of (process.env.GITHUB_TRUSTED_API_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
  try {
    const url = new URL(value);
    if (/^https:\/\/[^/?#\\]+\/?$/i.test(value)
        && url.protocol === "https:" && !url.username && !url.password && url.href === `${url.origin}/`) {
      GITHUB_TRUSTED_API_ORIGINS.add(url.origin);
    }
  } catch {
    // 无效声明不能授予凭据；继续使用默认 origin 与其他有效声明。
    continue;
  }
}

const GITHUB_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const GITHUB_MAX_REDIRECTS = 5;

function githubRequestUrl(value: string, previous?: URL): URL {
  const url = new URL(value, previous);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password
      || previous?.protocol === "https:" && url.protocol !== "https:") {
    throw new Error("GitHub API destination rejected");
  }
  return url;
}

async function ghFetch(path: string, token: string | null): Promise<unknown> {
  let lastErr: unknown = null;
  for (const base of GITHUB_API_BASES) {
    try {
      let url = githubRequestUrl(`${base}${path}`);
      // 每个数据源单独构造 headers，不能把上一来源的凭据带入回退请求。
      const headers: Record<string, string> = { ...UA, Accept: "application/vnd.github+json" };
      if (token && GITHUB_TRUSTED_API_ORIGINS.has(url.origin)) headers.Authorization = `Bearer ${token}`;
      const signal = AbortSignal.timeout(12_000);
      for (let redirects = 0; ; redirects += 1) {
        const res = await fetch(url, { headers, signal, redirect: "manual" });
        if (GITHUB_REDIRECT_STATUSES.has(res.status)) {
          const location = res.headers.get("location");
          await res.body?.cancel();
          if (!location || redirects >= GITHUB_MAX_REDIRECTS) throw new Error("GitHub API redirect rejected");
          const next = githubRequestUrl(location, url);
          // 去授权对整条链生效；即使后续回到受信任 origin，也不重新附加。
          if (next.origin !== url.origin) delete headers.Authorization;
          url = next;
          continue;
        }
        if (res.ok) return await res.json();
        await res.body?.cancel();
        throw new Error(`GitHub API HTTP ${res.status}`);
      }
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("all GitHub API bases failed");
}

export interface RepoPulse {
  repo: string;
  commits7d: number;
  openIssues: number;
  openPrs: number;
  analysis: string;
  mock: boolean;
}

export async function githubPulse(workspaceId: string, repos: string[]): Promise<{ pulses: RepoPulse[]; mock: boolean }> {
  const token = await readCredential(workspaceId, "github");

  const pulses: RepoPulse[] = [];
  let anyMock = false;
  for (const repo of repos.slice(0, 8)) {
    try {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString();
      const [commits, issues, prs] = await Promise.all([
        ghFetch(`/repos/${repo}/commits?since=${since}&per_page=100`, token),
        ghFetch(`/repos/${repo}/issues?state=open&per_page=100`, token),
        ghFetch(`/repos/${repo}/pulls?state=open&per_page=100`, token),
      ]);
      const issueCount = (issues as unknown[]).filter((i) => !(i as { pull_request?: unknown }).pull_request).length;
      pulses.push({
        repo,
        commits7d: (commits as unknown[]).length,
        openIssues: issueCount,
        openPrs: (prs as unknown[]).length,
        analysis: "",
        mock: false,
      });
    } catch {
      anyMock = true;
      pulses.push({ repo, commits7d: 0, openIssues: 0, openPrs: 0, analysis: "（仓库读取失败——检查 token 与仓库名）", mock: true });
    }
  }

  // LLM 分析（缺配置走确定性模板兜底）
  const llm = llmCall("aipm-github-pulse");
  const facts = pulses.map((p) => `${p.repo}: 7天提交${p.commits7d}/开放issue${p.openIssues}/开放PR${p.openPrs}`).join("；");
  if (llm && !anyMock) {
    try {
      const analysis = await llm(
        `你是发布护航官。基于以下 GitHub 仓库近 7 天脉搏数据，给出 120 字内的产品健康度分析（活跃度/阻塞点/下一步建议），直接给结论：${facts}`);
      for (const p of pulses) p.analysis = analysis;
    } catch {
      for (const p of pulses) p.analysis = `近 7 天提交 ${p.commits7d} 次，开放 issue ${p.openIssues}、PR ${p.openPrs}。`;
    }
  } else {
    for (const p of pulses) if (!p.analysis) p.analysis = `近 7 天提交 ${p.commits7d} 次，开放 issue ${p.openIssues}、PR ${p.openPrs}。`;
  }
  return { pulses, mock: anyMock || !llm };
}

/* ---------------- industry-radar：行业情报聚合（真实 RSS） ---------------- */
const DEFAULT_FEEDS = [
  "https://openai.com/news/rss.xml",
  "https://www.anthropic.com/news/rss.xml",
  "https://qbitai.com/feed",
];

export interface IntelItem {
  title: string;
  link: string;
  source: string;
  published: string;
  summary?: string;
}

export async function industryRadar(workspaceId: string, feeds?: string[]): Promise<{ items: IntelItem[]; mock: boolean }> {
  const sources = feeds ?? DEFAULT_FEEDS;
  const items: IntelItem[] = [];
  for (const url of sources) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const xml = await res.text();
      const host = new URL(url).hostname;
      // RSS/Atom 轻解析（<item>/<entry> 标题+链接+日期）
      const entries = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>|<entry[\s>]([\s\S]*?)<\/entry>/g)].slice(0, 8);
      for (const e of entries) {
        const body = e[1] ?? e[2] ?? "";
        const title = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(body)?.[1]?.trim();
        const link = /<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/.exec(body)?.[1]?.trim()
          ?? /<link[^>]*href="([^"]+)"/.exec(body)?.[1];
        const published = /<pubDate>([\s\S]*?)<\/pubDate>|<published[^>]*>([\s\S]*?)<\/published>|<updated[^>]*>([\s\S]*?)<\/updated>/.exec(body)?.slice(1).find(Boolean)?.trim() ?? "";
        if (title && link) items.push({ title, link, source: host, published });
      }
    } catch { /* 单源失败不阻塞其他源 */ }
  }
  // 去重（标题哈希）
  const seen = new Set<string>();
  const deduped = items.filter((it) => {
    const h = createHash("sha1").update(it.title).digest("hex");
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  }).slice(0, 12);

  // LLM 摘要 Top3（缺配置只附原始条目，标 mock）
  const llm = llmCall("aipm-industry-radar");
  if (llm && deduped.length > 0) {
    try {
      const brief = await llm(
        `你是行业瞭望官。从以下 AI 行业新闻标题中精选最重要的 3 条，每条一句话说清"发生了什么+对产品人意味着什么"，附序号：\n${deduped.map((i, n) => `${n + 1}. ${i.title}（${i.source}）`).join("\n")}`);
      for (const it of deduped) it.summary = brief;
    } catch { /* 摘要失败保留原条目 */ }
  }
  // 落库留痕（情报集）
  await serviceTx(workspaceId, async (client) => {
    for (const it of deduped) {
      await client.query(
        `INSERT INTO kb_documents (id, workspace_id, collection_id, title, source_kind, source_url, version, status, content_md, hash, created_at)
         VALUES ($1,$2,$3,$4,'official_site',$5,1,'active',$6,$7,now())
         ON CONFLICT (id) DO NOTHING`,
        [`kd-intel-${createHash("sha1").update(it.link).digest("hex").slice(0, 12)}`, workspaceId,
         `kc-${workspaceId}-行业情报`, it.title.slice(0, 120), it.link, it.summary ?? it.title,
         createHash("sha1").update(it.link).digest("hex")],
      ).catch(() => undefined);   // 集合不存在时静默（不影响返回）
    }
  });
  return { items: deduped, mock: !llm };
}

/* ---------------- competitor-scan：竞品页面抓取对比（真实 fetch） ---------------- */
const COMPETITOR_SNAPSHOT_SCHEMA = "workloom.aipm/competitor-snapshot@1";

export interface CompetitorReport {
  name: string;
  url: string;
  changed: boolean;
  snippet: string;
  mock: boolean;
  error?: "scope" | "fetch" | "snapshot";
}

interface CompetitorSnapshotRow {
  tenant_id: string;
  workspace_id: string;
  scope: string;
  kind: string;
  status: string;
  content: string;
}

/** 保留其他记忆及召回状态；命名空间内的损坏或归属冲突也必须拒写。 */
function competitorSnapshotHash(row: CompetitorSnapshotRow, scope: ServiceScope, url: string): string {
  if (row.tenant_id !== scope.tenantId || row.workspace_id !== scope.workspaceId
      || row.scope !== "workspace" || row.kind !== "pattern" || row.status !== "active") {
    throw new Error("Competitor snapshot attribution rejected");
  }
  const value: unknown = JSON.parse(row.content);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Competitor snapshot content rejected");
  }
  const snapshot = value as Record<string, unknown>;
  if (Object.keys(snapshot).length !== 5 || snapshot.schema !== COMPETITOR_SNAPSHOT_SCHEMA
      || snapshot.tenantId !== scope.tenantId || snapshot.workspaceId !== scope.workspaceId
      || snapshot.url !== url || typeof snapshot.hash !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.hash)) {
    throw new Error("Competitor snapshot identity rejected");
  }
  return snapshot.hash;
}

function competitorFailure(target: { name: string; url: string }, error: NonNullable<CompetitorReport["error"]>): CompetitorReport {
  const snippets = {
    scope: "（竞品扫描不可用——工作区作用域未授权或验证失败）",
    fetch: "（抓取失败——网络、HTTP 或页面内容不可用）",
    snapshot: "（竞品快照保存失败——请稍后重试）",
  };
  // 不输出 URL、页面、数据库异常或上游响应体；阶段足以判断是否需要重试。
  console.warn(`[aipm] competitor-scan failed: ${error}`);
  return { ...target, changed: false, snippet: snippets[error], mock: true, error };
}

export async function competitorScan(workspaceId: string, targets: Array<{ name: string; url: string }>): Promise<{ reports: CompetitorReport[] }> {
  const selected = targets.slice(0, 6);
  if (selected.length === 0) return { reports: [] };
  let scope: Readonly<ServiceScope>;
  try {
    scope = requireServiceScope(workspaceId);
    // 只验证调用链已有的双作用域，不反查/推导 tenant。HTTP 前要求真实注册锚点。
    const allowed = await svcQuery<{ id: string }>(workspaceId,
      "SELECT id FROM workspaces WHERE id=$1 AND tenant_id=$2", [scope.workspaceId, scope.tenantId], scope);
    if (allowed.length !== 1) throw new Error("Competitor workspace scope rejected");
  } catch {
    return { reports: selected.map(target => competitorFailure(target, "scope")) };
  }

  const reports: CompetitorReport[] = [];
  for (const t of selected) {
    let stage: NonNullable<CompetitorReport["error"]> = "fetch";
    try {
      const url = new URL(t.url);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
        throw new Error("Competitor URL rejected");
      }
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12_000) });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error("Competitor HTTP response unavailable");
      }
      const html = await res.text();
      const text = html.replace(/<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>/gi, " ")
        .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!text) throw new Error("Competitor page content unavailable");
      const hash = createHash("sha256").update(text).digest("hex");
      const memoryId = "mem-comp-v1-" + createHash("sha256")
        .update(JSON.stringify([COMPETITOR_SNAPSHOT_SCHEMA, scope.tenantId, scope.workspaceId, t.url])).digest("hex");
      const content = JSON.stringify({ schema: COMPETITOR_SNAPSHOT_SCHEMA, tenantId: scope.tenantId,
        workspaceId: scope.workspaceId, url: t.url, hash });
      stage = "snapshot";
      // HTTP 已结束；同一身份的读/比较/写在一笔短事务内串行，提交失败不发成功回执。
      const changed = await serviceTx(workspaceId, async (client, current) => {
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [memoryId]);
        const previous = (await client.query<CompetitorSnapshotRow>(
          `SELECT tenant_id,workspace_id,scope,kind,status,content FROM org_memory
           WHERE memory_id=$1 AND tenant_id=$2 AND workspace_id=$3 FOR UPDATE`,
          [memoryId, current.tenantId, current.workspaceId],
        )).rows[0];
        const previousHash = previous ? competitorSnapshotHash(previous, current, t.url) : null;
        const saved = await client.query<CompetitorSnapshotRow>(
          `INSERT INTO org_memory (memory_id, tenant_id, workspace_id, scope, kind, content, source_events)
           VALUES ($1,$2,$3,'workspace','pattern',$4,'{}')
           ON CONFLICT (memory_id) DO UPDATE SET content=EXCLUDED.content
             WHERE org_memory.tenant_id=EXCLUDED.tenant_id AND org_memory.workspace_id=EXCLUDED.workspace_id
               AND org_memory.scope='workspace' AND org_memory.kind='pattern' AND org_memory.status='active'
               AND org_memory.content IS NOT DISTINCT FROM $5::text
           RETURNING tenant_id,workspace_id,scope,kind,status,content`,
          [memoryId, current.tenantId, current.workspaceId, content, previous?.content ?? null],
        );
        if (saved.rowCount !== 1 || !saved.rows[0]
            || competitorSnapshotHash(saved.rows[0], current, t.url) !== hash) {
          throw new Error("Competitor snapshot write rejected");
        }
        return previousHash !== null && previousHash !== hash;
      }, scope);
      reports.push({ name: t.name, url: t.url, changed, snippet: text.slice(0, 300), mock: false });
    } catch {
      reports.push(competitorFailure(t, stage));
    }
  }
  return { reports };
}

/* ---------------- prd-forge：PRD 起草与导出（真实 LLM） ---------------- */
export async function prdForge(workspaceId: string, requirement: { title: string; context?: string }): Promise<{ markdown: string; mock: boolean }> {
  const llm = llmCall("aipm-prd-forge");
  let markdown: string;
  let mock = false;
  if (llm) {
    try {
      markdown = await llm(
        `你是文档主笔官。为以下需求起草一份 PRD 初稿（Markdown，含五章：背景与问题/目标（可量化）/方案（含取舍）/边界（明确不做什么）/验收标准（可测））。需求标题：「${requirement.title}」。${requirement.context ? `背景补充：${requirement.context}` : ""}直接输出 Markdown 正文。`);
    } catch (e) {
      mock = true;
      markdown = fallbackPrd(requirement.title, (e as Error).message);
    }
  } else {
    mock = true;
    markdown = fallbackPrd(requirement.title, "模型未配置");
  }
  return { markdown, mock };
}

function fallbackPrd(title: string, note: string): string {
  return `# PRD：${title}\n\n> 本初稿由确定性骨架生成（${note}），接入真实模型后自动升级为完整初稿。\n\n## 一、背景与问题\n（待补充：用户痛点与现状数据）\n\n## 二、目标\n- 北极星指标：（待量化）\n- 里程碑：（待排期）\n\n## 三、方案\n（待补充：方案描述与关键取舍）\n\n## 四、边界（不做什么）\n- （待明确）\n\n## 五、验收标准\n- [ ] （可测量的验收项）\n`;
}
