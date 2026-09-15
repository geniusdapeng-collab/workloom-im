const VISIBLE_ATTRIBUTES = new Set([
  "alt",
  "aria-label",
  "description",
  "hint",
  "label",
  "placeholder",
  "title",
]);

const VISIBLE_PROPERTY_NAMES = new Set([
  "actionLabel",
  "desc",
  "description",
  "hint",
  "label",
  "message",
  "summary",
  "text",
  "title",
]);

const VISIBLE_SETTER = /^(?:appendAi|setBanner|setBindingError|setDone|setErr|setError|setFeedback|setMessage|setMsg|setRateError|setSiteResult|setToast)$/;
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
  "credential_health", "rule_id", "latencyMs", "inputTokens", "outputTokens",
]);
const SAFE_DISPLAY_FORMATTERS = new Set([
  "actionText", "actorText", "capabilityText", "clientChineseText", "clientIdentifierText",
  "clientStatusLabel", "clientValueText", "confidenceText", "cronText", "dictText",
  "displayNameOf", "formatDate", "formatTime", "kindLabel", "latencyText", "roleTitleOf",
  "shortId", "versionText",
]);
const AUTHORIZED_DIAGNOSTIC_FILE = /apps\/web\/src\/pages\/p25\/P25\.tsx$/;
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

/**
 * Extract only strings that can reach a client-facing text position. Comments, types,
 * imports, enum values and CSS class names are deliberately ignored so implementation
 * vocabulary can remain precise without leaking into the product surface.
 */
