import assert from "node:assert/strict";
import test from "node:test";
import {
  collectVisibleStrings,
  findBundleDisplayLanguageRisks,
  findClientTextSinkRisks,
  findComponentMatrixIsolationRisks,
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
  isBundleUiConfig,
  isClientSurfaceSource,
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

test("自定义展示组件覆盖眉标、指标元数据与可见 value，表单 value 保持机器值语义", () => {
  const risky = `
    export function Page({ row }) {
      return <><PageHead tag="P19 · REVENUE" subtitle="经营分析" />
        <MetricCard period="CURRENT PERIOD" source="revenue_api" updatedAt="batchId" value={row.workspaceId} />
        <Input value={row.workspaceId} /><input value={row.workspaceId} /></>;
    }
  `;
  const visible = findVisibleLanguageRisks(risky);
  assert.ok(visible.some((item) => item.text.includes("P19")));
  assert.ok(visible.some((item) => item.text.includes("CURRENT PERIOD")));
  assert.ok(visible.some((item) => item.text.includes("revenue_api")));
  const dynamic = findRawDynamicValueRisks(risky);
  assert.equal(dynamic.filter((item) => item.text === "row.workspaceId").length, 1);

  const objectFields = `const projection = { source: "base", period: "rolling_30d", updatedAt: "batch_id" };`;
  assert.deepEqual(findVisibleLanguageRisks(objectFields), []);
  assert.deepEqual(findRawDynamicValueRisks(objectFields), []);
});

test("AST 文字出口覆盖错误对象、通知、Toast、语音、字幕与动态可访问属性", () => {
  const source = `
    export function Page({ job, error, response, query }) {
      document.title = \`工单 · \${job.workspace_id}\`;
      setToast(\`保存失败：\${error.message}\`);
      toast(response.detail);
      new Notification("同步失败", { body: response.detail });
      VoiceEngine.speak({ text: error.message });
      setSubtitle(query.error.message);
      return <><p>{\`保存失败：\${job.workspace_id}\`}</p><Alert description={error.message} />
        <img aria-label={response.detail} title={error.message} alt={query.error.message} /></>;
    }
  `;
  const risks = [...findRawDynamicValueRisks(source), ...findClientTextSinkRisks(source)];
  assert.ok(risks.some((item) => item.text.includes("workspace_id")));
  assert.ok(risks.some((item) => item.text.includes("error.message")));
  assert.ok(risks.some((item) => item.text.includes("response.detail")));
  assert.ok(risks.some((item) => item.text.includes("query.error.message")));

  const safe = `
    document.title = clientChineseText(response.detail, "工单");
    setToast(operationFailure(error, "保存"));
    new Notification("同步失败", { body: clientChineseText(response.detail, "请稍后重试") });
    VoiceEngine.speak({ text: clientChineseText(error.message, "服务暂时不可用") });
    const page = <Alert description={clientChineseText(response.detail, "详情待确认")} />;
  `;
  assert.deepEqual(findRawDynamicValueRisks(safe), []);
  assert.deepEqual(findClientTextSinkRisks(safe), []);
});

test("显式安全映射白名单不能被大写字典、限定名或回调包装绕过", () => {
  const source = `<><p>{ANY[response.detail]}</p><p>{evil.clientChineseText(error.message)}</p>
    <p>{items.map((item) => item.error.message).join("、")}</p><Toast message={query.error.message} /></>`;
  const risks = findRawDynamicValueRisks(source);
  assert.ok(risks.some((item) => item.text.includes("ANY[response.detail]")));
  assert.ok(risks.some((item) => item.text.includes("evil.clientChineseText")));
  assert.ok(risks.some((item) => item.text.includes("items.map")));
  assert.ok(risks.some((item) => item.text.includes("query.error.message")));
});

test("文件发现覆盖四类脚本、三端、共享 UI 与 dev，并排除测试和构建产物", () => {
  for (const file of [
    "apps/web/src/Page.ts", "apps/webb/src/Page.tsx", "apps/webc/src/Page.js",
    "packages/ui/src/Page.jsx", "apps/web/src/pages/dev/DevMatrix.tsx",
  ]) assert.equal(isClientSurfaceSource(file), true, file);
  for (const file of [
    "apps/web/src/Page.test.tsx", "apps/web/src/Page.spec.js", "apps/web/src/__tests__/Page.tsx",
    "packages/ui/dist/index.js", "packages/ui/src/index.d.ts", "apps/server/src/router.ts",
  ]) assert.equal(isClientSurfaceSource(file), false, file);
});

test("Bundle 客户端配置只检查可见字段并拒绝混合机器字段", () => {
  assert.equal(isBundleUiConfig("bundles/demo/service-front/client.json"), true);
  assert.equal(isBundleUiConfig("bundles/demo/floor-scene.json"), true);
  assert.equal(isBundleUiConfig("bundles/demo/bundle.json"), false);
  const risky = JSON.stringify({ serviceKind: "feedback", id: "raw_id", label: "保存失败 workspace_id" });
  const risks = findBundleDisplayLanguageRisks(risky, "bundles/demo/service-front/client.json");
  assert.equal(risks.some((item) => item.path === "$.label"), true);
  assert.deepEqual(findBundleDisplayLanguageRisks(JSON.stringify({ serviceKind: "feedback", id: "raw_id", label: "提交反馈" })), []);
  assert.equal(findBundleDisplayLanguageRisks("{", "bundle.json")[0]?.rule, "Bundle 客户端配置必须是有效 JSON");
});

test("P25 与组件矩阵豁免仅限真实标记子树及只在其中引用的组件", () => {
  const p25 = `
    function OnlyHere(){ return <p>YAML CLI args</p> }
    function Shared(){ return <p>workspace_id</p> }
    export function P25(){ return <><div data-wl-authorized-diagnostics="ai-pm.development"><OnlyHere/><Shared/></div><Shared/><p>{error.message}</p></> }
  `;
  const p25Risks = [...findVisibleLanguageRisks(p25, "apps/web/src/extensions/ai-pm/P25.tsx"), ...findRawDynamicValueRisks(p25, "apps/web/src/extensions/ai-pm/P25.tsx")];
  assert.ok(p25Risks.some((item) => item.text.includes("workspace_id")));
  assert.ok(p25Risks.some((item) => item.text.includes("error.message")));
  const matrix = `<div data-wl-authorized-diagnostics="ui-component-matrix"><p>仅限本地开发环境并显式开启诊断开关后使用</p><p>DEV MATRIX</p></div>`;
  const app = `const enabled = import.meta.env.DEV && import.meta.env.VITE_ENABLE_UI_DIAGNOSTICS === "true";
    function UiDiagnosticsRoute(){ return enabled ? <Bridge><DevMatrix /></Bridge> : <NotFound /> }
    <Route path="/dev" element={<UiDiagnosticsRoute />} />`;
  assert.deepEqual(findComponentMatrixIsolationRisks(matrix, app, "VITE_ENABLE_UI_DIAGNOSTICS=true"), []);
  assert.ok(findComponentMatrixIsolationRisks(`/* data-wl-authorized-diagnostics="ui-component-matrix" */<div />`, app).length >= 2);
});

test("开发诊断页面必须具备权限、显式开发开关、醒目标识和审计说明", () => {
  const page = `<div data-wl-authorized-diagnostics="ai-pm.development"><strong>授权开发诊断</strong><span>仅限已获开发权限的管理员；操作写入开发事件、围栏审计与版本台账</span><p>YAML CLI args</p></div>`;
  const app = `const enabled = import.meta.env.DEV && import.meta.env.VITE_ENABLE_UI_DIAGNOSTICS === "true"; <Route path="/dev" element={<UiDiagnosticsRoute />} />`;
  const route = `export const industryRoutes = [{ path: "/development", legacyPaths: ["/p25"], capabilityId: "ai-pm.development", element: <P25 /> }];`;
  assert.deepEqual(findDiagnosticIsolationRisks(page, app, "VITE_ENABLE_UI_DIAGNOSTICS=true", route), []);
  assert.deepEqual(findVisibleLanguageRisks(page, "apps/web/src/extensions/ai-pm/P25.tsx"), []);
  assert.ok(findVisibleLanguageRisks("<p>YAML CLI args</p>", "apps/web/src/pages/Home.tsx").length >= 1);
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
