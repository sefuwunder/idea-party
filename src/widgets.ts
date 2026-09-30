// Idea Party — custom widget types ("mini apps").
// A widget type is a small sandboxed app: an HTML/JS bundle that renders a
// widget instance's `data` and calls api.setState() when the user interacts.
// Instances are ordinary canvas objects ({type:"widget", widget:<name>,
// data:{...}}), so they get move/delete/edit ops like everything else.
//
// Collaboration model:
//   - the local agent scaffolds drafts:  `agent build widget <name> "<desc>"`
//   - the LLM (Spark) writes/refines the code: propose_widget / refine_widget
//   - the user previews in the 🧪 Widget Lab, hand-edits, and publishes
// Only "active" types can be added to the board. Code runs in a sandboxed
// iframe (allow-scripts, no allow-same-origin) with a CSP that blocks all
// network — a widget can only talk to its parent frame via postMessage.
//
// This module is dependency-free so it can be bundled for the browser
// (public/widgets-lib.js is built from it via `bun build`).

export interface WidgetField {
  key: string;
  label: string;
}

export interface WidgetTypeSpec {
  name: string;
  title: string;
  description: string;
  status: "draft" | "active";
  fields: WidgetField[];
  example: Record<string, any>;
  style: string;
  script: string;
  height: number;
  version: number;
  created_by: string;
  updated_at: number;
}

/** Max JSON bytes for a widget instance's data (op payloads stay small). */
export const WIDGET_DATA_LIMIT = 16384;
export const WIDGET_SCRIPT_LIMIT = 32768;
export const WIDGET_STYLE_LIMIT = 16384;

/** Built-in kinds are reserved — custom types can't shadow them. */
export const RESERVED_KINDS = ["poll", "checklist"];

export function validateWidgetName(name: string): string | null {
  if (!/^[a-z0-9-]{2,24}$/.test(name || ""))
    return "name must be 2–24 chars: lowercase letters, numbers, dashes.";
  if (RESERVED_KINDS.includes(name)) return `"${name}" is a built-in widget kind.`;
  return null;
}

/** Plain JSON-ish object (no arrays at top, no prototype pollution keys). */
export function isPlainData(v: any): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  for (const k of Object.keys(v)) {
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]{0,31}$/.test(k)) return false;
    if (k === "__proto__" || k === "prototype" || k === "constructor") return false;
  }
  return true;
}

export function dataSizeOk(v: any): boolean {
  try {
    return JSON.stringify(v).length <= WIDGET_DATA_LIMIT;
  } catch {
    return false;
  }
}

/** Validate a full widget type spec. Returns an error string or null. */
export function validateWidgetType(t: any): string | null {
  if (!t || typeof t !== "object") return "widget type must be an object.";
  const nameErr = validateWidgetName(t.name);
  if (nameErr) return nameErr;
  if (typeof t.title !== "string" || !t.title.trim() || t.title.length > 60)
    return "title is required (max 60 chars).";
  if (typeof t.description !== "string" || t.description.length > 500)
    return "description max 500 chars.";
  if (!["draft", "active"].includes(t.status)) return "status must be draft or active.";
  if (!Array.isArray(t.fields) || t.fields.length > 8) return "fields must be an array (max 8).";
  for (const f of t.fields) {
    if (!f || typeof f !== "object") return "each field needs {key, label}.";
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/.test(f.key || "")) return `bad field key "${f.key}".`;
    if (typeof f.label !== "string" || !f.label.trim() || f.label.length > 40)
      return `field "${f.key}" needs a label (max 40 chars).`;
  }
  if (!isPlainData(t.example)) return "example must be a plain object with safe keys.";
  if (!dataSizeOk(t.example)) return "example data too large (16KB max).";
  if (typeof t.style !== "string" || t.style.length > WIDGET_STYLE_LIMIT)
    return "style too large (16KB max).";
  if (typeof t.script !== "string" || !t.script.trim() || t.script.length > WIDGET_SCRIPT_LIMIT)
    return "script is required (32KB max).";
  if (!/function\s+render\s*\(/.test(t.script)) return "script must define function render(state).";
  if (!Number.isInteger(t.height) || t.height < 120 || t.height > 800)
    return "height must be 120–800.";
  return null;
}

/** Escape a value for embedding inside a <script> block. */
function jsStr(v: any): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

/**
 * Deterministic starter mini-app. The local agent uses this for
 * `agent build widget <name> "<description>"`; the LLM or user refines it.
 */