export function collectVisibleStrings(source, fileName = "client.tsx") {
  const clean = stripComments(source);
  const rows = [];
  const seen = new Set();

  const add = (text, offset, kind) => {
    const normalized = String(text).replace(/\s+/g, " ").trim();
    if (!normalized) return;
    const line = clean.slice(0, offset).split("\n").length;
    const key = `${line}:${kind}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ text: normalized, line, kind });
  };

  const valueOf = (match, startAt = 1) => {
    for (let i = startAt; i < match.length; i += 1) {
      if (match[i] !== undefined) return match[i];
    }
    return "";
  };

  for (const match of clean.matchAll(/>([^<>{}]+)</g)) {
    const candidate = match[1] ?? "";
    // TS 泛型同样使用尖括号；排除明显的代码片段，避免把 useState<T> 当作 JSX 文本。
    if (/^\s*[):]|^\s*[A-Za-z_$][\w$?.]*\s*\?\s*$|\b(?:const|let|Promise|useState|useEffect|setState|new|as)\b|=>|===?|&&|\|\||\?\s*\(|;\s*[A-Za-z_$]|\w+\s*\(/.test(candidate)) continue;
    add(candidate, match.index, "页面文本");
  }

  const attributes = [...VISIBLE_ATTRIBUTES].map((value) => value.replace("-", "\\-")).join("|");
  const attributePattern = new RegExp("\\b(" + attributes + ")\\s*=\\s*(?:\"([^\"\\n]*)\"|'([^'\\n]*)'|\\{\\s*`([^`]*)`\\s*\\})", "g");
  for (const match of clean.matchAll(attributePattern)) add(valueOf(match, 2), match.index, `属性 ${match[1]}`);

  const properties = [...VISIBLE_PROPERTY_NAMES].join("|");
  const propertyPattern = new RegExp("\\b(" + properties + ")\\s*:\\s*(?:\"([^\"\\n]*)\"|'([^'\\n]*)'|`([^`]*)`)", "g");
  for (const match of clean.matchAll(propertyPattern)) add(valueOf(match, 2), match.index, `展示字段 ${match[1]}`);
  const propertyFallbackPattern = new RegExp("\\b(" + properties + ")\\s*:\\s*[^,\\n}]{0,200}?\\?\\?\\s*(?:\"([^\"\\n]*)\"|'([^'\\n]*)'|`([^`]*)`)", "g");
  for (const match of clean.matchAll(propertyFallbackPattern)) add(valueOf(match, 2), match.index, `展示字段兜底 ${match[1]}`);

  const setterNames = VISIBLE_SETTER.source.replace(/^\^|\$$/g, "");
  const setterPattern = new RegExp("\\b(" + setterNames + ")\\s*\\(\\s*(?:\"([^\"\\n]*)\"|'([^'\\n]*)'|`([^`]*)`)", "g");
  for (const match of clean.matchAll(setterPattern)) add(valueOf(match, 2), match.index, `反馈 ${match[1]}`);

  const attributeFallbackPattern = new RegExp("\\b(" + attributes + ")\\s*=\\s*\\{[^}\\n]{0,200}?\\?\\?\\s*(?:\"([^\"\\n]*)\"|'([^'\\n]*)'|`([^`]*)`)\\s*\\}", "g");
  for (const match of clean.matchAll(attributeFallbackPattern)) add(valueOf(match, 2), match.index, `属性兜底 ${match[1]}`);

  for (const match of clean.matchAll(/>\s*\{[^}\n]{0,200}?\?\?\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`)\s*\}\s*</g)) {
    add(valueOf(match), match.index, "页面文本兜底");
  }

  for (const match of clean.matchAll(/\{\s*JSON\.stringify\s*\(/g)) add("JSON.stringify", match.index, "裸 JSON");

  return rows;
}

export function findVisibleLanguageRisks(source, fileName = "client.tsx") {
  const risks = [];
  const authorizedDiagnostic = AUTHORIZED_DIAGNOSTIC_FILE.test(fileName)
    && source.includes('data-wl-authorized-diagnostics="ai-pm.development"');
  for (const item of collectVisibleStrings(source, fileName)) {
    const literalText = stripTemplateInterpolations(item.text);
    if (item.kind === "裸 JSON" || item.text === "JSON.stringify") {
      risks.push({ ...item, rule: "客户端不得直接渲染裸 JSON" });
      continue;
    }
    if (ENGINEERING_CODE.test(literalText)) {
      risks.push({ ...item, rule: "客户端不得展示 P/F/E/L 工程代号" });
    }
    if ((RAW_CLIENT_TERM.test(literalText) || RAW_FIELD_SHAPE.test(literalText)) && !authorizedDiagnostic) {
      risks.push({ ...item, rule: "客户端不得展示英文底层字段或工程术语" });
    }
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

/**
 * 只分析真正位于 JSX 文本节点或可见属性中的简单表达式。通过标签上下文过滤
 * key/className/事件处理器，再跳过比较条件和已登记格式化器，避免表达式误报。
 */
export function findRawDynamicValueRisks(source, fileName = "client.tsx") {
  if (AUTHORIZED_DIAGNOSTIC_FILE.test(fileName)
    && source.includes('data-wl-authorized-diagnostics="ai-pm.development"')) return [];
  const clean = stripComments(source);
  const risks = [];
  const seen = new Set();
  const add = (expression, offset, name) => {
    const line = sourceLineAt(clean, offset);
    const key = `${line}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    risks.push({ line, text: expression.trim().slice(0, 96), rule: `客户端动态值 ${name} 必须先经过中文映射或编号脱敏` });
  };
  const check = (expression, offset) => {
    if (!expression || /=>|;/.test(expression)) return;
    const leadingCall = expression.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/)?.[1];
    if (leadingCall && (SAFE_DISPLAY_FORMATTERS.has(leadingCall) || /(?:Text|Label|Chip|Name)$/.test(leadingCall))) return;
    if (/^\s*[A-Z][A-Z0-9_]*\s*\[/.test(expression)) return;
    let inspectable = expression;
    for (const formatter of SAFE_DISPLAY_FORMATTERS) {
      inspectable = inspectable.replace(new RegExp(`\\b${formatter}\\s*\\([^()]*\\)`, "g"), "");
    }
    // 比较值只控制渲染，不等于把值显示出来。
    if (/^(?:[\w?.]+)\s*(?:===?|!==?|>=?|<=?)\s*/.test(inspectable.trim())) return;
    const trimmed = inspectable.trim();
    // 裸变量（例如 {workspaceId}）没有属性链，必须在属性链的快速返回前判定；
    // 否则最直接的底层标识泄露反而会绕过后续检查。
    const bare = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
    if (bare && RAW_DYNAMIC_FIELD.has(bare)) {
      add(expression, offset, bare);
      return;
    }
    const directChain = /^[A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*)+(?:\s*\?\?\s*[^;]+)?$/.test(trimmed);
    const directMethod = /^[A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*)+\.(?:slice|replace)\([^;]*\)$/.test(trimmed);
    if (!directChain && !directMethod) return;
    for (const match of inspectable.matchAll(/(?:\?\.|\.)\s*([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
      const name = match[1];
      if (name && RAW_DYNAMIC_FIELD.has(name)) add(expression, offset + (match.index ?? 0), name);
    }
  };

  for (const match of clean.matchAll(/>[^<\n]*\{([^{}\n]+)\}[^<\n]*</g)) {
    check(match[1] ?? "", match.index ?? 0);
  }
  const attributes = [...VISIBLE_ATTRIBUTES].map((value) => value.replace("-", "\\-")).join("|");
  const attributeExpression = new RegExp(`\\b(?:${attributes})\\s*=\\s*\\{([^{}\\n]+)\\}`, "g");
  for (const match of clean.matchAll(attributeExpression)) check(match[1] ?? "", match.index ?? 0);
  for (const item of collectVisibleStrings(source, fileName)) {
    for (const interpolation of item.text.matchAll(/\$\{([^{}]+)\}/g)) check(interpolation[1] ?? "", 0);
  }
  return risks;
}

/** P25 可保留必要技术契约，但必须同时具备权限路由、醒目标识和审计说明。 */
export function findDiagnosticIsolationRisks(pageSource, appSource, playwrightSource = "") {
  const risks = [];
  if (!pageSource.includes('data-wl-authorized-diagnostics="ai-pm.development"')) risks.push("开发场域缺少授权诊断隔离标识");
  if (!pageSource.includes("授权开发诊断") || !pageSource.includes("仅限已获开发权限的管理员")) risks.push("开发场域缺少面向用户的授权提示");
  if (!pageSource.includes("开发事件、围栏审计与版本台账")) risks.push("开发场域缺少可审计性说明");
  if (!appSource.includes('<NavigationCapabilityBoundary capabilityId="ai-pm.development"><P25 /></NavigationCapabilityBoundary>')) risks.push("开发场域直达路由未受行业能力权限约束");
  if (!appSource.includes('import.meta.env.DEV && import.meta.env.VITE_ENABLE_UI_DIAGNOSTICS === "true"')) risks.push("组件矩阵必须同时受开发环境与显式开关约束");
  if (!appSource.includes('<Route path="/dev" element={<UiDiagnosticsRoute />} />')) risks.push("组件矩阵路由不得直接渲染诊断页面");
  if (playwrightSource && !playwrightSource.includes("VITE_ENABLE_UI_DIAGNOSTICS=true")) risks.push("视觉测试未显式开启组件矩阵");
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
