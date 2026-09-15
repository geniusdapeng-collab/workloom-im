import assert from "node:assert/strict";
import test from "node:test";
import {
  collectVisibleStrings,
  findContentSafetyRisks,
  findDiagnosticIsolationRisks,
  findEntryStyleRisks,
  findIconAccessibilityRisks,
  findSharedIconRisks,
  findStylesheetLayoutRisks,
  findTypographyRisks,
  findViewportRisks,
  findRawDynamicValueRisks,
  findVisibleLanguageRisks,
} from "./ui-governance-rules.mjs";

test("viewport 门禁允许正常缩放并拒绝锁定缩放", () => {
  assert.deepEqual(findViewportRisks('<meta name="viewport" content="width=device-width, initial-scale=1">'), []);
  assert.equal(findViewportRisks('<meta name="viewport" content="width=device-width,user-scalable=no">').length, 1);
  assert.equal(findViewportRisks('<meta name="viewport" content="maximum-scale=1.0">').length, 1);
});

test("普通界面拦截常见底层字段，产品缩写使用窄白名单", () => {
  const risky = `<><p>latencyMs / input_tokens / args</p><div title="workspaceId missing">失败</div></>`;
  assert.equal(findVisibleLanguageRisks(risky).length >= 2, true);
  const allowed = `<><p>WorkLoom AI 服务支持 API、H5、OAuth 与 SLA</p><p>请上传 xlsx、csv、docx、FAQ 或 SOP</p></>`;
  assert.deepEqual(findVisibleLanguageRisks(allowed), []);
});

test("可见文本扫描不把 JSX 三元渲染条件当成页面文案", () => {
  const source = `<Resource>{(events) => modelsOnly ? <div>模型路由</div> : <div>事件账本</div>}</Resource>`;
  assert.deepEqual(findVisibleLanguageRisks(source), []);
});

test("AST 仅拦截真正输出的原始动态字段，不误伤条件、键值或已格式化值", () => {
  const source = `
    const rows = items.filter((item) => item.status === "active");
    export function Page({ ticket }) {
      return <>
        <div key={ticket.id} className={ticket.status === "active" ? "on" : "off"}>
          <span>{ticket.id}</span>
          <span>{ticket.status}</span>
          <span>{clientIdentifierText(ticket.requestId)}</span>
          <span>{clientStatusLabel(ticket.status)}</span>
        </div>
      </>;
    }
  `;
  const risks = findRawDynamicValueRisks(source);
  assert.equal(risks.length, 2);
  assert.equal(risks.some((item) => item.text === "ticket.id"), true);
  assert.equal(risks.some((item) => item.text === "ticket.status"), true);
});

test("动态值门禁拦截 JSX 文本与可见属性中的裸底层字段", () => {
  const source = `
    export function Identity({ workspaceId, eventId }) {
      return <><span>{workspaceId}</span><button title={eventId}>查看</button></>;
    }
  `;
  const risks = findRawDynamicValueRisks(source);
  assert.equal(risks.length, 2);
  assert.equal(risks.some((item) => item.text === "workspaceId"), true);
  assert.equal(risks.some((item) => item.text === "eventId"), true);
});

test("开发诊断页面必须具备权限、显式开发开关、醒目标识和审计说明", () => {
  const page = `<div data-wl-authorized-diagnostics="ai-pm.development"><strong>授权开发诊断</strong><span>仅限已获开发权限的管理员；操作写入开发事件、围栏审计与版本台账</span><p>YAML CLI args</p></div>`;
  const app = `const enabled = import.meta.env.DEV && import.meta.env.VITE_ENABLE_UI_DIAGNOSTICS === "true"; <NavigationCapabilityBoundary capabilityId="ai-pm.development"><P25 /></NavigationCapabilityBoundary>; <Route path="/dev" element={<UiDiagnosticsRoute />} />`;
  assert.deepEqual(findDiagnosticIsolationRisks(page, app, "VITE_ENABLE_UI_DIAGNOSTICS=true"), []);
  assert.deepEqual(findVisibleLanguageRisks(page, "apps/web/src/pages/p25/P25.tsx"), []);
  assert.equal(findVisibleLanguageRisks("<p>YAML CLI args</p>", "apps/web/src/pages/Home.tsx").length, 1);
  assert.ok(findDiagnosticIsolationRisks("<div>YAML</div>", '<Route path="/dev" element={<DevMatrix />} />').length >= 5);
});