export function scaffoldWidgetType(
  name: string,
  description: string,
  by: string
): WidgetTypeSpec {
  const desc = (description || "a custom mini app").slice(0, 500);
  const script = [
    `// ${name} — ${desc}`,
    `// Edit render(state) to draw the widget. Wire up taps in bind(root, api).`,
    `// api.state is the current data; api.setState(newData) saves it and`,
    `// broadcasts to everyone in the party.`,
    `function render(state) {`,
    `  const rows = Object.entries(state || {})`,
    `    .map(([k, v]) => '<div class="kv"><span>' + esc(k) + '</span><b>' + esc(String(v)) + '</b></div>')`,
    `    .join("");`,
    `  return '<div class="wbody">' + rows + '<button data-act="bump">+1 count</button></div>';`,
    `}`,
    `function bind(root, api) {`,
    `  const b = root.querySelector('[data-act="bump"]');`,
    `  if (b) b.onclick = () => {`,
    `    const s = Object.assign({}, api.state);`,
    `    s.count = (s.count || 0) + 1;`,
    `    api.setState(s);`,
    `  };`,
    `}`,
  ].join("\n");
  const style = [
    `.wbody { padding: 6px 2px; font-size: 14px; }`,
    `.kv { display: flex; justify-content: space-between; padding: 6px 8px;`,
    `  background: rgba(255,255,255,.06); border-radius: 8px; margin-bottom: 6px; }`,
    `.kv b { font-variant-numeric: tabular-nums; }`,
    `.wbody button { width: 100%; padding: 9px; border-radius: 10px; border: 1px solid rgba(255,255,255,.18);`,
    `  background: rgba(245,181,68,.22); color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; }`,
    `.wbody button:active { transform: scale(.98); }`,
    `.werr { color: #ff9a9a; font-size: 13px; padding: 12px; }`,
  ].join("\n");
  return {
    name,
    title: name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    description: desc,
    status: "draft",
    fields: [],
    example: { count: 0 },
    style,
    script,
    height: 220,
    version: 1,
    created_by: by || "",
    updated_at: Date.now(),
  };
}

/**
 * Build the sandboxed iframe srcdoc for one widget instance.
 * The host preamble provides: esc(), `state`, api.setState(), and the
 * postMessage plumbing. Author code must define render(state).
 */
export function buildWidgetSrcdoc(
  type: Pick<WidgetTypeSpec, "style" | "script">,
  widgetId: string,
  data: any
): string {
  const safeData = isPlainData(data) ? data : {};
  const head =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">' +
    "<style>" +
    "html,body{margin:0;padding:8px;background:transparent;color:#f2ecff;" +
    "font:14px/1.45 -apple-system,system-ui,sans-serif;}" +
    (type.style || "") +
    "</style></head><body><div id=\"wroot\"></div><script>" +
    '"use strict";' +
    "var WID=" + jsStr(widgetId) + ";" +
    "var state=" + jsStr(safeData) + ";" +
    "function esc(s){return String(s==null?\"\":s).replace(/[&<>\"']/g,function(c)" +
    "{return {\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\"}[c];});}" +
    "var api={get state(){return state;}," +
    "setState:function(ns){if(!ns||typeof ns!==\"object\"||Array.isArray(ns))return;" +
    "try{if(JSON.stringify(ns).length>" + WIDGET_DATA_LIMIT + ")return;}catch(e){return;}" +
    "state=ns;draw();" +
    "parent.postMessage({t:\"ip-widget-set\",id:WID,data:ns},\"*\");}};" +
    "function draw(){var root=document.getElementById(\"wroot\");" +
    "try{root.innerHTML=render(state);" +
    "if(typeof bind===\"function\")bind(root,api);}catch(e)" +
    "{root.innerHTML='<div class=\"werr\">widget error</div>';}" +
    "reportH();}" +
    "var lastH=0;" +
    "function reportH(){try{var h=Math.ceil(document.documentElement.scrollHeight);" +
    "if(Math.abs(h-lastH)>2){lastH=h;" +
    "parent.postMessage({t:\"ip-widget-resize\",id:WID,height:h},\"*\");}}catch(e){}}" +
    "window.addEventListener(\"load\",reportH);" +
    "window.addEventListener(\"message\",function(e){" +
    "var d=e.data||{};" +
    "if(d.t===\"ip-widget-state\"&&d.id===WID&&d.data&&typeof d.data===\"object\")" +
    "{state=d.data;draw();}});";
  const tail = "draw();</" + "script></body></html>";
  return head + "\n" + (type.script || "") + "\n" + tail;
}
