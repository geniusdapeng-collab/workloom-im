import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const data = vi.hoisted(() => ({ token: "test-only-github-unit-marker" as string | null }));
vi.mock("./events.js", () => ({
  svcQuery: vi.fn(async () => data.token ? [{ secret_enc: data.token }] : []),
  serviceTx: vi.fn(async () => { throw new Error("GitHub pulse must not write a service transaction"); }),
}));
vi.mock("./llm.js", () => ({ llmCall: () => undefined }));

type FetchInput = Parameters<typeof fetch>[0];
type FetchOptions = Parameters<typeof fetch>[1];
interface RequestProof { url: URL; headers: Headers; options: FetchOptions }
const api = "https://api.github.com";
const enterprise = "https://enterprise.github-fixture.invalid";
const mirror = "https://mirror.github-fixture.invalid";
let calls: RequestProof[] = [];

function facts(url: URL): Response {
  const value = url.pathname.endsWith("/commits") ? [{ sha: "test-only-fact" }]
    : url.pathname.endsWith("/issues") ? [{ id: 1 }, { id: 2, pull_request: {} }]
    : [{ id: 1 }, { id: 2 }];
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}
function redirect(location: string | null, status = 302): Response {
  return new Response(null, { status, headers: location === null ? {} : { Location: location } });
}
function transport(handler: (url: URL, options: FetchOptions) => Response | Promise<Response> = facts): void {
  vi.stubGlobal("fetch", vi.fn(async (input: FetchInput, options?: FetchOptions): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ url, headers: new Headers(options?.headers), options });
    return handler(url, options);
  }));
}
async function pulse(base = api, trusted = "") {
  vi.stubEnv("GITHUB_API_BASE", base);
  vi.stubEnv("GITHUB_TRUSTED_API_ORIGINS", trusted);
  const { githubPulse } = await import("./aipm.js");
  return githubPulse("test-only-workspace", ["fixture/repository"]);
}
function expectFacts(result: Awaited<ReturnType<typeof pulse>>): void {
  expect(result.pulses).toMatchObject([{ commits7d: 1, openIssues: 1, openPrs: 2, mock: false }]);
  expect(result.mock).toBe(true); // model unavailable, despite actual structured GitHub facts
}
function expectAnonymous(rows = calls): void { expect(rows.every(row => !row.headers.has("authorization"))).toBe(true); }
function expectAuthorized(rows = calls): void {
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every(row => row.headers.get("authorization") === "Bearer " + data.token)).toBe(true);
}

