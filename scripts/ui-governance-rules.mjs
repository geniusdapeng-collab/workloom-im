import ts from "typescript-governance";

const VISIBLE_ATTRIBUTES = new Set([
  "alt",
  "aria-label",
  "aria-description",
  "description",
  "hint",
  "label",
  "placeholder",
  "title",
]);

/** 仅在大写 React 组件上视为可见文案，避免把领域对象的同名机器字段误报。 */
const VISIBLE_CUSTOM_COMPONENT_PROPS = new Set([
  "badge", "caption", "eyebrow", "failureText", "footnote", "kicker", "metaText", "noDataText",
  "note", "optionalLabel", "period", "source", "statusLabel", "subtitle", "tag", "ticketTitle",
  "tooltip", "unit", "updatedAt", "welcomeText",
]);

const VISIBLE_PROPERTY_NAMES = new Set([
  "actionLabel",
  "desc",
  "description",
  "hint",
  "label",
  "message",
  "body",
  "channelName",
  "content",
  "emptyLabel",
  "emptyText",
  "errorText",
  "fallbackReason",
  "helperText",
  "noDataText",
  "summary",
  "text",
  "title",
  "tooltip",
]);

// `value` 对原生表单与表单组件通常是机器值，不能一刀切当成展示文案；但在
// MetricCard、KpiGauge、CommandCard 等非表单组件上会直接渲染给用户。这里按
// 组件语义收口，既覆盖下游自定义展示组件，也避免把 input/select 的受控值误报。
const NON_DISPLAY_VALUE_COMPONENTS = new Set([
  "Checkbox", "Combobox", "DateInput", "Input", "PasswordInput", "Progress", "Radio",
  "Range", "SearchInput", "Select", "Slider", "Switch", "TextArea", "Textarea", "UrlQrCode",
]);

const VISIBLE_SETTER = /^(?:appendAi|enqueueSnackbar|notify|setBanner|setBindingError|setCaption|setDone|setErr|setError|setFeedback|setLoadMessage|setMessage|setMsg|setNotice|setRateError|setSiteResult|setSubtitle|setToast|showToast)$/;
const ENGINEERING_CODE = /(?:^|[^A-Za-z0-9])(?:P|F|E|L|M|D|G)\d+(?:\.\d+)?(?:$|[^A-Za-z0-9])/;
const RAW_CLIENT_TERM = /\b(?:Agent|Bundle|Profile|Rebase|schema|fence_bindings|preset_key|presetKey|overlay_version|base_version|bundle_id|bundleId|batchId|tenant_id|tenantId|workspace_id|workspaceId|event_id|eventId|request_id|requestId|requiredClauses|reasonEnum|input_tokens|output_tokens|latencyMs|cron|args|JSON|YAML|CLI|SQL|SSE|tRPC|npm|pip|git)\b/i;
const RAW_FIELD_SHAPE = /\b(?:[a-z][a-z0-9]*_[a-z0-9_]+|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)\b/;
const RAW_DYNAMIC_FIELD = new Set([
  "id", "status", "schedule", "cron",
  "eventId", "event_id", "requestId", "request_id", "resourceId", "resource_id",
  "ticketId", "ticket_id", "threadId", "thread_id", "taskId", "task_id",
  "memberId", "member_id", "workspaceId", "workspace_id", "tenantId", "tenant_id",
  "bundleId", "bundle_id", "presetKey", "preset_key", "model_id", "agent_id",
  "baseline_branch", "assigned_tool", "change_kind", "exit_reason",
  "credential_health", "rule_id",
]);
const SAFE_DISPLAY_FORMATTERS = new Set([
  "actionText", "actorText", "capabilityText", "clientChineseText", "clientIdentifierText", "clientNodeText",
  "clientStatusLabel", "clientValueText", "confidenceText", "cronText", "dictText",
  "chineseMessage", "displayNameOf", "formatDate", "formatDateTime", "formatTime", "inboxSpeechText",
  "docStatusChip", "kindLabel", "latencyText", "modelName", "operationFailure", "payloadText",
  "publicationSystemText", "roleTitleOf", "ticketStatusChip",
  "safeAiText", "safeMessage", "safeOnboardingError", "safeWizardError", "shortId", "speechText",
  "versionText",
]);
const SAFE_DISPLAY_MAPS = new Set([
  "ACTION_LABELS", "ATTRIBUTION_TEXT", "CHANNEL_STATUS", "ENVIRONMENT_LABELS", "EXAM_LABELS",
  "EXAM_STATUS_TEXT", "EXAM_TYPE_TEXT", "KIND_TEXT", "LAYER_TEXT", "MODE_LABEL", "MODE_TEXT",
  "NAVIGATION_GROUP_LABELS", "PERSONA_NAME", "POOL_LABEL", "PUBLICATION_STATUS", "RISK_LABELS",
  "ROLE_LABELS", "SOURCE_TEXT", "STATE_DEFAULTS", "STATUS", "SUBJECT_TEXT", "TASK_STATUS",
  "THREAD_MODE_TEXT", "TIER_TEXT", "TOAST_TITLES", "TOOL_TEXT", "TYPE_LABEL", "TYPE_TEXT",
  "VERDICT", "VERDICT_META", "STRUCTURE_TEXT", "chunkCounts", "workspaceNames",
]);
const AUTHORIZED_DIAGNOSTIC_FILE = /apps\/web\/src\/extensions\/ai-pm\/P25\.tsx$/;
const AUTHORIZED_LOCAL_GUIDE_FILE = /apps\/web\/src\/components\/BackendGate\.tsx$/;
const AUTHORIZED_COMPONENT_MATRIX_FILE = /apps\/web\/src\/pages\/dev\/DevMatrix\.tsx$/;
const SAFE_VISIBLE_LATIN_TERM = /^(?:AI|API|B|C|CSV|DeepSeek|DOCX|DSL|Esc|Excel|FAE|FAQ|GEO|GLM|GPS|H5|IM|Kimi|KPI|Lightning|LLM|MB|MD|MVP|Moonshot|OAuth|OpenAI|PC|PDF|PRD|RLS|ROI|SLA|SOP|SPA|TSV|TXT|Type-C|URL|USB|WiFi|WorkLoom|XLSX|XP|XX|Yunqi-Hotel|deepseek-chat|retail|sk)$/i;
const LATIN_TOKEN = /[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*/g;
const UNTRUSTED_RESPONSE_FIELD = new Set(["answer", "code", "detail", "error", "message", "reason", "result", "summary"]);
const UNTRUSTED_RESPONSE_ROOT = /^(?:apiError|cause|e|err|error|exception|failure|payload|reply|res|response|result|serverResponse)$/i;
const CLIENT_SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/i;
const CLIENT_SOURCE_ROOT = /^(?:apps\/(?:web|webb|webc)\/src|packages\/ui\/src)\//;
const CLIENT_SOURCE_EXCLUSION = /(?:^|\/)(?:__tests__|coverage|dist|node_modules)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/i;
const BUNDLE_UI_CONFIG_FILE = /^(?:apps\/webc\/public\/(?:industry\/)?service-front\.config\.json|bundles\/[^/]+\/(?:floor-scene\.json|service-front\/client\.json))$/;
const BUNDLE_DISPLAY_KEY = new Set([
  "a", "agentName", "brandName", "desc", "description", "docTitle", "emptyOrders", "errorText",
  "hint", "label", "logoText", "message", "name", "note", "q", "sendText", "sla", "summary",
  "symptoms", "text", "tip", "title", "titlePlaceholder", "tooltip", "unit", "welcomeText",
]);
const CUSTOM_GRAPHICS = Object.freeze({
  "agent-avatar": { file: /apps\/web\/src\/components\/AgentAvatar\.tsx$/, accessible: "image" },
  "generated-qr-code": { file: /apps\/web\/src\/components\/UrlQrCode\.tsx$/, accessible: "image" },
  "live-character": { file: /apps\/web\/src\/components\/loommate\/MateLive2D\.tsx$/, accessible: "nested" },
  "hologram-figure": { file: /apps\/web\/src\/pages\/p0\/P0\.tsx$/, accessible: "decorative" },
});
const FUNCTIONAL_GLYPH = /[\p{Extended_Pictographic}✓✗✕⚠⛔○◆◇▲▼✎✦✧❖▶◀■□▍◈⌃⌄⋯⧉↻⚙▾▴›‹＋]/gu;

function stripComments(source) {
  let result = "";
  let index = 0;
  let state = "code";
  let quote = "";
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (char === "\n") { result += "\n"; state = "code"; }
      else result += " ";
      index += 1;
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") { result += "  "; index += 2; state = "code"; continue; }
      result += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }
    if (state === "string") {
      result += char;
      if (char === "\\") {
        if (next !== undefined) result += next;
        index += 2;
        continue;
      }
      if (char === quote) state = "code";
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") { result += "  "; index += 2; state = "line-comment"; continue; }
    if (char === "/" && next === "*") { result += "  "; index += 2; state = "block-comment"; continue; }
    if (char === '"' || char === "'" || char === "`") { state = "string"; quote = char; }
    result += char;
    index += 1;
  }
  return result;
}

