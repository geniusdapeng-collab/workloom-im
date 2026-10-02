"use strict";

// Strict recognizer for the controlled Vite head marker, shared by bootstrap,
// installation acceptance and native smoke. This is not a general HTML parser.
// No filesystem, network, Electron or product-specific imports are permitted.

function hasControlledProductMarker(html, productId) {
  if (typeof html !== "string" || typeof productId !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(productId)) return false;
  const expectedMarker = `<meta name="workloom-product-id" content="${productId}">`;
  const markers = [];
  const rawTextTags = new Set(["script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes", "noscript"]);
  const headTags = new Set(["meta", "link", "title", "style", "script", "base", "noscript", "template"]);
  let offset = 0;
  let headOpen = false;
  let headSeen = false;
  let templateDepth = 0;
  while (offset < html.length) {
    const start = html.indexOf("<", offset);
    if (start < 0) break;
    if (!templateDepth && html.slice(offset, start).trim()) return false;
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      if (end < 0) return false;
      offset = end + 3;
      continue;
    }
    let end = start + 1;
    let quote = null;
    for (; end < html.length; end += 1) {
      const character = html[end];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (end === html.length) return false;
    const tag = html.slice(start, end + 1);
    offset = end + 1;
    const parsed = tag.match(/^<(\/)?([a-z][a-z0-9:-]*)(?=[\s/>])/iu);
    if (!parsed) { if (headOpen && !templateDepth) return false; continue; }
    const closing = Boolean(parsed[1]);
    const name = parsed[2].toLowerCase();
    if (!headSeen && name !== "html" && name !== "head") return false;
    if (name === "template") {
      if (closing) templateDepth = Math.max(0, templateDepth - 1);
      else templateDepth += 1;
      continue;
    }
    if (!closing && rawTextTags.has(name)) {
      if (headOpen && !templateDepth && !headTags.has(name)) return false;
      const close = new RegExp(`</${name}\\s*>`, "giu");
      close.lastIndex = offset;
      const match = close.exec(html);
      if (!match) return false;
      offset = close.lastIndex;
      continue;
    }
    if (templateDepth) continue;
    if (name === "head") {
      if (closing) return headOpen && markers.length === 1 && markers[0] === expectedMarker;
      if (headSeen) return false;
      headSeen = headOpen = true;
      continue;
    }
    if (name === "body" || (closing && name === "html")) return false;
    if (headOpen && !closing && !headTags.has(name)) return false;
    if (headOpen && !closing && name === "meta" && /\bname\s*=\s*["']workloom-product-id["']/iu.test(tag)) markers.push(tag);
  }
  return false;
}


module.exports = { hasControlledProductMarker };