describe("GitHub pulse credential destination boundary", () => {
  beforeEach(() => {
    vi.resetModules(); calls = [];
    data.token = "test-only-github-unit-marker";
    vi.stubEnv("AIPM_GITHUB_TOKEN", "");
    transport();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("authenticates the exact default HTTPS API with explicit manual redirects", async () => {
    expectFacts(await pulse()); expectAuthorized();
    expect(calls).toHaveLength(3);
    expect(calls.every(row => row.options?.redirect === "manual")).toBe(true);
  });
  it.each([api, enterprise, mirror])("keeps %s anonymous when the workspace has no credential", async (base) => {
    data.token = null; expectFacts(await pulse(base, enterprise)); expectAnonymous();
  });
  it.each([mirror, enterprise + "/api/v3", "http://api.github.com", "https://api.github.com.evil.invalid", "https://api-github.com", api + ":444"])(
    "does not grant credential authority to configured base %s", async (base) => {
      expectFacts(await pulse(base)); expectAnonymous();
    },
  );
  it("uses the independently declared enterprise origin while retaining its API path", async () => {
    expectFacts(await pulse(enterprise + "/api/v3", enterprise)); expectAuthorized();
    expect(calls.every(row => row.url.pathname.startsWith("/api/v3/repos/"))).toBe(true);
  });
  it.each([enterprise + "/api/v3", enterprise + "?all=yes", enterprise + "#all", "https://synthetic:x@enterprise.github-fixture.invalid", "http://enterprise.github-fixture.invalid", "not-a-url"])(
    "ignores malformed trusted-origin declaration %s", async (declared) => {
      expectFacts(await pulse(enterprise, declared)); expectAnonymous();
    },
  );
  it("normalizes host case and default port without widening the default origin", async () => {
    expectFacts(await pulse("https://API.GITHUB.COM:443/")); expectAuthorized();
  });
  it.each(["https://synthetic:x@api.github.com", "file:///synthetic", "not-a-url"])(
    "rejects unsafe initial base %s before fetching and retains anonymous fallback", async (base) => {
      expectFacts(await pulse(base + "," + mirror));
      expect(calls).toHaveLength(3); expect(calls.every(row => row.url.origin === mirror)).toBe(true); expectAnonymous();
    },
  );
  it.each(["status", "non-json", "throw"])("a %s primary failure cannot reuse its headers for anonymous fallback", async (kind) => {
    transport(url => {
      if (url.origin !== api) return facts(url);
      if (kind === "throw") throw new Error("test-only transport failure");
      return kind === "non-json" ? new Response("<not-json>") : new Response(null, { status: 503 });
    });
    expectFacts(await pulse(api + "," + mirror));
    expectAuthorized(calls.filter(row => row.url.origin === api)); expectAnonymous(calls.filter(row => row.url.origin === mirror));
  });
  it("retains credentials across a same origin redirect and shares the timeout for each chain", async () => {
    transport(url => url.pathname.startsWith("/next/") ? facts(url) : redirect("/next" + url.pathname + url.search, 307));
    expectFacts(await pulse()); expect(calls).toHaveLength(6); expectAuthorized();
    expect(new Set(calls.map(row => row.options?.signal)).size).toBe(3);
  });
  it.each(["", enterprise])("strips credentials for cross origin redirects even when destination is separately trusted (%s)", async (trusted) => {
    transport(url => url.origin === api ? redirect(enterprise + url.pathname + url.search) : facts(url));
    expectFacts(await pulse(api, trusted)); expect(calls).toHaveLength(6);
    expectAuthorized(calls.filter(row => row.url.origin === api)); expectAnonymous(calls.filter(row => row.url.origin === enterprise));
  });
  it("does not add credentials when an anonymous mirror redirects to a trusted API", async () => {
    transport(url => url.origin === mirror ? redirect(api + url.pathname + url.search) : facts(url));
    expectFacts(await pulse(mirror)); expect(calls).toHaveLength(6); expectAnonymous();
  });
  it("never restores credentials after A to B to A redirects", async () => {
    transport(url => url.origin === mirror ? redirect(api + "/returned" + url.pathname + url.search)
      : url.pathname.startsWith("/returned/") ? facts(url) : redirect(mirror + url.pathname + url.search));
    expectFacts(await pulse()); expect(calls).toHaveLength(9);
    expectAnonymous(calls.filter(row => row.url.origin === mirror || row.url.pathname.startsWith("/returned/")));
  });
  it.each(["http://api.github.com", "https://synthetic:x@api.github.com", "file:///synthetic"])(
    "rejects unsafe redirect destination %s before fetching it", async (target) => {
      transport(url => url.pathname.startsWith("/next/") ? facts(url) : redirect(target + "/next" + url.pathname));
      const result = await pulse(); expect(result.pulses[0]?.mock).toBe(true);
      expect(calls).toHaveLength(3); expect(calls.every(row => row.url.protocol === "https:" && !row.url.username && !row.url.password)).toBe(true);
    },
  );
  it("bounds redirect loops to five hops and continues with anonymous fallback", async () => {
    transport(url => url.origin === api ? redirect(url.href) : facts(url));
    expectFacts(await pulse(api + "," + mirror));
    expect(calls.filter(row => row.url.origin === api)).toHaveLength(18); expectAnonymous(calls.filter(row => row.url.origin === mirror));
  });
  it("treats a missing Location as a source failure without leaking its error body", async () => {
    transport(url => url.origin === api ? redirect(null) : facts(url));
    expectFacts(await pulse(api + "," + mirror)); expectAnonymous(calls.filter(row => row.url.origin === mirror));
  });
  it("returns generic mock facts when every source fails and never includes response bodies or credentials", async () => {
    transport(() => new Response(JSON.stringify({ error: data.token }), { status: 500 }));
    const result = await pulse(api + "," + mirror);
    expect(result.pulses[0]?.mock).toBe(true); expect(JSON.stringify(result)).not.toContain(data.token);
  });
});