function scriptKindOf(fileName) {
  if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.js$/i.test(fileName)) return ts.ScriptKind.JS;
  if (/\.ts$/i.test(fileName)) return ts.ScriptKind.TS;
  return /<\/?[A-Za-z][^>]*>/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TSX;
}

function parseClientSource(source, fileName = "client.tsx") {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
}

function jsxAttributeText(attribute) {
  if (!ts.isJsxAttribute(attribute) || !attribute.initializer) return "";
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression
    && (ts.isStringLiteral(attribute.initializer.expression) || ts.isNoSubstitutionTemplateLiteral(attribute.initializer.expression))) {
    return attribute.initializer.expression.text;
  }
  return "";
}

function jsxTagName(node) {
  const tag = node.tagName;
  return ts.isIdentifier(tag) ? tag.text : "";
}

function jsxAttributeOwnerName(attribute) {
  const attributes = attribute.parent;
  const opening = attributes?.parent;
  if (!opening || (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening))) return "";
  return jsxTagName(opening);
}

function isVisibleJsxAttribute(attribute, name) {
  if (VISIBLE_ATTRIBUTES.has(name) || VISIBLE_PROPERTY_NAMES.has(name)) return true;
  const owner = jsxAttributeOwnerName(attribute);
  if (/^[A-Z]/.test(owner) && VISIBLE_CUSTOM_COMPONENT_PROPS.has(name)) return true;
  if (name !== "value") return false;
  return /^[A-Z]/.test(owner) && !NON_DISPLAY_VALUE_COMPONENTS.has(owner);
}

function componentDeclarations(sourceFile) {
  const declarations = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement);
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
        declarations.set(declaration.name.text, declaration);
      }
    }
  }
  return declarations;
}

