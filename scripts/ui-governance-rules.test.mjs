import assert from "node:assert/strict";
import test from "node:test";
import {
  collectVisibleStrings,
  findBannerAlertContractRisks,
  findBundleDisplayLanguageRisks,
  findClientTextSinkRisks,
  findComponentMatrixIsolationRisks,
  findContentSafetyRisks,
  findDiagnosticIsolationRisks,
  findEntryStyleRisks,
  findHtmlVisibleLanguageRisks,
  findIndustryConfigDisplayRisks,
  findIndustryConfigImports,
  findIndustryEmbeddedUiReferences,
  findIndustryEmbeddedUiRisks,
  findIndustryHtmlResourceReferences,
  findIconAccessibilityRisks,
  findSharedIconRisks,
  findStylesheetLayoutRisks,
  findStylesheetGeneratedContentRisks,
  findStylesheetSurfaceRisks,
  findStylesheetImports,
  findTypographyRisks,
  findViewportRisks,
  findRawDynamicValueRisks,
  findServiceWorkerRegistrations,
  findUnmanagedSurfaceRisks,
  findSurfaceModuleFacts,
  findWorkerScriptImports,
  findPcExtensionNavigationRisks,
  findVisibleLanguageRisks,
  isBundleUiConfig,
  isClientPublicHtml,
  isClientWebManifest,
  isPcIndustryNavigationSource,
  findClientWebManifestRisks,
  isClientSurfaceSource,
  isIndustryExtensionStylesheet,
  isIndustryUiConfig,
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

test("共享组件的可见后缀属性与表格展示字段不能绕过中文映射", () => {
  const source = `<><Input error="tenant_id console"/><Button busyLabel="raw_status">保存</Button>
    <ConfirmDialog confirmLabel={response.detail}/><Table columns={[{
      header: "workspace_id console", mobileLabel: "raw_status", sortLabel: response.message,
      displayValue: response.detail, valueText: "tenant_id console"
    }]}/></>`;
  const literalRisks = findVisibleLanguageRisks(source);
  const dynamicRisks = findRawDynamicValueRisks(source);
  for (const value of ["tenant_id console", "raw_status", "workspace_id console"]) {
    assert.ok(literalRisks.some((item) => item.text.includes(value)), `未拦截 ${value}`);
  }
  assert.ok(dynamicRisks.some((item) => item.text.includes("response.detail")));
  assert.ok(dynamicRisks.some((item) => item.text.includes("response.message")));
  assert.deepEqual(findVisibleLanguageRisks('<Input value="tenant_id" aria-valuetext="已选择"/>'), []);
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

test("JSX 外文字出口覆盖浏览器对话、系统分享、语音、画布与 DOM 注入", () => {
  const source = `
    alert(response.detail);
    navigator.share({ title: response.detail, text: error.message });
    new SpeechSynthesisUtterance(error.message);
    ctx.strokeText(response.detail, 0, 0);
    node.ariaDescription = response.detail;
    node.insertAdjacentText("beforeend", response.detail);
    node.innerHTML = response.detail;
    node["innerHTML"] += response.detail;
    node[\`outerHTML\`] = response.detail;
    node["ariaLabel"] = response.detail;
    node.insertAdjacentHTML("beforeend", "<b>raw_field</b>");
    const view = <div dangerouslySetInnerHTML={{ __html: response.detail }} />;
  `;
  const risks = findClientTextSinkRisks(source);
  assert.ok(risks.some((item) => item.text.includes("response.detail")));
  assert.ok(risks.some((item) => item.text.includes("error.message")));
  assert.ok(risks.filter((item) => item.rule.includes("innerHTML/outerHTML")).length >= 3);
  assert.ok(risks.some((item) => item.rule.includes("dangerouslySetInnerHTML")));
  assert.ok(risks.some((item) => item.rule.includes("HTML 字符串")));
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
    "packages/ui/src/Page.jsx", "apps/web/src/pages/dev/DevMatrix.tsx", "apps/webb/public/sw.js",
    "apps/webc/public/firebase-messaging-sw.js", "apps/web/public/push/service-worker.js",
  ]) assert.equal(isClientSurfaceSource(file), true, file);
  for (const file of [
    "apps/web/src/Page.test.tsx", "apps/web/src/Page.spec.js", "apps/web/src/__tests__/Page.tsx",
    "packages/ui/dist/index.js", "packages/ui/src/index.d.ts", "apps/server/src/router.ts",
  ]) assert.equal(isClientSurfaceSource(file), false, file);
});

test("HTML 外壳、安装清单与行业 public 配置不能绕过中文边界", () => {
  assert.deepEqual(findHtmlVisibleLanguageRisks('<html lang="zh-CN"><head><title>WorkLoom 工作台</title></head><body><noscript>请启用浏览器脚本</noscript></body></html>'), []);
  assert.ok(findHtmlVisibleLanguageRisks('<html><head><title>raw_field console</title></head></html>').length >= 2);
  const htmlRisks = findHtmlVisibleLanguageRisks(`<html lang=zh-CN><head>
    <meta content="tenant_id console" name="description"><meta content=raw_status property=og:title>
    </head><body><div>workspace_id console</div><input type=hidden value=tenant_id><input value="raw_field console"></body></html>`);
  assert.ok(htmlRisks.some((item) => item.text.includes("tenant_id console") && item.rule.includes("英文底层字段")));
  assert.ok(htmlRisks.some((item) => item.text.includes("raw_status") && item.rule.includes("英文底层字段")));
  assert.ok(htmlRisks.some((item) => item.text.includes("workspace_id console") && item.rule.includes("英文底层字段")));
  assert.ok(htmlRisks.some((item) => item.text.includes("raw_field console") && item.rule.includes("英文底层字段")));
  assert.equal(htmlRisks.some((item) => item.text === "tenant_id"), false);
  const encoded = findHtmlVisibleLanguageRisks('<html lang=zh-CN><body><div>&#116;&#101;&#110;&#97;&#110;&#116;&#95;&#105;&#100;</div><option label="raw_status">正常</option></body></html>');
  assert.ok(encoded.some((item) => item.text === "tenant_id"));
  assert.ok(encoded.some((item) => item.text === "raw_status"));
  assert.equal(isClientWebManifest("apps/webb/public/manifest.webmanifest"), true);
  assert.equal(isClientWebManifest("apps/web/public/manifest.json"), true);
  assert.equal(isClientWebManifest("apps/webc/public/install/app.webmanifest"), true);
  assert.equal(isClientWebManifest("apps/webc/public/install/site.webmanifest"), true);
  assert.equal(isClientPublicHtml("apps/web/public/offline.html"), true);
  assert.deepEqual(findClientWebManifestRisks('{"name":"WorkLoom 移动工作台","short_name":"WorkLoom","description":"经营工作台","lang":"zh-CN"}'), []);
  assert.ok(findClientWebManifestRisks('{"name":"tenant_id console","lang":"en"}').length >= 2);
  assert.equal(isBundleUiConfig("apps/web/public/industry/custom-dashboard.json"), true);
  assert.equal(isBundleUiConfig("apps/web/public/live2d/model.json"), false);
});

test("Service Worker 注册使用 AST，覆盖元素访问和不可变别名但忽略注释、字符串与普通 Worker", () => {
  assert.deepEqual(findServiceWorkerRegistrations('navigator.serviceWorker.register("./push-worker.js")'), [
    { line: 1, path: "./push-worker.js", text: "./push-worker.js", rule: "" },
  ]);
  assert.deepEqual(findServiceWorkerRegistrations(`
    const nav = window["navigator"];
    const { serviceWorker: sw } = nav;
    const registerWorker = sw["register"].bind(sw);
    registerWorker("./aliased-worker.mjs");
  `), [{ line: 5, path: "./aliased-worker.mjs", text: "./aliased-worker.mjs", rule: "" }]);
  assert.deepEqual(findServiceWorkerRegistrations(
    'navigator["service" + "Worker"]["reg" + "ister"]("/hidden-" + "worker.js")',
  ), [{ line: 1, path: "/hidden-worker.js", text: "/hidden-worker.js", rule: "" }]);
  assert.deepEqual(findServiceWorkerRegistrations([
    'navigator.serviceWorker.register.call(navigator.serviceWorker, "/call-worker.js");',
    'navigator.serviceWorker.register.apply(navigator.serviceWorker, ["/apply-worker.js"]);',
    'Reflect.apply(navigator.serviceWorker.register, navigator.serviceWorker, ["/reflect-worker.js"]);',
  ].join("\n")).map((item) => item.path), ["/call-worker.js", "/apply-worker.js", "/reflect-worker.js"]);
  assert.ok(findServiceWorkerRegistrations(
    "navigator.serviceWorker.register.apply(navigator.serviceWorker, workerArgs)",
  )[0]?.rule.includes("静态展开"));
  assert.deepEqual(findServiceWorkerRegistrations(`
    // navigator.serviceWorker.register("./comment-worker.js");
    const example = 'navigator["serviceWorker"]["register"]("./string-worker.js")';
    new Worker("./ordinary-worker.js");
  `), []);
  assert.deepEqual(findServiceWorkerRegistrations(`<!doctype html><html><body>
    <!-- <script>navigator.serviceWorker.register("./comment-worker.js")</script> -->
    <script type="application/json">{"example":"navigator.serviceWorker.register('./json-worker.js')"}</script>
    <script type="module">navigator["serviceWorker"].register("./html-worker.mjs")</script>
  </body></html>`, "apps/web/index.html"), [
    { line: 4, path: "./html-worker.mjs", text: "./html-worker.mjs", rule: "" },
  ]);
  assert.ok(findServiceWorkerRegistrations("navigator.serviceWorker.register(workerPath)")[0]?.rule.includes("静态本地路径"));
  assert.ok(findServiceWorkerRegistrations("navigator.serviceWorker[method](workerPath)")[0]?.rule.includes("静态名称"));
  assert.ok(findServiceWorkerRegistrations("navigator[serviceWorkerKey][registerKey]('/hidden.js')")[0]?.rule.includes("静态名称"));
});

test("已注册 Worker 的经典与模块依赖递归规则关闭动态、外部和裸说明符", () => {
  assert.equal(findWorkerScriptImports('importScripts("./a.js", "./b.js")').length, 2);
  assert.deepEqual(findWorkerScriptImports(`
    import "./module-a.js";
    export { copy } from "../module-b.mjs";
    export * from "/module-c.js";
  `).map((item) => item.path), ["./module-a.js", "../module-b.mjs", "/module-c.js"]);
  assert.deepEqual(findWorkerScriptImports(`
    const { importScripts: loadScripts } = self;
    loadScripts("./classic-a.js");
    new Worker("./ordinary-worker.js");
  `).map((item) => item.path), ["./classic-a.js"]);
  assert.deepEqual(findWorkerScriptImports('self["import" + "Scripts"]("./un" + "scanned.js")'), [
    { line: 1, path: "./unscanned.js", text: "./unscanned.js", rule: "" },
  ]);
  assert.deepEqual(findWorkerScriptImports([
    'self.importScripts.call(self, "./call.js");',
    'self.importScripts.apply(self, ["./apply.js"]);',
    'Reflect.apply(self.importScripts, self, ["./reflect.js"]);',
  ].join("\n")).map((item) => item.path), ["./call.js", "./apply.js", "./reflect.js"]);
  assert.ok(findWorkerScriptImports("self.importScripts.apply(self, workerArgs)")[0]?.rule.includes("静态展开"));
  assert.ok(findWorkerScriptImports("importScripts(workerPath)")[0]?.rule.includes("静态本地路径"));
  assert.ok(findWorkerScriptImports("self[importScriptsKey]('./hidden.js')")[0]?.rule.includes("静态名称"));
  assert.ok(findWorkerScriptImports('import("./dynamic.js")')[0]?.rule.includes("禁止动态 import"));
  assert.ok(findWorkerScriptImports('import "https://cdn.example/remote.js"')[0]?.rule.includes("外部或裸模块"));
  assert.ok(findWorkerScriptImports('export * from "worker-package"')[0]?.rule.includes("外部或裸模块"));
  assert.deepEqual(findWorkerScriptImports(`
    // importScripts("./comment-copy.js");
    const sample = 'import "./string-copy.js"';
  `), []);
});

test("CSS 伪元素仅允许空装饰或受治理的中文展示属性", () => {
  assert.deepEqual(findStylesheetGeneratedContentRisks('.ok::before{content:""}.cell::before{content:attr(data-label)}'), []);
  const risks = findStylesheetGeneratedContentRisks('.raw::before{content:attr(data-status)}.hint::after{content:"tenant_id"}.variable::after{content:var(--raw-status)}');
  assert.ok(risks.some((item) => item.text.includes("data-status")));
  assert.ok(risks.some((item) => item.text.includes("tenant_id")));
  assert.ok(risks.some((item) => item.text.includes("--raw-status") && item.rule.includes("变量注入")));
});

test("无 role、自建包装、class 与 style 浮面都必须接入共享受管表面", () => {
  assert.equal(findUnmanagedSurfaceRisks('<div role="dialog" aria-modal="true">内容</div>').length, 1);
  assert.equal(findUnmanagedSurfaceRisks('<div {...drawerSurface} role="dialog">内容</div>').length, 1);
  assert.equal(findUnmanagedSurfaceRisks('<div data-wl-managed-surface="drawer" role="dialog">内容</div>').length, 1);
  const appManaged = `import { useManagedSurface as useSurface } from "@workloom/ui";
    const drawerBindings = useSurface({ open, kind: "drawer", onDismiss });
    export function View(){ return <div {...drawerBindings} role="dialog">内容</div>; }`;
  assert.deepEqual(findUnmanagedSurfaceRisks(appManaged, "apps/web/src/View.tsx"), []);
  const sharedManaged = `import { useManagedSurface } from "./managed-surface";
    const surface = useManagedSurface({ open, kind: "dialog", onDismiss });
    export function Dialog(){ return <div {...surface} role="dialog">内容</div>; }`;
  assert.deepEqual(findUnmanagedSurfaceRisks(sharedManaged, "packages/ui/src/Dialog.tsx"), []);
  const forged = `const useManagedSurface = () => ({ }); const modalSurface = useManagedSurface();
    export function View(){ return <div {...modalSurface} data-wl-managed-surface="dialog" role="dialog">内容</div>; }`;
  assert.equal(findUnmanagedSurfaceRisks(forged, "apps/web/src/View.tsx").length, 1);
  const shadowed = `import { useManagedSurface } from "@workloom/ui";
    function View(useManagedSurface){ const surface = useManagedSurface(); return <div {...surface} role="dialog">内容</div>; }`;
  assert.equal(findUnmanagedSurfaceRisks(shadowed, "apps/web/src/View.tsx").length, 1);
  const localImposter = `import { useManagedSurface } from "./managed-surface";
    const surface = useManagedSurface(); export function View(){ return <div {...surface} role="dialog">内容</div>; }`;
  assert.equal(findUnmanagedSurfaceRisks(localImposter, "apps/web/src/View.tsx").length, 1);
  assert.equal(findUnmanagedSurfaceRisks('<Dialog open title="确认" />').length, 1);
  assert.equal(findUnmanagedSurfaceRisks('export function HotelModal(){ return <div>确认内容</div>; }').length, 1);
  assert.equal(findUnmanagedSurfaceRisks('import { HotelModal } from "third-party-ui"; export const View=()=> <HotelModal />;').length, 1);
  assert.equal(findUnmanagedSurfaceRisks('<div className="fixed inset-0 z-50">确认内容</div>').length, 1);
  assert.equal(findUnmanagedSurfaceRisks('<div className={cn("fixed inset-[0]", open && "z-[999]")}>确认内容</div>').length, 1);
  assert.equal(findUnmanagedSurfaceRisks('<section style={{ position: "fixed", inset: 0, zIndex: 999 }}>确认内容</section>').length, 1);
  assert.equal(findUnmanagedSurfaceRisks('<dialog>确认内容</dialog>').length, 1);
  assert.equal(findUnmanagedSurfaceRisks('<div aria-modal={true}>确认内容</div>').length, 1);
  assert.equal(findUnmanagedSurfaceRisks('<div popover="manual">选择内容</div>').length, 1);
  assert.deepEqual(findUnmanagedSurfaceRisks('<header className="fixed top-0 z-50">页头</header>'), []);
  assert.deepEqual(findUnmanagedSurfaceRisks('<div aria-live="polite" className="pointer-events-none fixed bottom-0 z-50">字幕</div>'), []);
  const imported = `import { Dialog as HotelDialog } from "@workloom/ui";
    export const View=()=> <HotelDialog open title="确认" />;`;
  assert.deepEqual(findUnmanagedSurfaceRisks(imported, "apps/web/src/View.tsx"), []);
  const fakeSharedExport = `import { HotelModal } from "@workloom/ui";
    export const View=()=> <HotelModal open title="确认" />;`;
  assert.equal(findUnmanagedSurfaceRisks(fakeSharedExport, "apps/web/src/View.tsx").length, 1);
  const shadowedDialog = `import { Dialog } from "@workloom/ui";
    export function View(Dialog){ return <Dialog open title="确认" />; }`;
  assert.ok(findUnmanagedSurfaceRisks(shadowedDialog, "apps/web/src/View.tsx").length >= 1);
  const composed = `import { Dialog as BaseDialog } from "@workloom/ui";
    export function HotelDialog(props){ return <BaseDialog {...props} />; }
    export const View=()=> <HotelDialog open title="确认" />;`;
  assert.deepEqual(findUnmanagedSurfaceRisks(composed, "apps/web/src/View.tsx"), []);
  const managedOverlay = `import { useManagedSurface } from "@workloom/ui";
    const surface=useManagedSurface({ open, kind:"drawer", onDismiss });
    export const View=()=> <div {...surface} className="fixed inset-0 z-50">内容</div>;`;
  assert.deepEqual(findUnmanagedSurfaceRisks(managedOverlay, "apps/web/src/View.tsx"), []);
});

test("跨文件 surface 只放行可证明直接委托共享表面的精确导出", () => {
  const thirdPartyReExport = 'export { HotelDialog } from "third-party-ui";';
  assert.equal(findUnmanagedSurfaceRisks(thirdPartyReExport, "apps/web/src/config/industry/barrel.ts").length, 1);
  const unknownRelative = 'import { HotelDialog } from "./barrel"; export const View=()=> <HotelDialog />;';
  assert.equal(findUnmanagedSurfaceRisks(unknownRelative, "apps/web/src/config/industry/View.tsx").length, 1);
  const variableAlias = 'import { ThirdPartyModal } from "third-party-ui"; export const HotelDialog = ThirdPartyModal;';
  assert.equal(findUnmanagedSurfaceRisks(variableAlias, "apps/web/src/config/industry/alias.ts").length, 1);
  const defaultAssignment = 'import { ThirdPartyModal } from "third-party-ui"; export default ThirdPartyModal;';
  assert.equal(findUnmanagedSurfaceRisks(defaultAssignment, "apps/web/src/config/industry/default.ts").length, 1);

  const wrapper = `import { Dialog as BaseDialog } from "@workloom/ui";
    export function RejectDialog(props){ return <BaseDialog {...props} />; }`;
  assert.deepEqual(findUnmanagedSurfaceRisks(wrapper, "apps/web/src/components/RejectDialog.tsx"), []);
  assert.deepEqual(findSurfaceModuleFacts(wrapper, "apps/web/src/components/RejectDialog.tsx").provableExports, ["RejectDialog"]);
  const trustedUse = 'import { RejectDialog } from "./RejectDialog"; export const View=()=> <RejectDialog open />;';
  assert.deepEqual(findUnmanagedSurfaceRisks(trustedUse, "apps/web/src/components/View.tsx", {
    trustedRelativeSurfaceImports: ["RejectDialog"],
  }), []);

  const canonicalReExport = 'export { Dialog as HotelDialog } from "@workloom/ui";';
  assert.deepEqual(findUnmanagedSurfaceRisks(canonicalReExport, "apps/web/src/config/industry/safe.ts"), []);
  assert.deepEqual(findSurfaceModuleFacts(canonicalReExport, "apps/web/src/config/industry/safe.ts").provableExports, ["HotelDialog"]);

  // 2026-09-19：`if (!open) return null;` 是“此刻不渲染”的常规写法，不能因此把完全委托的组件
  // 判成自建浮层（fox 首日上岗引导实测踩到该假阳性）。
  const earlyNullWrapper = `import { Overlay } from "@workloom/ui";
    export function GuideOverlay({ open, onClose }){ if (!open) return null; return <Overlay open={open} title="引导" onClose={onClose}><div>内容</div></Overlay>; }`;
  assert.deepEqual(findUnmanagedSurfaceRisks(earlyNullWrapper, "apps/web/src/extensions/fox/GuideOverlay.tsx"), []);
  assert.deepEqual(findSurfaceModuleFacts(earlyNullWrapper, "apps/web/src/extensions/fox/GuideOverlay.tsx").provableExports, ["GuideOverlay"]);

  const selfDrawnEarlyNull = `export function GuideOverlay({ open }){ if (!open) return null; return <div className="fixed inset-0">自建浮层</div>; }`;
  assert.ok(findUnmanagedSurfaceRisks(selfDrawnEarlyNull, "apps/web/src/extensions/fox/GuideOverlay.tsx")
    .some((risk) => risk.rule.includes("必须委托")));
});

test("嵌套同名安全诱饵不能覆盖真实顶层 surface 导出", () => {
  const shadowDecoy = `
    import { Dialog } from "@workloom/ui";
    import { VendorPanel } from "third-party-ui";
    export function HotelDialog(){ return <VendorPanel />; }
    function Decoy(){ function HotelDialog(){ return <Dialog open />; } return null; }
  `;
  const risks = findUnmanagedSurfaceRisks(shadowDecoy, "apps/web/src/config/industry/HotelDialog.tsx");
  assert.ok(risks.some((risk) => risk.rule.includes("同名或词法阴影")));
  assert.ok(risks.some((risk) => risk.rule.includes("必须委托")));
  assert.deepEqual(findSurfaceModuleFacts(shadowDecoy, "apps/web/src/config/industry/HotelDialog.tsx").provableExports, []);

  const scoped = `
    import { Dialog as BaseDialog } from "@workloom/ui";
    export function Feature(){
      function LocalDialog(props){ return <BaseDialog {...props} />; }
      return <LocalDialog open />;
    }
  `;
  assert.deepEqual(findUnmanagedSurfaceRisks(scoped, "apps/web/src/config/industry/Feature.tsx"), []);
  assert.deepEqual(findSurfaceModuleFacts(scoped, "apps/web/src/config/industry/Feature.tsx").provableExports, []);

  const siblingDecoy = `
    import { Dialog } from "@workloom/ui";
    import { VendorPanel } from "third-party-ui";
    export function HotelDialog(props){ return <><VendorPanel {...props} /><Dialog open={false} /></>; }
  `;
  assert.ok(findUnmanagedSurfaceRisks(siblingDecoy, "apps/web/src/config/industry/Sibling.tsx")
    .some((risk) => risk.rule.includes("必须委托")));
  assert.deepEqual(findSurfaceModuleFacts(siblingDecoy, "apps/web/src/config/industry/Sibling.tsx").provableExports, []);

  const conditional = `
    import { Dialog, Drawer } from "@workloom/ui";
    export function DecisionDialog(props){ return props.compact ? <Dialog {...props} /> : <Drawer {...props} />; }
  `;
  assert.deepEqual(findUnmanagedSurfaceRisks(conditional, "apps/web/src/config/industry/Conditional.tsx"), []);
  assert.deepEqual(findSurfaceModuleFacts(conditional, "apps/web/src/config/industry/Conditional.tsx").provableExports, ["DecisionDialog"]);
});

test("行业 CSS/SCSS 浮面门禁覆盖五类可写路径并精确豁免共享实现", () => {
  for (const file of [
    "apps/web/src/extensions/hotel/cover.module.css",
    "apps/webb/src/projections/hotel/cover.scss",
    "apps/webc/src/config/industry/cover.css",
    "apps/web/src/theme/industry/cover.module.scss",
    "apps/webc/public/industry/cover.css",
  ]) assert.equal(isIndustryExtensionStylesheet(file), true, file);
  assert.equal(isIndustryExtensionStylesheet("apps/web/src/styles/cover.css"), false);
  const cssModuleOverlay = ".cover { position: fixed; inset: 0; z-index: 999; }";
  assert.equal(findStylesheetSurfaceRisks(cssModuleOverlay, "apps/web/src/config/industry/cover.module.css").length, 1);
  const scssOverlay = ".shell { .mask { position: fixed; top: 0; right: 0; bottom: 0; left: 0; } }";
  assert.equal(findStylesheetSurfaceRisks(scssOverlay, "apps/webb/src/theme/industry/cover.scss").length, 1);
  const backdropOverlay = ".mask { position: fixed; top: 0; backdrop-filter: blur(8px); }";
  assert.equal(findStylesheetSurfaceRisks(backdropOverlay, "apps/webc/public/industry/cover.css").length, 1);
  const ordinaryHeader = ".header { position: fixed; top: 0; z-index: 20; }";
  assert.deepEqual(findStylesheetSurfaceRisks(ordinaryHeader, "apps/web/src/extensions/hotel/header.css"), []);
  assert.deepEqual(findStylesheetSurfaceRisks(cssModuleOverlay, "packages/ui/src/components.css"), []);
  assert.equal(findStylesheetSurfaceRisks(cssModuleOverlay, "packages/ui/src/industry-copy.css").length, 1);
});

test("行业 JSON/YAML 文案递归纳管并要求客户端导入时显式分区", () => {
  const labelsPath = "apps/web/src/extensions/hotel/labels.json";
  assert.equal(isIndustryUiConfig(labelsPath), true);
  assert.ok(findIndustryConfigDisplayRisks('{"title":"tenant_id"}', labelsPath)
    .some((risk) => risk.text === "tenant_id"));
  assert.ok(findIndustryConfigDisplayRisks('title: tenant_id\n', "apps/webb/src/theme/industry/labels.yml")
    .some((risk) => risk.text === "tenant_id"));
  const separated = JSON.stringify({ machine: { tenant_id: "raw_tenant" }, display: { tenant: "租户" } });
  assert.deepEqual(findIndustryConfigDisplayRisks(separated, labelsPath, { requirePartition: true }), []);
  assert.ok(findIndustryConfigDisplayRisks('{"title":"酒店"}', labelsPath, { requirePartition: true })
    .some((risk) => risk.rule.includes("display 与 machine")));
  assert.deepEqual(findIndustryConfigImports('import labels from "./labels.json";', "apps/web/src/extensions/hotel/Page.tsx"), [
    { line: 1, path: "./labels.json", text: "./labels.json", rule: "" },
  ]);
  for (const indicator of ["|", "|-", "|+", ">", ">-", ">+"]) {
    const yaml = `display:\n  title: ${indicator}\n    tenant_id console\n`;
    assert.ok(findIndustryConfigDisplayRisks(yaml, "apps/web/src/extensions/hotel/labels.yaml")
      .some((risk) => risk.rule.includes("block scalar")), indicator);
  }
  for (const yaml of [
    "---\ndisplay:\n  title: 酒店\n",
    "base: &copy\n  title: 酒店\ndisplay: *copy\n",
    "display: !copy\n  title: 酒店\n",
    "display:\n  <<: *copy\n",
  ]) assert.ok(findIndustryConfigDisplayRisks(yaml, "apps/web/src/extensions/hotel/labels.yml").length > 0, yaml);
});

test("行业 CSS/SCSS 与 HTML 资源只允许静态相对本地依赖", () => {
  assert.deepEqual(findStylesheetImports('@import "./base.css"; @use "../tokens" as tokens;')
    .map((item) => item.path), ["./base.css", "../tokens"]);
  for (const source of [
    '@import "https://cdn.example/fork.css";',
    '@import url("//cdn.example/fork.css");',
    '@import "data:text/css,body{}";',
    '@import $themePath;',
    '@use "#{$theme}/fork";',
  ]) assert.ok(findStylesheetImports(source)[0]?.rule, source);

  const htmlPath = "apps/web/public/industry/hotel/index.html";
  assert.deepEqual(findIndustryHtmlResourceReferences(
    '<script src="./app.js"></script><link rel="stylesheet" href="./app.css">', htmlPath,
  ).map((item) => item.path), ["./app.js", "./app.css"]);
  const external = findIndustryHtmlResourceReferences(
    '<script src="https://cdn.example/app.js"></script><link rel="stylesheet" href="//cdn.example/app.css"><object data="https://fork.example/ui"></object><embed src="//fork.example/ui">', htmlPath,
  );
  assert.equal(external.length, 4);
  assert.ok(external.every((item) => item.rule.includes("静态相对本地资源")));
  assert.equal(findIndustryHtmlResourceReferences('<iframe src="/industry/hotel/nested.html"></iframe>', htmlPath)[0]?.path,
    "/industry/hotel/nested.html");
});

test("行业 iframe/webview 禁止远端与动态界面但允许本地静态资源", () => {
  const file = "apps/web/src/extensions/hotel/Help.tsx";
  assert.equal(findIndustryEmbeddedUiRisks('<iframe src="https://fork.example/ui" />', file).length, 1);
  assert.equal(findIndustryEmbeddedUiRisks('<webview src={remoteUrl} />', file).length, 1);
  assert.equal(findIndustryEmbeddedUiRisks('<iframe srcDoc={html} />', file).length, 1);
  assert.deepEqual(findIndustryEmbeddedUiRisks('<iframe src="/industry/hotel/help.html" />', file), []);
  assert.equal(findIndustryEmbeddedUiRisks('<object data="https://fork.example/ui" />', file).length, 1);
  assert.equal(findIndustryEmbeddedUiRisks('<embed src={remoteUrl} />', file).length, 1);
  assert.equal(findIndustryEmbeddedUiReferences('<iframe src="/industry/hotel/help.html" />', file)[0]?.path,
    "/industry/hotel/help.html");
  assert.deepEqual(findIndustryEmbeddedUiRisks('<iframe src="https://fork.example/ui" />', "apps/web/src/pages/Help.tsx"), []);
});

test("PC 导航门禁覆盖 clientFoundation 的全部五类行业可写路径", () => {
  for (const file of [
    "apps/web/src/extensions/hotel/Page.tsx",
    "apps/web/src/projections/hotel/Page.tsx",
    "apps/web/src/config/industry/navigation.tsx",
    "apps/web/src/theme/industry/navigation.jsx",
    "apps/web/public/industry/navigation.js",
  ]) assert.equal(isPcIndustryNavigationSource(file), true, file);
  assert.equal(isPcIndustryNavigationSource("apps/web/src/config/industries/navigation.tsx"), false);
  assert.equal(findPcExtensionNavigationRisks('<nav><button>概览</button></nav>', "apps/web/src/extensions/hotel/Page.tsx").length, 1);
  assert.equal(findPcExtensionNavigationRisks('<PageNav />', "apps/web/src/projections/hotel/Page.tsx").length, 1);
  assert.equal(findPcExtensionNavigationRisks('<nav />', "apps/web/src/config/industry/navigation.tsx").length, 1);
  assert.equal(findPcExtensionNavigationRisks('<TopNav />', "apps/web/src/theme/industry/navigation.tsx").length, 1);
  assert.equal(findPcExtensionNavigationRisks('<HotelNavigation />', "apps/web/src/theme/industry/navigation.tsx").length, 1);
  assert.equal(findPcExtensionNavigationRisks('<Ui.PageNavigation />', "apps/web/public/industry/navigation.js").length, 1);
  assert.equal(findPcExtensionNavigationRisks('<SectionNavigation items={items} />', "apps/web/src/extensions/hotel/Page.tsx").length, 1);
  const sharedSection = 'import { SectionNavigation } from "@workloom/ui"; export const View=()=> <SectionNavigation items={items} />;';
  assert.deepEqual(findPcExtensionNavigationRisks(sharedSection, "apps/web/src/config/industry/navigation.tsx"), []);
  const sharedAlias = 'import { SectionNavigation as IndustrySections } from "@workloom/ui"; export const View=()=> <IndustrySections items={items} />;';
  assert.deepEqual(findPcExtensionNavigationRisks(sharedAlias, "apps/web/src/theme/industry/navigation.tsx"), []);
  const shadowedSection = 'import { SectionNavigation } from "@workloom/ui"; export function View(SectionNavigation){ return <SectionNavigation items={items} />; }';
  assert.equal(findPcExtensionNavigationRisks(shadowedSection, "apps/web/src/theme/industry/navigation.tsx").length, 1);
  const nonNavigationConfig = 'export const industryTheme = { placement: "left", density: "comfortable" };';
  assert.deepEqual(findPcExtensionNavigationRisks(nonNavigationConfig, "apps/web/src/config/industry/theme.ts"), []);
  assert.deepEqual(findPcExtensionNavigationRisks('<nav />', "apps/webb/src/extensions/hotel/Page.tsx"), []);
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

test("共享告警条在窄面板和文字放大时保留正文宽度，PC 端不得复制实现", () => {
  const component = `export function BannerAlert(){return <div className="wl-banner-alert"><div className="wl-banner-alert__body"><div className="wl-banner-alert__copy" /></div><div className="wl-banner-alert__actions" /></div>}`;
  const css = `
    .wl-banner-alert { display:flex; flex-wrap:wrap; min-width:0; max-inline-size:100%; }
    .wl-banner-alert__body { display:grid; flex:1 1 20rem; min-width:0; grid-template-columns:auto minmax(0,1fr); }
    .wl-banner-alert__copy { min-width:0; overflow-wrap:anywhere; }
  `;
  const adapter = `export { BannerAlert } from "@workloom/ui";`;
  assert.deepEqual(findBannerAlertContractRisks(component, css, adapter), []);
  const risks = findBannerAlertContractRisks(
    component,
    css.replace("flex-wrap:wrap", "flex-wrap:nowrap").replace("flex:1 1 20rem", "flex:1 1 0"),
    `export function BannerAlert(){ return <div /> }`,
  );
  assert.ok(risks.some((risk) => risk.includes("空间不足时换行")));
  assert.ok(risks.some((risk) => risk.includes("弹性基准宽度")));
  assert.ok(risks.some((risk) => risk.includes("只能从 @workloom/ui 重导出")));
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
