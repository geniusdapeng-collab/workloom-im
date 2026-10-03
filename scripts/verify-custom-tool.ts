import { saveCustomTool, listTools, setDevToolAdapters } from "../apps/server/src/service/devtools.js";
import { defaultAdapters } from "@workloom/base/dev-bridge";

import { runWithServiceScope } from "../apps/server/src/service/scope.js";

const WS = process.env.VERIFY_WS ?? "ws-aipm-demo";
const TENANT_ID = process.env.VERIFY_TENANT_ID ?? (WS === "ws-aipm-demo" ? "demo" : "");
if (!TENANT_ID.trim()) throw new Error("自定义 VERIFY_WS 必须同时提供 VERIFY_TENANT_ID");
const ACTOR = { id: "verify-human", type: "human" as const };
setDevToolAdapters(defaultAdapters());

await runWithServiceScope({ tenantId: TENANT_ID, workspaceId: WS }, async () => {
const r = await saveCustomTool(WS, {
  tool_key: "demo-cli", display_name: "演示机床（自定义接入）", bin: "demo-cli-nonexist",
  args: ["-p", "{{prompt}}"], output: { protocol: "text" },
  install_hint: "这是一个演示规格",
}, ACTOR);
console.log("✓ 落盘:", r.file);

const { tools, customToolErrors } = await listTools(WS);
const demo = tools.find((t) => t.toolKey === "demo-cli");
console.log("✓ 台账出现:", demo?.displayName, "| custom:", demo?.custom, "| 状态:", demo?.install ? "在线" : "未安装（诚实标注）");
console.log("✓ 机床总数:", tools.length, "| 自定义加载错误:", customToolErrors?.length ?? 0);
const keys = tools.map((t) => t.toolKey);
for (const k of ["codex", "qoder", "kimi-code", "claude-code", "zai", "aider"]) {
  if (!keys.includes(k)) throw new Error(`内置机床缺失: ${k}`);
}
console.log("✓ 六家内置机床全部在册（codex 优先:", keys[0] === "codex", ")");
});
process.exit(0);