function componentNamesWithin(node) {
  const names = new Set();
  const visit = (current) => {
    if (ts.isJsxOpeningElement(current) || ts.isJsxSelfClosingElement(current)) {
      const name = jsxTagName(current);
      if (/^[A-Z]/.test(name)) names.add(name);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

function componentReferenceOffsets(sourceFile, componentName) {
  const offsets = [];
  const visit = (node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && jsxTagName(node) === componentName) {
      offsets.push(node.getStart(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return offsets;
}

function transitiveComponentRanges(sourceFile, seeds, authorizedCallSites = []) {
  const declarations = componentDeclarations(sourceFile);
  const ranges = [];
  const queued = [...seeds];
  const visited = new Set();
  while (queued.length > 0) {
    const name = queued.shift();
    if (!name || visited.has(name)) continue;
    visited.add(name);
    const declaration = declarations.get(name);
    if (!declaration) continue;
    const allowedReferences = [...authorizedCallSites, ...ranges];
    const references = componentReferenceOffsets(sourceFile, name);
    if (references.length === 0 || references.some((offset) => !offsetInRanges(offset, allowedReferences))) continue;
    ranges.push([declaration.getStart(sourceFile), declaration.getEnd()]);
    for (const childName of componentNamesWithin(declaration)) queued.push(childName);
  }
  return ranges;
}

function devGuideCallSiteRanges(sourceFile) {
  const ranges = [];
  const visit = (node) => {
    if (ts.isConditionalExpression(node)
      && node.condition.getText(sourceFile).replace(/\s+/g, "") === "import.meta.env.DEV"
      && componentNamesWithin(node.whenTrue).has("GuidePage")) {
      ranges.push([node.whenTrue.getStart(sourceFile), node.whenTrue.getEnd()]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return ranges;
}

function markedDiagnosticNodes(sourceFile, markerValue = "ai-pm.development") {
  const nodes = [];
  const visit = (node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const marker = opening.attributes.properties.find((attribute) =>
        ts.isJsxAttribute(attribute)
        && attribute.name.getText(sourceFile) === "data-wl-authorized-diagnostics"
        && jsxAttributeText(attribute) === markerValue);
      if (marker) nodes.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return nodes;
}

/**
 * 技术文案只在真实的授权 DOM 子树及其本地组件依赖中豁免。仅在注释或字符串中
 * 写 marker 不会再放行整份 P25；生产 BackendGate 也只能放行 DEV 分支引用的向导组件。
 */
function authorizedTechnicalRanges(source, fileName) {
  const normalized = fileName.replaceAll("\\", "/");
  const sourceFile = parseClientSource(source, normalized);
  const ranges = [];
  if (AUTHORIZED_DIAGNOSTIC_FILE.test(normalized)) {
    const marked = markedDiagnosticNodes(sourceFile);
    const markedRanges = marked.map((node) => [node.getStart(sourceFile), node.getEnd()]);
    const names = new Set();
    for (const node of marked) {
      for (const name of componentNamesWithin(node)) names.add(name);
    }
    ranges.push(...markedRanges, ...transitiveComponentRanges(sourceFile, names, markedRanges));
  }
  if (AUTHORIZED_LOCAL_GUIDE_FILE.test(normalized)) {
    const callSites = devGuideCallSiteRanges(sourceFile);
    ranges.push(...callSites, ...transitiveComponentRanges(sourceFile, new Set(["GuidePage"]), callSites));
  }
  if (AUTHORIZED_COMPONENT_MATRIX_FILE.test(normalized)) {
    const marked = markedDiagnosticNodes(sourceFile, "ui-component-matrix");
    const markedRanges = marked.map((node) => [node.getStart(sourceFile), node.getEnd()]);
    const names = new Set();
    for (const node of marked) {
      for (const name of componentNamesWithin(node)) names.add(name);
    }
    ranges.push(...markedRanges, ...transitiveComponentRanges(sourceFile, names, markedRanges));
  }
  return ranges;
}

function offsetInRanges(offset, ranges) {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

function literalLanguageRules(text, kind = "页面文本") {
  const rules = [];
  let literalText = stripTemplateInterpolations(String(text));
  literalText = literalText.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, "");
  // 地址与明确的键盘快捷键属于可执行输入，不把域名、F11 误判为产品英文或工程代号。
  literalText = literalText.replace(/\bhttps?:\/\/[^\s，。；）)]+/gi, "");
  literalText = literalText.replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|h|KB|MB|GB)\b/gi, "");
  literalText = literalText.replace(/(?:⌘(?:\/Ctrl)?|Ctrl)(?:\+Shift)?\+?[A-Z0-9]\b/g, "");
  if (/(?:快捷键|键盘|回车|方向键|按住)/.test(literalText)) literalText = literalText.replace(/\b(?:Shift|Ctrl|Alt|Cmd)\b/g, "");
  if (/(?:快捷键|键盘|全屏)/.test(literalText)) literalText = literalText.replace(/\bF(?:[1-9]|1\d|2[0-4])\b/g, "");
  const engineeringText = literalText;
  if (kind === "裸 JSON" || text === "JSON.stringify") rules.push("客户端不得直接渲染裸 JSON");
  if (ENGINEERING_CODE.test(engineeringText)) rules.push("客户端不得展示 P/F/E/L 工程代号");
  if (RAW_CLIENT_TERM.test(literalText) || RAW_FIELD_SHAPE.test(literalText)) {
    rules.push("客户端不得展示英文底层字段或工程术语");
  }
  const unknownLatin = [...literalText.matchAll(LATIN_TOKEN)]
    .map(([token]) => token)
    .filter((token) => !SAFE_VISIBLE_LATIN_TERM.test(token) && !/^v\d+(?:\.\d+)*$/i.test(token));
  if (unknownLatin.length > 0) rules.push(`客户端可见英文未登记中文边界：${[...new Set(unknownLatin)].slice(0, 3).join("、")}`);
  return [...new Set(rules)];
}

/** 门禁文件发现本身也做成可测试规则，避免新增扩展名或共享组件后静默漏扫。 */
export function isClientSurfaceSource(fileName) {
  const normalized = fileName.replaceAll("\\", "/").replace(/^\.\//, "");
  return CLIENT_SOURCE_ROOT.test(normalized)
    && CLIENT_SOURCE_FILE.test(normalized)
    && !CLIENT_SOURCE_EXCLUSION.test(normalized);
}

export function isBundleUiConfig(fileName) {
  const normalized = fileName.replaceAll("\\", "/").replace(/^\.\//, "");
  return BUNDLE_UI_CONFIG_FILE.test(normalized);
}

/**
 * Bundle 投影和场景配置会绕过 JSX 静态字面量检查，因此只扫描明确会成为界面内容的键。
 * 代码型 id/kind/role/category 等仍由各自契约校验，不误当作客户端展示文案。
 */
export function findBundleDisplayLanguageRisks(source, fileName = "bundle-ui.json") {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return [{
      line: 1,
      text: String(error instanceof Error ? error.message : error).slice(0, 96),
      path: "$",
      rule: "Bundle 客户端配置必须是有效 JSON",
    }];
  }
  const risks = [];
  const cursors = new Map();
  const lineOf = (value) => {
    const literal = JSON.stringify(value);
    const cursor = cursors.get(literal) ?? 0;
    const found = source.indexOf(literal, cursor);
    if (found < 0) return 1;
    cursors.set(literal, found + literal.length);
    return sourceLineAt(source, found);
  };
  const visit = (value, path, key = "") => {
    if (typeof value === "string" && BUNDLE_DISPLAY_KEY.has(key)) {
      for (const rule of literalLanguageRules(value, `Bundle 展示字段 ${key}`)) {
        risks.push({ line: lineOf(value), text: value, path, rule });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, key));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) visit(child, `${path}.${childKey}`, childKey);
  };
  visit(parsed, "$", "");
  return risks;
}

/**
 * Extract only strings that can reach a client-facing text position. Comments, types,
 * imports, enum values and CSS class names are deliberately ignored so implementation
 * vocabulary can remain precise without leaking into the product surface.
 */
export function collectVisibleStrings(source, fileName = "client.tsx") {
  const sourceFile = parseClientSource(source, fileName);
  const rows = [];
  const seen = new Set();

  const add = (text, node, kind) => {
    const normalized = String(text).replace(/\s+/g, " ").trim();
    if (!normalized) return;
    const offset = node.getStart(sourceFile);
    const line = sourceFile.getLineAndCharacterOfPosition(offset).line + 1;
    const key = `${line}:${kind}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ text: normalized, line, kind, offset });
  };

  const addLiteralPieces = (expression, kind) => {
    for (const piece of literalPieces(expression)) add(piece, expression, kind);
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) add(node.text, node, "页面文本");
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile);
      if (isVisibleJsxAttribute(node, name)) {
        if (node.initializer && ts.isStringLiteral(node.initializer)) add(node.initializer.text, node.initializer, `属性 ${name}`);
        if (node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          addLiteralPieces(node.initializer.expression, `属性 ${name}`);
        }
      }
    }
    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      const parentTag = ts.isJsxElement(node.parent) ? jsxTagName(node.parent.openingElement) : "";
      if (!/^(?:script|style)$/i.test(parentTag)) addLiteralPieces(node.expression, "页面文本兜底");
      if (ts.isCallExpression(node.expression) && calledName(node.expression.expression) === "stringify"
        && rootIdentifierOf(node.expression.expression) === "JSON") add("JSON.stringify", node.expression, "裸 JSON");
    }
    if (ts.isPropertyAssignment(node)) {
      const name = node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : "";
      if (VISIBLE_PROPERTY_NAMES.has(name)) addLiteralPieces(node.initializer, `展示字段 ${name}`);
    }
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      const fullName = node.expression.getText(sourceFile);
      if (VISIBLE_SETTER.test(name) || name === "toast" || /(?:^|\.)toast\.(?:error|info|success|warn|warning)$/.test(fullName)
        || name === "speak") {
        for (const argument of node.arguments) for (const value of objectTextValues(argument)) addLiteralPieces(value, `反馈 ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return rows;
}

export function findVisibleLanguageRisks(source, fileName = "client.tsx") {
  const risks = [];
  const authorizedRanges = authorizedTechnicalRanges(source, fileName);
  for (const item of collectVisibleStrings(source, fileName)) {
    if (offsetInRanges(item.offset, authorizedRanges)) continue;
    for (const rule of literalLanguageRules(item.text, item.kind)) risks.push({ ...item, rule });
  }
  return risks;
}

function stripTemplateInterpolations(text) {
  let result = "";
  for (let index = 0; index < text.length;) {
    if (text[index] !== "$" || text[index + 1] !== "{") {
      result += text[index];
      index += 1;
      continue;
    }
    let depth = 1;
    index += 2;
    while (index < text.length && depth > 0) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}") depth -= 1;
      index += 1;
    }
  }
  return result;
}

function unwrapExpression(node) {
  let current = node;
  while (current && (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  )) current = current.expression;
  return current;
}

function calledName(expression) {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isElementAccessExpression(target) && target.argumentExpression
    && (ts.isStringLiteral(target.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(target.argumentExpression))) {
    return target.argumentExpression.text;
  }
  return "";
}

function propertyNameOf(expression) {
  const target = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isElementAccessExpression(target) && target.argumentExpression
    && (ts.isStringLiteral(target.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(target.argumentExpression))) {
    return target.argumentExpression.text;
  }
  return "";
}

function rootIdentifierOf(expression) {
  let current = unwrapExpression(expression);
  while (current) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = unwrapExpression(current.expression);
      continue;
    }
    if (ts.isCallExpression(current)) {
      current = unwrapExpression(current.expression);
      continue;
    }
    return "";
  }
  return "";
}

function propertyPathOf(expression) {
  const parts = [];
  let current = unwrapExpression(expression);
  while (current) {
    if (ts.isIdentifier(current)) {
      parts.unshift(current.text);
      break;
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const property = propertyNameOf(current);
      if (property) parts.unshift(property);
      current = unwrapExpression(current.expression);
      continue;
    }
    break;
  }
  return parts;
}

function isSafeDisplayFormatterCall(node) {
  const target = unwrapExpression(node.expression);
  if (ts.isIdentifier(target)) return SAFE_DISPLAY_FORMATTERS.has(target.text);
  return ts.isPropertyAccessExpression(target)
    && target.name.text === "get"
    && ts.isIdentifier(target.expression)
    && SAFE_DISPLAY_MAPS.has(target.expression.text);
}

function unsafeDynamicNames(expression, taintedIdentifiers = new Set()) {
  const names = [];
  const seen = new Set();
  const add = (name) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  const visit = (rawNode) => {
    const node = unwrapExpression(rawNode);
    if (!node) return;
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      if (isSafeDisplayFormatterCall(node)) return;
      if (name === "stringify" && rootIdentifierOf(node.expression) === "JSON") add("JSON.stringify");
      if (name === "map" || name === "flatMap") {
        for (const argument of node.arguments) visit(argument);
        return;
      }
      visit(node.expression);
      for (const argument of node.arguments) visit(argument);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.whenTrue);
      visit(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if ([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
        ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken].includes(operator)) return;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) visit(node.right);
      else { visit(node.left); visit(node.right); }
      return;
    }
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)
      && SAFE_DISPLAY_MAPS.has(node.expression.text)) return;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const property = propertyNameOf(node);
      const root = rootIdentifierOf(node);
      const path = propertyPathOf(node);
      if (RAW_DYNAMIC_FIELD.has(property)) add(property);
      if (UNTRUSTED_RESPONSE_FIELD.has(property)
        && (UNTRUSTED_RESPONSE_ROOT.test(root) || path.slice(0, -1).some((part) => /^(?:error|failure|response)$/i.test(part)))) {
        add(path.join("."));
      }
      visit(node.expression);
      if (ts.isElementAccessExpression(node) && node.argumentExpression) visit(node.argumentExpression);
      return;
    }
    if (ts.isIdentifier(node)) {
      if (RAW_DYNAMIC_FIELD.has(node.text)) add(node.text);
      if (taintedIdentifiers.has(node.text)) add(node.text);
      return;
    }
    if (ts.isArrowFunction(node)) {
      if (ts.isBlock(node.body)) {
        const visitReturns = (child) => {
          if (ts.isReturnStatement(child) && child.expression
            && !ts.isJsxElement(child.expression) && !ts.isJsxSelfClosingElement(child.expression) && !ts.isJsxFragment(child.expression)) {
            visit(child.expression);
            return;
          }
          ts.forEachChild(child, visitReturns);
        };
        visitReturns(node.body);
      } else if (!ts.isJsxElement(node.body) && !ts.isJsxSelfClosingElement(node.body) && !ts.isJsxFragment(node.body)) visit(node.body);
      return;
    }
    if (ts.isFunctionExpression(node)) {
      const visitReturns = (child) => {
        if (ts.isReturnStatement(child) && child.expression
          && !ts.isJsxElement(child.expression) && !ts.isJsxSelfClosingElement(child.expression) && !ts.isJsxFragment(child.expression)) {
          visit(child.expression);
          return;
        }
        ts.forEachChild(child, visitReturns);
      };
      visitReturns(node.body);
      return;
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return names;
}

function collectTaintedIdentifiers(sourceFile) {
  const tainted = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    const add = (name) => {
      if (!name || tainted.has(name)) return;
      tainted.add(name);
      changed = true;
    };
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const root = rootIdentifierOf(node.initializer);
        const path = propertyPathOf(node.initializer);
        const initializer = unwrapExpression(node.initializer);
        const directAccess = ts.isPropertyAccessExpression(initializer)
          || ts.isElementAccessExpression(initializer)
          || (ts.isIdentifier(initializer) && tainted.has(initializer.text));
        const directField = propertyNameOf(initializer);
        const untrustedSource = directAccess && (
          (UNTRUSTED_RESPONSE_FIELD.has(directField)
            && (UNTRUSTED_RESPONSE_ROOT.test(root) || path.some((part) => /^(?:error|failure|response)$/i.test(part))))
          || RAW_DYNAMIC_FIELD.has(directField)
          || (ts.isIdentifier(initializer) && tainted.has(initializer.text))
        );
        if (ts.isIdentifier(node.name) && untrustedSource) add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)
          && (untrustedSource || UNTRUSTED_RESPONSE_ROOT.test(root))) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const property = element.propertyName?.getText(sourceFile) ?? element.name.text;
            if (UNTRUSTED_RESPONSE_FIELD.has(property) || untrustedSource) add(element.name.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return tainted;
}