test("三端入口必须同时接入令牌、内容安全与基础组件样式", () => {
  const good = ["tokens.css", "content-safety.css", "components.css"]
    .map((name) => `import \"@workloom/ui/${name}\";`).join("\n");
  assert.deepEqual(findEntryStyleRisks(good), []);
  assert.deepEqual(findEntryStyleRisks('import "@workloom/ui/tokens.css";'), [
    "缺少共享样式 content-safety.css",
    "缺少共享样式 components.css",
  ]);
});

test("可见文本扫描忽略注释与类型，但拦截工程代号、原始字段与裸 JSON", () => {
  const source = `
    // P6 与 fence_bindings 只属于工程注释
    interface Row { fence_bindings: string[] }
    const internal = "P7";
    export function Page({ row }: { row: Row }) {
      setError("preset_key 读取失败");
      const message = { text: row.hint ?? "请按 M4 处理" };
      return <><p>请按 F8.3 处理</p><span>{row.label ?? "按 D6 处理"}</span><code>{JSON.stringify(row)}</code></>;
    }
  `;
  const visible = collectVisibleStrings(source, "fixture.tsx").map((item) => item.text);
  assert.equal(visible.includes("P7"), false);
  const risks = findVisibleLanguageRisks(source, "fixture.tsx");
  assert.equal(risks.some((item) => item.rule.includes("工程代号")), true);
  assert.equal(risks.filter((item) => item.rule.includes("工程代号")).length >= 3, true);
  assert.equal(risks.some((item) => item.text.includes("preset_key")), true);
  assert.equal(risks.some((item) => item.rule.includes("裸 JSON")), true);
});

test("内容安全契约覆盖按钮、动态文本、操作组和等宽内容", () => {
  const safe = `
    button { min-inline-size: 0; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
    pre { white-space: pre-wrap; }
    .wl-action-row { display: flex; }
  `;
  assert.deepEqual(findContentSafetyRisks(safe, "code { white-space: pre-wrap; }"), []);
  assert.ok(findContentSafetyRisks("button { white-space: nowrap; }", "").length >= 4);
  assert.equal(findContentSafetyRisks(safe, "code, .font-mono { white-space: nowrap; }").length, 1);
});

test("字号门禁拦截任意小字号与小号交互，仅允许显式标记的辅助元数据", () => {
  const risky = `
    <p className="text-[13px]">正文</p>
    <button className="text-caption">继续</button>
    <span className="truncate text-caption">动态标题</span>
    <span style={{ fontSize: 12 }}>辅助说明</span>
    <span style={{ fontSize: important ? 16 : 12, whiteSpace: "nowrap" }}>很长的动态内容</span>
  `;
  const risks = findTypographyRisks(risky);
  assert.equal(risks.some((item) => item.rule.includes("任意字号")), true);
  assert.equal(risks.some((item) => item.rule.includes("交互控件")), true);
  assert.equal(risks.some((item) => item.rule.includes("直接换行")), true);
  assert.equal(risks.some((item) => item.rule.includes("内联样式")), true);
  assert.equal(risks.some((item) => item.rule.includes("强制单行")), true);
  assert.equal(findTypographyRisks('<span className="text-caption">更新时间</span>').length, 1);
  assert.deepEqual(findTypographyRisks('<span data-wl-meta className="text-caption">更新时间</span>'), []);
  assert.equal(findTypographyRisks('<button data-wl-meta className="text-caption">继续</button>').length, 1);
  assert.deepEqual(findTypographyRisks('<button className="text-body">继续</button>'), []);
  assert.deepEqual(findTypographyRisks('<span data-wl-meta title="完整标题" className="truncate text-caption">短标题</span>'), []);
  assert.deepEqual(findTypographyRisks(`<span
    data-wl-meta
    className="truncate text-caption"
    title={fullTitle}
  >短标题</span>`), []);
});

