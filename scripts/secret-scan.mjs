#!/usr/bin/env node
/**
 * WorkLoom strict secret scanner (zero dependencies).
 *
 * Usage:
 *   node scripts/secret-scan.mjs --files AGENTS.md WORKLOOM_PRODUCT_CONTEXT.md
 *   node scripts/secret-scan.mjs --staged
 *   node scripts/secret-scan.mjs --range <base> <head>
 *   node scripts/secret-scan.mjs --self-test
 *
 * Findings intentionally contain only the rule id, file and line number. Never
 * print the matched value: scanner output is routinely copied into CI logs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const RULES = [
  { id: "private-key", pattern: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/g },
  { id: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { id: "openai-key", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "slack-token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g },
  { id: "stripe-live-key", pattern: /\b[rs]k_live_[0-9A-Za-z]{16,}\b/g },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { id: "pypi-token", pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}\b/g },
  { id: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: "bearer-token", pattern: /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{20,}(?=$|[\s"',;])/gi },
  {
    id: "credential-in-url",
    pattern: /\b(?:https?|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^/\s:@]+:[^@\s/]{8,}@/gi,
  },
];

const ASSIGNMENT_PATTERN = /\b(api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|refresh[_-]?token|client[_-]?secret|webhook[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key|private[_-]?key|signing[_-]?key|database[_-]?url|connection[_-]?string|secret|token|password|passwd)\b["']?\s*(?::|=)\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|([^\s#,;]+))/gi;

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function isSafePlaceholder(raw) {
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (!value) return true;
  if (value.startsWith("$") || value.startsWith("<") || value.startsWith("{{")) return true;
  if (/^(?:\*+|x+|none|null|false|true)$/i.test(value)) return true;
  if (/^(?:process\.)?env[.[_]/i.test(value)) return true;
  return [
    "example", "sample", "placeholder", "replace-me", "replace_me", "changeme",
    "redacted", "dummy", "fake", "mock", "test-only", "not-a-token",
  ].some((marker) => lower.includes(marker));
}

function scanText(file, text) {
  const findings = [];

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      findings.push({ rule: rule.id, file, line: lineNumberAt(text, match.index ?? 0) });
    }
  }

  ASSIGNMENT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(ASSIGNMENT_PATTERN)) {
    const value = match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
    if (value.length >= 8 && !isSafePlaceholder(value)) {
      findings.push({ rule: "literal-sensitive-assignment", file, line: lineNumberAt(text, match.index ?? 0) });
    }
  }

  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.rule}\u0000${finding.file}\u0000${finding.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function displayPath(path) {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") ? rel : path;
}

function readExplicitFiles(paths) {
  if (paths.length === 0) throw new Error("--files requires at least one path");
  return paths.map((input) => {
    const path = resolve(input);
    if (!existsSync(path)) throw new Error(`required scan target is missing: ${displayPath(path)}`);
    return { file: displayPath(path), text: readFileSync(path, "utf8") };
  });
}

function readStagedFiles(cwd = process.cwd()) {
  const names = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    { cwd, encoding: "utf8" },
  ).split("\u0000").filter(Boolean);

  return names.flatMap((file) => {
    const body = execFileSync("git", ["show", `:${file}`], { cwd });
    if (body.includes(0)) return [];
    return [{ file, text: body.toString("utf8") }];
  });
}

function resolveCommit(ref, cwd) {
  const sha = execFileSync(
    "git",
    ["rev-parse", "--verify", `${ref}^{commit}`],
    { cwd, encoding: "utf8" },
  ).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error(`invalid commit resolved from ${ref}`);
  return sha;
}

function readRangeFiles(base, head, cwd = process.cwd()) {
  const baseSha = resolveCommit(base, cwd);
  const headSha = resolveCommit(head, cwd);
  const names = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", "-z", baseSha, headSha, "--"],
    { cwd, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
  ).split("\u0000").filter(Boolean);

  return names.flatMap((file) => {
    const body = execFileSync(
      "git",
      ["show", `${headSha}:${file}`],
      { cwd, maxBuffer: 100 * 1024 * 1024 },
    );
    if (body.includes(0)) return [];
    return [{ file, text: body.toString("utf8") }];
  });
}

function runSelfTest() {
  const dangerous = [
    "token=" + "ghp_" + "A".repeat(36),
    "api_key=" + "sk-" + "B".repeat(40),
    "password=" + ["correct", "horse", "battery", "staple"].join("-"),
    "\"client_secret\": \"" + "C".repeat(32) + "\"",
    "Authorization: Bearer " + "D".repeat(40),
    "-----BEGIN " + "PRIVATE KEY-----",
  ].join("\n");
  const safe = [
    "token=${{ secrets.GITHUB_TOKEN }}",
    "COMPUTER_USE_TOKEN=<strong-token>",
    "api_key=sk-example-placeholder",
    "password=mock-test-only",
  ].join("\n");

  const dangerousFindings = scanText("dangerous.md", dangerous);
  const safeFindings = scanText("safe.md", safe);
  const dangerousRules = new Set(dangerousFindings.map(({ rule }) => rule));
  if (
    !dangerousRules.has("github-token") ||
    !dangerousRules.has("openai-key") ||
    !dangerousRules.has("literal-sensitive-assignment") ||
    dangerousFindings.filter(({ rule }) => rule === "literal-sensitive-assignment").length < 2 ||
    !dangerousRules.has("bearer-token") ||
    !dangerousRules.has("private-key") ||
    safeFindings.length !== 0
  ) {
    throw new Error(`self-test failed (dangerous=${dangerousFindings.length}, safe=${safeFindings.length})`);
  }

  const repo = mkdtempSync(join(tmpdir(), "workloom-secret-scan-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    writeFileSync(join(repo, "context.md"), "token=" + "ghp_" + "C".repeat(36) + "\n", { mode: 0o600 });
    execFileSync("git", ["add", "--", "context.md"], { cwd: repo });
    const staged = readStagedFiles(repo);
    const stagedFindings = staged.flatMap(({ file, text }) => scanText(file, text));
    if (staged.length !== 1 || stagedFindings.length === 0) {
      throw new Error(`staged self-test failed (files=${staged.length}, findings=${stagedFindings.length})`);
    }

    execFileSync("git", ["-c", "user.name=Secret Scan", "-c", "user.email=scan@example.invalid", "commit", "--quiet", "-m", "base"], { cwd: repo });
    const baseSha = resolveCommit("HEAD", repo);
    writeFileSync(join(repo, "context.md"), "api_key=" + "sk-" + "D".repeat(40) + "\n", { mode: 0o600 });
    writeFileSync(join(repo, "asset.bin"), Buffer.from("\u0000token=" + "ghp_" + "E".repeat(36)));
    execFileSync("git", ["add", "--", "context.md", "asset.bin"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Secret Scan", "-c", "user.email=scan@example.invalid", "commit", "--quiet", "-m", "range"], { cwd: repo });
    const headSha = resolveCommit("HEAD", repo);
    const range = readRangeFiles(baseSha, headSha, repo);
    const rangeFindings = range.flatMap(({ file, text }) => scanText(file, text));
    if (range.length !== 1 || rangeFindings.length === 0) {
      throw new Error(`range self-test failed (files=${range.length}, findings=${rangeFindings.length})`);
    }
    if (readRangeFiles(headSha, headSha, repo).length !== 0) {
      throw new Error("empty range self-test failed");
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  console.log("secret-scan self-test: PASS");
}

function usage() {
  console.error("usage: secret-scan.mjs --files <path...> | --staged | --range <base> <head> | --self-test");
  process.exitCode = 64;
}

const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === "--self-test") {
    runSelfTest();
  } else {
    let inputs;
    if (args[0] === "--files") inputs = readExplicitFiles(args.slice(1));
    else if (args.length === 1 && args[0] === "--staged") inputs = readStagedFiles();
    else if (args.length === 3 && args[0] === "--range") inputs = readRangeFiles(args[1], args[2]);
    else {
      usage();
      process.exit();
    }

    const findings = inputs.flatMap(({ file, text }) => scanText(file, text));
    if (findings.length > 0) {
      console.error(`secret-scan: BLOCKED (${findings.length} finding(s); values suppressed)`);
      for (const finding of findings) console.error(`[${finding.rule}] ${finding.file}:${finding.line}`);
      process.exitCode = 1;
    } else {
      console.log(`secret-scan: PASS (${inputs.length} text file(s))`);
    }
  }
} catch (error) {
  console.error(`secret-scan: ERROR (${error instanceof Error ? error.message : "unknown error"})`);
  process.exitCode = 2;
}