/** 使用 TypeScript AST 检查 JSX 文本与动态可见属性，覆盖可选链、计算属性和嵌套模板。 */
export function findRawDynamicValueRisks(source, fileName = "client.tsx") {
  const sourceFile = parseClientSource(source, fileName);
  const authorizedRanges = authorizedTechnicalRanges(source, fileName);
  const taintedIdentifiers = collectTaintedIdentifiers(sourceFile);
  const risks = [];
  const seen = new Set();
  const add = (node, name) => {
    const offset = node.getStart(sourceFile);
    if (offsetInRanges(offset, authorizedRanges)) return;
    const line = sourceFile.getLineAndCharacterOfPosition(offset).line + 1;
    const text = node.getText(sourceFile).trim().slice(0, 96);
    const key = `${line}:${name}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    risks.push({ line, text, rule: `客户端动态值 ${name} 必须先经过中文映射或编号脱敏` });
  };
  const check = (expression) => {
    if (!expression) return;
    for (const name of unsafeDynamicNames(expression, taintedIdentifiers)) add(expression, name);
  };
  const visit = (node) => {
    if (ts.isJsxExpression(node) && node.expression) {
      if (ts.isJsxAttribute(node.parent)) {
        const attribute = node.parent.name.getText(sourceFile);
        if (isVisibleJsxAttribute(node.parent, attribute)) check(node.expression);
      } else if (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) check(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return risks;
}

const TEXT_SINK_CALL = /^(?:appendAi|enqueueSnackbar|notify|setBanner|setBindingError|setCaption|setDone|setErr|setError|setFeedback|setLoadMessage|setMessage|setMsg|setNotice|setRateError|setSiteResult|setSubtitle|setToast|showToast)$/;
const SINK_OBJECT_TEXT_KEY = new Set(["body", "channelName", "content", "description", "detail", "emptyLabel", "emptyText", "errorText", "failureText", "fallbackReason", "helperText", "label", "message", "noDataText", "summary", "text", "ticketTitle", "title", "tooltip"]);

function objectTextValues(node) {
  const target = unwrapExpression(node);
  if (!target) return [];
  if (!ts.isObjectLiteralExpression(target)) return [target];
  const values = [];
  for (const property of target.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : "";
    if (SINK_OBJECT_TEXT_KEY.has(name)) values.push(property.initializer);
  }
  return values;
}

function literalPieces(node) {
  const target = unwrapExpression(node);
  if (!target) return [];
  if (ts.isStringLiteral(target) || ts.isNoSubstitutionTemplateLiteral(target)) return [target.text];
  if (ts.isTemplateExpression(target)) return [target.head.text, ...target.templateSpans.map((span) => span.literal.text)];
  if (ts.isConditionalExpression(target)) return [...literalPieces(target.whenTrue), ...literalPieces(target.whenFalse)];
  if (ts.isBinaryExpression(target) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(target.operatorToken.kind)) {
    return [...literalPieces(target.left), ...literalPieces(target.right)];
  }
  return [];
}

/** 检查 JSX 之外的高风险客户端文字出口：标题、Toast、通知、语音/字幕与 DOM/canvas。 */
export function findClientTextSinkRisks(source, fileName = "client.tsx") {
  const sourceFile = parseClientSource(source, fileName);
  const authorizedRanges = authorizedTechnicalRanges(source, fileName);
  const taintedIdentifiers = collectTaintedIdentifiers(sourceFile);
  const risks = [];
  const seen = new Set();
  const add = (node, rule, text = node.getText(sourceFile)) => {
    const offset = node.getStart(sourceFile);
    if (offsetInRanges(offset, authorizedRanges)) return;
    const line = sourceFile.getLineAndCharacterOfPosition(offset).line + 1;
    const clipped = String(text).trim().slice(0, 96);
    const key = `${line}:${rule}:${clipped}`;
    if (seen.has(key)) return;
    seen.add(key);
    risks.push({ line, text: clipped, rule });
  };
  const checkValue = (node) => {
    for (const name of unsafeDynamicNames(node, taintedIdentifiers)) add(node, `客户端文字出口中的 ${name} 必须先经过中文映射或编号脱敏`);
    for (const piece of literalPieces(node)) {
      for (const rule of literalLanguageRules(piece, "文字出口")) add(node, rule, piece);
    }
  };
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left.getText(sourceFile);
      if (left === "document.title" || /\.(?:ariaLabel|innerText|textContent|title)$/.test(left)) checkValue(node.right);
    }
    if (ts.isNewExpression(node) && calledName(node.expression) === "Notification") {
      for (const argument of node.arguments ?? []) for (const value of objectTextValues(argument)) checkValue(value);
    }
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      const fullName = node.expression.getText(sourceFile);
      if (TEXT_SINK_CALL.test(name) || name === "toast" || /(?:^|\.)toast\.(?:error|info|success|warn|warning)$/.test(fullName)
        || name === "speak" || name === "fillText") {
        const args = name === "fillText" ? node.arguments.slice(0, 1) : node.arguments;
        for (const argument of args) for (const value of objectTextValues(argument)) checkValue(value);
      }
      if (name === "setAttribute" && node.arguments.length >= 2) {
        const attribute = node.arguments[0];
        if ((ts.isStringLiteral(attribute) || ts.isNoSubstitutionTemplateLiteral(attribute))
          && VISIBLE_ATTRIBUTES.has(attribute.text)) checkValue(node.arguments[1]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return risks;
}

/** P25 可保留必要技术契约，但必须同时具备权限路由、醒目标识和审计说明。 */
export function findDiagnosticIsolationRisks(pageSource, appSource, playwrightSource = "", industryRouteSource = "") {
  const risks = [];
  const pageFile = parseClientSource(pageSource, "apps/web/src/extensions/ai-pm/P25.tsx");
  const marked = markedDiagnosticNodes(pageFile);
  const markedSource = marked.map((node) => pageSource.slice(node.getStart(pageFile), node.getEnd())).join("\n");
  const cleanApp = stripComments(appSource);
  const cleanPlaywright = stripComments(playwrightSource);
  const cleanIndustryRoute = stripComments(industryRouteSource);
  if (marked.length === 0) risks.push("开发场域缺少真实 DOM 授权诊断隔离标识");
  if (!markedSource.includes("授权开发诊断") || !markedSource.includes("仅限已获开发权限的管理员")) risks.push("开发场域授权子树缺少面向用户的授权提示");
  if (!markedSource.includes("开发事件、围栏审计与版本台账")) risks.push("开发场域授权子树缺少可审计性说明");
  if (!/capabilityId\s*:\s*["']ai-pm\.development["']/.test(cleanIndustryRoute)
    || !/path\s*:\s*["']\/development["']/.test(cleanIndustryRoute)
    || !/legacyPaths\s*:\s*\[[^\]]*["']\/p25["'][^\]]*\]/.test(cleanIndustryRoute)) {
    risks.push("开发场域未通过行业扩展契约声明语义路由、能力权限与受控历史地址");
  }
  if (!/import\.meta\.env\.DEV\s*&&\s*import\.meta\.env\.VITE_ENABLE_UI_DIAGNOSTICS\s*===\s*["']true["']/.test(cleanApp)) risks.push("组件矩阵必须同时受开发环境与显式开关约束");
  if (!/<Route\b[^>]*path\s*=\s*["']\/dev["'][^>]*element\s*=\s*\{<UiDiagnosticsRoute\s*\/>\}/.test(cleanApp)) risks.push("组件矩阵路由不得直接渲染诊断页面");
  if (playwrightSource && !cleanPlaywright.includes("VITE_ENABLE_UI_DIAGNOSTICS=true")) risks.push("视觉测试未显式开启组件矩阵");
  return risks;
}

/** /dev 组件矩阵可保留验收术语，但必须同时具备真实 DOM 标识和双重 DEV 路由门。 */
export function findComponentMatrixIsolationRisks(matrixSource, appSource, playwrightSource = "") {
  const risks = [];
  const matrixFile = parseClientSource(matrixSource, "apps/web/src/pages/dev/DevMatrix.tsx");
  if (markedDiagnosticNodes(matrixFile, "ui-component-matrix").length === 0) {
    risks.push("组件矩阵缺少真实 DOM 授权诊断隔离标识");
  }
  if (!matrixSource.includes("仅限本地开发环境") || !matrixSource.includes("显式开启诊断开关")) {
    risks.push("组件矩阵缺少面向开发者的隔离提示");
  }
  const cleanApp = stripComments(appSource);
  const cleanPlaywright = stripComments(playwrightSource);
  if (!/import\.meta\.env\.DEV\s*&&\s*import\.meta\.env\.VITE_ENABLE_UI_DIAGNOSTICS\s*===\s*["']true["']/.test(cleanApp)) {
    risks.push("组件矩阵必须同时受开发环境与显式开关约束");
  }
  if (!/return\s+enabled\s*\?\s*<Bridge>\s*<DevMatrix\s*\/>\s*<\/Bridge>\s*:\s*<NotFound\s*\/>/.test(cleanApp)) {
    risks.push("组件矩阵守卫必须实际消费双重开关并在关闭时返回未找到页");
  }
  if (!/<Route\b[^>]*path\s*=\s*["']\/dev["'][^>]*element\s*=\s*\{<UiDiagnosticsRoute\s*\/>\}/.test(cleanApp)) {
    risks.push("组件矩阵路由不得直接渲染诊断页面");
  }
  if (playwrightSource && !cleanPlaywright.includes("VITE_ENABLE_UI_DIAGNOSTICS=true")) {
    risks.push("视觉测试未显式开启组件矩阵");
  }
  return risks;
}

export function findViewportRisks(html) {
  const risks = [];
  if (/user-scalable\s*=\s*(?:no|0)/i.test(html)) risks.push("禁止关闭页面缩放（user-scalable）");
  if (/maximum-scale\s*=\s*1(?:\.0+)?(?:\s|[,"'])/i.test(html)) risks.push("禁止把最大缩放倍率锁定为 1");
  return risks;
}

export function findEntryStyleRisks(source) {
  const risks = [];
  for (const style of ["tokens.css", "content-safety.css", "components.css"]) {
    if (!source.includes(`@workloom/ui/${style}`)) risks.push(`缺少共享样式 ${style}`);
  }
  return risks;
}

export function findContentSafetyRisks(contentSafetyCss, pcCss = "") {
  const risks = [];
  const required = [
    ["min-inline-size: 0", "交互元素缺少可收缩约束"],
    ["white-space: normal", "按钮缺少长中文换行约束"],
    ["overflow-wrap: anywhere", "动态内容缺少任意断行约束"],
    ["word-break: break-word", "动态内容缺少单词断行约束"],
    [".wl-action-row", "移动端操作组缺少堆叠约束"],
    ["white-space: pre-wrap", "代码与回执内容缺少安全换行约束"],
  ];
  for (const [needle, message] of required) {
    if (!contentSafetyCss.includes(needle)) risks.push(message);
  }
  if (/code\s*,\s*\.font-mono\s*\{[^}]*white-space\s*:\s*nowrap/is.test(pcCss)) {
    risks.push("PC 兼容样式不得强制全部等宽内容不换行");
  }
  return risks;
}

function sourceLineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function openingTags(source, startPattern) {
  const clean = stripComments(source);
  const starts = [...clean.matchAll(startPattern)];
  const tags = [];
  for (const start of starts) {
    let quote = "";
    let braces = 0;
    let index = start.index ?? 0;
    for (; index < clean.length; index += 1) {
      const char = clean[index];
      const next = clean[index + 1];
      if (quote) {
        if (char === "\\") { index += 1; continue; }
        if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
      if (char === "{") { braces += 1; continue; }
      if (char === "}") { braces = Math.max(0, braces - 1); continue; }
      if (char === ">" && braces === 0) {
        tags.push({ text: clean.slice(start.index, index + 1), offset: start.index, end: index + 1 });
        break;
      }
      if (char === "/" && next === ">" && braces === 0) {
        tags.push({ text: clean.slice(start.index, index + 2), offset: start.index, end: index + 2 });
        break;
      }
    }
  }
  return tags;
}

function interactiveOpeningTags(source) {
  return openingTags(source, /<(?:button|a|Link|input|select|textarea)\b/g);
}

function allOpeningTags(source) {
  return openingTags(source, /<[A-Za-z][\w.:~-]*\b/g);
}

/**
 * 三端业务代码只能消费共享 Icon。只有机器可读二维码、数字员工形象、动态角色与
 * 首页全息人物可以保留自绘 SVG，且必须逐个声明用途与辅助技术语义。
 */
export function findSharedIconRisks(source, fileName = "client.tsx") {
  const clean = stripComments(source);
  const normalizedFile = fileName.replaceAll("\\", "/");
  const risks = [];
  const approvedRanges = [];
  const approvedMarkers = new Set();

  for (const tag of openingTags(source, /<svg\b/g)) {
    const marker = tag.text.match(/\bdata-wl-custom-graphic\s*=\s*["']([^"']+)["']/)?.[1];
    const contract = marker ? CUSTOM_GRAPHICS[marker] : undefined;
    const closing = clean.indexOf("</svg>", tag.end);
    if (!contract || !contract.file.test(normalizedFile)) {
      risks.push({
        line: sourceLineAt(clean, tag.offset),
        rule: "客户端不得自建功能 SVG；请使用 @workloom/ui Icon，特殊图形须登记用途",
        text: marker ? `未授权图形 ${marker}` : "svg",
      });
      continue;
    }
    if (closing < 0) {
      risks.push({ line: sourceLineAt(clean, tag.offset), rule: "特殊 SVG 图形缺少闭合标签", text: marker });
      continue;
    }
    if (contract.accessible === "image" && (!/\brole\s*=\s*["']img["']/.test(tag.text) || !/\baria-label\s*=/.test(tag.text))) {
      risks.push({ line: sourceLineAt(clean, tag.offset), rule: "有信息含义的特殊图形必须声明 role=img 与中文可访问名称", text: marker });
    }
    if (contract.accessible === "decorative" && !/\baria-hidden\s*=/.test(tag.text)) {
      risks.push({ line: sourceLineAt(clean, tag.offset), rule: "装饰性特殊图形必须对辅助技术隐藏", text: marker });
    }
    if (contract.accessible === "nested") {
      if (!/\baria-hidden\s*=/.test(tag.text)) {
        risks.push({ line: sourceLineAt(clean, tag.offset), rule: "角色内部矢量必须对辅助技术隐藏", text: marker });
      }
      if (!/\brole\s*=\s*["']img["'][\s\S]{0,180}\baria-label\s*=|\baria-label\s*=[\s\S]{0,180}\brole\s*=\s*["']img["']/.test(clean)) {
        risks.push({ line: sourceLineAt(clean, tag.offset), rule: "动态角色外层必须提供 role=img 与中文可访问名称", text: marker });
      }
    }
    approvedMarkers.add(marker);
    approvedRanges.push([tag.offset, closing + "</svg>".length]);
  }

  // 允许自绘图形把复杂矢量片段拆成同文件子组件，但片段必须位于显式登记的 g 容器内，
  // 且文件中必须存在同用途、已通过辅助技术校验的根 SVG。不能借此放行文件内其他 path。
  for (const tag of openingTags(source, /<g\b/g)) {
    const marker = tag.text.match(/\bdata-wl-custom-graphic-part\s*=\s*["']([^"']+)["']/)?.[1];
    if (!marker) continue;
    const contract = CUSTOM_GRAPHICS[marker];
    const closing = clean.indexOf("</g>", tag.end);
    if (!contract || !contract.file.test(normalizedFile) || !approvedMarkers.has(marker)) {
      risks.push({
        line: sourceLineAt(clean, tag.offset),
        rule: "特殊 SVG 子图形必须与已登记的根图形同文件同用途",
        text: marker,
      });
      continue;
    }
    if (closing < 0) {
      risks.push({ line: sourceLineAt(clean, tag.offset), rule: "特殊 SVG 子图形缺少闭合标签", text: marker });
      continue;
    }
    approvedRanges.push([tag.offset, closing + "</g>".length]);
  }

  for (const match of clean.matchAll(/<path\b/g)) {
    const offset = match.index ?? 0;
    if (approvedRanges.some(([start, end]) => offset >= start && offset < end)) continue;
    risks.push({
      line: sourceLineAt(clean, offset),
      rule: "客户端不得维护独立 path 图标；请使用 @workloom/ui Icon",
      text: "path",
    });
  }

  for (const match of clean.matchAll(FUNCTIONAL_GLYPH)) {
    risks.push({
      line: sourceLineAt(clean, match.index ?? 0),
      rule: "客户端不得用表情或字体符号充当功能图标/状态编码；请使用共享 Icon 并保留文字语义",
      text: match[0],
    });
  }
  return risks;
}

/**
 * Prevent the two recurring readability regressions reported in review:
 * arbitrary 9–13px client text and compact typography on body/actionable content.
 * Caption/micro tokens remain available only on explicitly marked, non-actionable
 * metadata (`data-wl-meta`), so a future field cannot silently turn body copy small.
 */
export function findTypographyRisks(source) {
  const clean = stripComments(source);
  const risks = [];
  for (const match of clean.matchAll(/\btext-\[(\d+(?:\.\d+)?)px\]/g)) {
    const size = Number(match[1]);
    if (size >= 9 && size < 14) {
      risks.push({
        line: sourceLineAt(clean, match.index ?? 0),
        rule: "客户端不得使用 9–13px 任意字号，请使用共享字号令牌",
        text: match[0],
      });
    }
  }
  for (const match of clean.matchAll(/\bfontSize\s*:\s*([^,\n}]+)/g)) {
    const expression = match[1] ?? "";
    const sizes = [...expression.matchAll(/(?:^|[^\w.])(\d+(?:\.\d+)?)(?:px)?\b/g)].map((item) => Number(item[1]));
    if (sizes.some((size) => size >= 9 && size < 14)) {
      risks.push({
        line: sourceLineAt(clean, match.index ?? 0),
        rule: "客户端内联样式字号不得低于 14px",
        text: match[0],
      });
    }
  }
  for (const match of clean.matchAll(/\bwhiteSpace\s*:\s*["']nowrap["']/g)) {
    risks.push({
      line: sourceLineAt(clean, match.index ?? 0),
      rule: "客户端内联样式不得强制单行，动态内容必须安全换行",
      text: match[0],
    });
  }
  const tags = allOpeningTags(source);
  for (const match of clean.matchAll(/\b(?:file:)?text-(?:micro|caption|xs)\b/g)) {
    const offset = match.index ?? 0;
    const tag = tags.find((candidate) => candidate.offset <= offset && candidate.end > offset);
    const explicitlyMetadata = Boolean(tag && /\bdata-wl-meta(?:\s|=)/.test(tag.text));
    const actionable = Boolean(tag && /^<(?:button|a|Link|input|select|textarea)\b/.test(tag.text));
    if (!explicitlyMetadata || actionable) {
      risks.push({
        line: sourceLineAt(clean, offset),
        rule: actionable
          ? "正文与交互控件字号不得低于 14px"
          : "10–13px 字号仅限显式标记的非关键元数据",
        text: match[0],
      });
    }
  }
  for (const tag of tags.filter((candidate) => /\b(?:truncate|whitespace-nowrap)\b/.test(candidate.text))) {
    if (/\btitle\s*=/.test(tag.text)) continue;
    risks.push({
      line: sourceLineAt(clean, tag.offset),
      rule: "截断或强制单行内容必须提供完整文本提示，关键动态内容应直接换行",
      text: tag.text.trim().slice(0, 72),
    });
  }
  return risks;
}

export function findStylesheetLayoutRisks(source) {
  const risks = [];
  for (const match of source.matchAll(/font-size\s*:\s*(\d*\.?\d+)(px|rem)\b/gi)) {
    const numeric = Number(match[1]);
    const pixels = match[2].toLowerCase() === "rem" ? numeric * 16 : numeric;
    if (pixels >= 9 && pixels < 14) {
      risks.push({
        line: sourceLineAt(source, match.index ?? 0),
        rule: "客户端样式不得硬编码 9–13px 字号，请使用共享字号令牌",
        text: match[0],
      });
    }
  }
  for (const match of source.matchAll(/body\s*\{[^}]*\bmin-width\s*:\s*([^;}]+)/gis)) {
    if (/^0(?:px|rem)?$/i.test(match[1].trim())) continue;
    risks.push({
      line: sourceLineAt(source, match.index ?? 0),
      rule: "页面根容器不得设置固定最小宽度",
      text: `min-width: ${match[1].trim()}`,
    });
  }
  for (const match of source.matchAll(/white-space\s*:\s*nowrap\b/gi)) {
    risks.push({
      line: sourceLineAt(source, match.index ?? 0),
      rule: "客户端业务样式不得强制单行，受控省略请使用共享安全类并提供完整提示",
      text: match[0],
    });
  }
  return risks;
}

export function findIconAccessibilityRisks(source) {
  const clean = stripComments(source);
  const risks = [];

  for (const tag of openingTags(source, /<IconButton\b/g)) {
    const labelText = tag.text.match(/\blabel\s*=\s*["']([^"']*)["']/)?.[1];
    if (labelText && /[\u3400-\u9fff]/.test(labelText)) continue;
    risks.push({
      line: sourceLineAt(clean, tag.offset),
      rule: "共享 IconButton 必须提供中文 label，并由组件同步生成 aria-label 与 title",
      text: labelText || "IconButton",
    });
  }

  for (const tag of interactiveOpeningTags(source)) {
    if (!tag.text.startsWith("<button")) continue;
    const closing = clean.indexOf("</button>", tag.end);
    if (closing < 0) continue;
    const inner = clean.slice(tag.end, closing);
    const withoutMarkup = inner
      .replace(/\{[^{}]*\}/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, "")
      .trim();
    const hasDynamicText = /\{[^{}]+\}/.test(inner);
    const emojiOnly = !hasDynamicText && withoutMarkup.length > 0
      && /[\p{Extended_Pictographic}✕×＋⚙⋯⌃⌄▶◀]/u.test(withoutMarkup)
      && !/[一-鿿A-Za-z0-9]/.test(withoutMarkup);
    const iconOnly = /<Icon\b/.test(inner) && !hasDynamicText && !/<span\b/.test(inner) && withoutMarkup.length === 0;
    if (!emojiOnly && !iconOnly) continue;
    const hasAriaLabel = /\baria-label\s*=/.test(tag.text);
    const hasTitle = /\btitle\s*=/.test(tag.text);
    const ariaLabelText = tag.text.match(/\baria-label\s*=\s*(?:["']([^"']*)["']|\{([^}]*)\})/)?.slice(1).find(Boolean) ?? "";
    const titleText = tag.text.match(/\btitle\s*=\s*(?:["']([^"']*)["']|\{([^}]*)\})/)?.slice(1).find(Boolean) ?? "";
    const chineseNames = /[\u3400-\u9fff]/.test(ariaLabelText) && /[\u3400-\u9fff]/.test(titleText);
    if (hasAriaLabel && hasTitle && chineseNames) continue;
    risks.push({
      line: sourceLineAt(clean, tag.offset),
      rule: !hasAriaLabel || !hasTitle
        ? "纯图标按钮必须同时提供中文 aria-label 与 title"
        : "纯图标按钮的 aria-label 与 title 必须使用中文可读名称",
      text: withoutMarkup || "Icon",
    });
  }
  return risks;
}