test("客户端样式门禁拒绝小字号、固定根宽度与强制单行", () => {
  const risky = `
    body { min-width: 320px; }
    button { font-size: .75rem; white-space: nowrap; }
  `;
  const risks = findStylesheetLayoutRisks(risky);
  assert.equal(risks.some((item) => item.rule.includes("字号")), true);
  assert.equal(risks.some((item) => item.rule.includes("最小宽度")), true);
  assert.equal(risks.some((item) => item.rule.includes("强制单行")), true);
  assert.deepEqual(findStylesheetLayoutRisks("body { min-width: 0; } button { font-size: var(--wl-text-body); }"), []);
});

test("纯图标与纯表情按钮必须有可访问名称", () => {
  assert.equal(findIconAccessibilityRisks("<button>✕</button>").length, 1);
  assert.equal(findIconAccessibilityRisks("<button><Icon name=\"close\" /></button>").length, 1);
  assert.equal(findIconAccessibilityRisks('<button aria-label="关闭"><Icon name="close" /></button>').length, 1);
  assert.equal(findIconAccessibilityRisks('<button aria-label="Close" title="Close"><Icon name="close" /></button>').length, 1);
  assert.deepEqual(findIconAccessibilityRisks('<button aria-label="关闭" title="关闭"><Icon name="close" /></button>'), []);
  assert.equal(findIconAccessibilityRisks('<IconButton icon="close" label="Close" />').length, 1);
  assert.deepEqual(findIconAccessibilityRisks('<IconButton icon="close" label="关闭详情" />'), []);
  assert.deepEqual(findIconAccessibilityRisks("<button>✕ 驳回</button>"), []);
});

test("三端功能图标必须来自共享注册表，特殊图形逐项登记并声明辅助技术语义", () => {
  assert.equal(findSharedIconRisks('<svg><path d="M0 0" /></svg>', "apps/webc/src/Card.tsx").length, 2);
  assert.equal(findSharedIconRisks('<p>⚠ 失败</p>', "apps/web/src/Page.tsx").length, 1);
  assert.deepEqual(findSharedIconRisks('<Icon name="warning" /><span>失败</span>', "apps/web/src/Page.tsx"), []);
  assert.deepEqual(findSharedIconRisks(
    '<svg data-wl-custom-graphic="generated-qr-code" role="img" aria-label="服务二维码"><path d="M0 0" /></svg>',
    "apps/web/src/components/UrlQrCode.tsx",
  ), []);
  assert.equal(findSharedIconRisks(
    '<svg data-wl-custom-graphic="generated-qr-code"><path d="M0 0" /></svg>',
    "apps/web/src/components/UrlQrCode.tsx",
  ).length, 1);
  assert.equal(findSharedIconRisks(
    '<svg data-wl-custom-graphic="generated-qr-code" role="img" aria-label="服务二维码"><path d="M0 0" /></svg>',
    "apps/webc/src/components/UrlQrCode.tsx",
  ).length, 2);
  const avatar = '<g data-wl-custom-graphic-part="agent-avatar"><path d="M0 0" /></g><path d="M1 1" /><svg data-wl-custom-graphic="agent-avatar" role="img" aria-label="数字员工"></svg>';
  const avatarRisks = findSharedIconRisks(avatar, "apps/web/src/components/AgentAvatar.tsx");
  assert.equal(avatarRisks.length, 1);
  assert.equal(avatarRisks[0]?.text, "path");
});
