/** The packaged server uses native ESM through tsx; Vitest's globals must not mask CommonJS-only calls. */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("accounts in the packaged server's native ESM runtime", () => {
  it("preserves short-code hashes and issues a real password-login/refresh session without require", () => {
    const script = String.raw`
      import assert from "node:assert/strict";
      async function main() {
      assert.equal(typeof require, "undefined", "the child must run as a native ES module");
      const kdf = await import(process.argv[1]);
      const tokens = await import(process.argv[2]);
      const service = await import(process.argv[3]);
      const { verifyToken } = await import(process.argv[4]);

      // Independent SHA-256 fixtures pin the existing stored-hash format.
      assert.equal(kdf.hashSecret("esm-runtime-fixture", "refresh"), "0f1e3c0300ead6aabaced498fba0f763496c653018beb67da2b7a746808b60ec");
      assert.equal(kdf.hashSecret(""), "4377f4276f015e0a8cb0dd19ae51ebc4d0cf6689d1796bc7dd7d5c38c90cadd7");
      assert.equal(kdf.hashSecret("酒店回归", "邀请码"), "95c07c7125304c763881a290c6b4203f2a210f053e23fa734d7ab26393546982");
      assert.notEqual(kdf.hashSecret("esm-runtime-fixture", "refresh"), kdf.hashSecret("esm-runtime-fixture", "invite"));
      const minted = tokens.mintRefreshToken();
      assert.match(minted.plain, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(tokens.hashRefreshToken(minted.plain), minted.hash);
      assert.notEqual(minted.hash, minted.plain);

      const identityRow = { member_id: "mem-esm-fixture", member_no: "MEM-ESM", name: "ESM regression fixture", role: "manager", tenant_id: "tenant-esm-fixture", workspace_id: "ws-esm-fixture", plan: "pro" };
      const passwordHash = kdf.hashPassword("test-only-synthetic-fixture-password");
      let sessionInserts = 0;
      let storedRefreshHash;
      let loginEvents = 0;
      const deps = {
        sms: { send: async () => { throw new Error("this password-login fixture must not send SMS"); } },
        q: async (sql, params) => {
          if (sql.includes("SELECT * FROM accounts WHERE email=$1")) return { rows: [{ id: "acc-esm-fixture", status: "active", password_hash: passwordHash }] };
          if (sql.includes("SELECT m.id AS member_id")) return { rows: [identityRow] };
          if (sql.includes("UPDATE accounts SET failed_attempts=0")) return { rows: [] };
          if (sql.includes("UPDATE accounts SET") && sql.includes("RETURNING locked_until")) return { rows: [{ locked_until: null }] };
          if (sql.includes("INSERT INTO login_events")) { loginEvents++; return { rows: [] }; }
          if (sql.includes("INSERT INTO auth_sessions")) { sessionInserts++; storedRefreshHash = params[2]; return { rows: [] }; }
          throw new Error("unregistered synthetic SQL: " + sql);
        },
      };
      const login = await service.loginWithPassword(deps, { email: "esm-fixture@example.invalid", password: "test-only-synthetic-fixture-password", workspaceSlug: "esm-fixture" });
      assert.equal(sessionInserts, 1);
      assert.equal(login.identity.role, "manager");
      assert.equal(login.identity.workspaceId, "ws-esm-fixture");
      assert.equal(tokens.hashRefreshToken(login.refreshToken), storedRefreshHash);
      assert.equal((await verifyToken(login.accessToken)).memberId, "mem-esm-fixture");
      await assert.rejects(service.loginWithPassword(deps, { email: "esm-fixture@example.invalid", password: "test-only-incorrect", workspaceSlug: "esm-fixture" }), /邮箱或密码不正确/);
      assert.equal(sessionInserts, 1, "a rejected password must not issue another session");
      assert.equal(loginEvents, 2);
      process.stdout.write(JSON.stringify({ nativeEsm: true, compatibleHashVectors: 3, refreshRoundTrip: true, passwordLogin: true, rejectedPassword: true, sessionInserts }));
      }
      main().catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
    `;
    const output = execFileSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", script,
      new URL("./kdf.ts", import.meta.url).href,
      new URL("./tokens.ts", import.meta.url).href,
      new URL("./service.ts", import.meta.url).href,
      new URL("../tenancy/auth.ts", import.meta.url).href,
    ], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      encoding: "utf8", timeout: 15_000,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8",
        NODE_ENV: "development", JWT_ISSUER: "esm-regression-fixture",
        JWT_SECRET: "synthetic-esm-regression-fixture-only-not-a-production-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(JSON.parse(output)).toEqual({ nativeEsm: true, compatibleHashVectors: 3, refreshRoundTrip: true, passwordLogin: true, rejectedPassword: true, sessionInserts: 1 });
  });
});
