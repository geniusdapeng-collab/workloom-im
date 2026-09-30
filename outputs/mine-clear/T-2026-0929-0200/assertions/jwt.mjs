/** 无依赖 HS256 JWT 签发（本地验收用；密钥从被测仓 .env 读取，不写入任何仓库文件） */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

export function envOf(repo) {
  const out = {};
  for (const line of readFileSync(`${repo}/.env`, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const b64 = (input) => Buffer.from(input).toString("base64url");

export function signHs256(payload, secret, { issuer = "workloom-im", ttlSeconds = 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iss: issuer, iat: now, exp: now + ttlSeconds };
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = b64(JSON.stringify(body));
  const data = `${head}.${claims}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function memberToken(secret, over = {}, opts) {
  return signHs256({
    kind: "member",
    memberId: "mem-probe-001",
    memberNo: "MEM-001",
    name: "探针",
    role: "owner",
    tenantId: "tenant-unknown",
    workspaceId: "ws-unknown",
    plan: "vpc",
    ...over,
  }, secret, opts);
}
