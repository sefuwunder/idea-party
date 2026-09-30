// Idea Party — deterministic canvas agent. Zero dependencies.
// Parses "agent ..." chat instructions into canvas ops. The same parser runs
// for in-party chat and for the HTTP /api/parties/:code/agent endpoint, so
// Milton (or any outside agent) programs the board through the same grammar.

import { type WidgetTypeSpec, validateWidgetName } from "./widgets";

export interface PollOption {
  label: string;
  votes: number;
}

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export interface CanvasObj {
  id: string;
  type: "sticky" | "stroke" | "label" | "widget";
  x: number;
  y: number;
  text?: string;
  color?: string;
  points?: number[];
  w?: number;
  votes?: number;
  /** widget kind — only when type === "widget"; "poll"/"checklist" are built-in, anything else is a custom WidgetTypeSpec name */
  widget?: string;
  /** widget payload */
  data?: {
    options?: PollOption[];
    items?: ChecklistItem[];
    [k: string]: any;
  };
}

export type OpKind = "add" | "move" | "edit" | "del" | "vote" | "toggle" | "clear" | "mode";

export interface AgentOp {
  kind: OpKind;
  [k: string]: any;
}

export interface AgentResult {
  reply: string;
  ops: AgentOp[];
  /** minutes — when set, the server broadcasts a countdown timer */
  timer?: number;
  /** widget-type lifecycle action — handled by the server, not a canvas op */
  widgetType?: WidgetTypeAction;
}

/** A widget-type lifecycle request from the agent grammar. */
export interface WidgetTypeAction {
  action: "propose" | "publish" | "unpublish";
  name: string;
  /** for propose: human description used to scaffold the draft */
  description?: string;
  /** for propose: pre-built spec (the server fills in anything missing) */
  spec?: WidgetTypeSpec;
}

export const COLORS = ["yellow", "pink", "blue", "green", "purple", "orange"] as const;

export const HELP =
  "I program the board. Try:\n" +
  "• agent add sticky <text> [color pink] [at 100,200]\n" +
  "• agent add label <text> [at 100,200]\n" +
  "• agent add widget poll <question> | <opt1> | <opt2> [| …]\n" +
  "• agent add widget checklist <title> | <item1> | <item2> [| …]\n" +
  "• agent add widget <type> <title> [| values…]  (custom types)\n" +
  "• agent build widget <name> \"<description>\"  (scaffold a new widget type)\n" +
  "• agent widgets · agent publish widget <name>\n" +
  "• agent move <id or words> to <x>,<y>\n" +
  "• agent delete <id or words> · agent color <id or words> <color>\n" +
  "• agent arrange · agent cluster · agent count\n" +
  "• agent vote start · agent vote stop · agent tally\n" +
  "• agent timer <minutes> · agent clear yes";

function newId(prefix: string): string {
  return (
    prefix +
    Date.now().toString(36) +
    Math.floor(Math.random() * 0xffffff).toString(36)
  );
}

function clampNum(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** First object whose id starts with q, else whose text contains q. */
export function findMatch(
  q: string,
  objects: Record<string, CanvasObj>
): { id: string; ambiguous: number } | null {
  const needle = q.trim().toLowerCase();
  if (!needle) return null;
  const ids = Object.keys(objects);
  const byId = ids.filter((id) => id.toLowerCase().startsWith(needle));
  if (byId.length) return { id: byId[0], ambiguous: byId.length };
  const byText = ids.filter((id) =>
    (objects[id].text || "").toLowerCase().includes(needle)
  );
  if (byText.length) return { id: byText[0], ambiguous: byText.length };
  return null;
}

function stickies(objects: Record<string, CanvasObj>): CanvasObj[] {
  return Object.values(objects)
    .filter((o) => o.type === "sticky")
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Deterministic cascade spot for a new sticky/widget. */
function cascadeSpot(objects: Record<string, CanvasObj>): { x: number; y: number } {
  const n = Object.values(objects).filter((o) => o.type === "sticky" || o.type === "widget").length;
  return { x: 80 + (n % 5) * 250, y: 90 + Math.floor(n / 5) * 210 };
}

const AT_RE = /\bat\s+(-?\d+)\s*,\s*(-?\d+)/i;
const COLOR_RE = /\bcolor\s+(yellow|pink|blue|green|purple|orange)\b/i;

function stripAgentPrefix(input: string): string {
  return input
    .trim()
    .replace(/^@?agent\s*:\s*/i, "")
    .replace(/^@?agent\s+/i, "")
    .trim();
}

export function parseAgentCommand(
  input: string,
  objects: Record<string, CanvasObj>,
  wtypes: WidgetTypeSpec[] = []
): AgentResult {
  const cmd = stripAgentPrefix(input);
  const low = cmd.toLowerCase();

  if (!cmd || low === "help" || low === "?") return { reply: HELP, ops: [] };

  // ---- add sticky / add label ----
  let m = cmd.match(/^add\s+(sticky|note)\b\s*([\s\S]*)$/i);
  if (m) {
    let rest = m[2].trim();
    const atM = rest.match(AT_RE);
    const colorM = rest.match(COLOR_RE);
    rest = rest.replace(AT_RE, "").replace(COLOR_RE, "").trim();
    if (!rest) return { reply: "Give the sticky some text: `agent add sticky <text>`.", ops: [] };
    const spot = atM
      ? { x: clampNum(+atM[1], -2000, 4000), y: clampNum(+atM[2], -2000, 4000) }
      : cascadeSpot(objects);
    const color = colorM ? colorM[1].toLowerCase() : "yellow";
    const obj: CanvasObj = {
      id: newId("s"),
      type: "sticky",
      x: spot.x,
      y: spot.y,
      text: rest.slice(0, 500),
      color,
      votes: 0,
    };
    return { reply: `Added “${obj.text}”.`, ops: [{ kind: "add", obj }] };
  }
  m = cmd.match(/^add\s+label\s+([\s\S]+)$/i);
  if (m) {
    let rest = m[1].trim();
    const atM = rest.match(AT_RE);
    rest = rest.replace(AT_RE, "").trim();
    if (!rest) return { reply: "Give the label some text: `agent add label <text>`.", ops: [] };
    const obj: CanvasObj = {
      id: newId("l"),
      type: "label",
      x: atM ? clampNum(+atM[1], -2000, 4000) : 80,
      y: atM ? clampNum(+atM[2], -2000, 4000) : 40,
      text: rest.slice(0, 200),
    };
    return { reply: `Labeled “${obj.text}”.`, ops: [{ kind: "add", obj }] };
  }

  // ---- add widget (poll / checklist) ----
  // agent add widget poll <question> | <opt1> | <opt2> [| ...]
  // agent add widget checklist <title> | <item1> | <item2> [| ...]
  m = cmd.match(/^add\s+widget\s+(poll|checklist)\s+([\s\S]+)$/i);
  if (m) {
    const kind = m[1].toLowerCase() as "poll" | "checklist";
    let rest = m[2];
    const atM = rest.match(AT_RE);
    rest = rest.replace(AT_RE, "");
    const parts = rest.split("|").map((s) => s.trim()).filter((s) => s.length > 0);
    const title = (parts.shift() || "").slice(0, 120);
    const entries = parts.map((s) => s.slice(0, 60));
    if (!title)
      return { reply: `Give the ${kind} a title: \`agent add widget ${kind} <title> | <a> | <b>\`.`, ops: [] };
    if (entries.length < 2)
      return { reply: `A ${kind} needs at least 2 entries separated by |: \`agent add widget ${kind} ${title} | <a> | <b>\`.`, ops: [] };
    if (entries.length > 8)
      return { reply: `Keep it to 8 entries max — trim the list and try again.`, ops: [] };
    const spot = atM
      ? { x: clampNum(+atM[1], -2000, 4000), y: clampNum(+atM[2], -2000, 4000) }
      : cascadeSpot(objects);
    const obj: CanvasObj = {
      id: newId("w"),
      type: "widget",
      widget: kind,
      x: spot.x,
      y: spot.y,
      text: title,
      data: kind === "poll"
        ? { options: entries.map((label) => ({ label, votes: 0 })) }
        : { items: entries.map((text) => ({ text, done: false })) },
    };
    const noun = kind === "poll" ? "poll" : "checklist";
    return { reply: `Added ${noun} “${title}” with ${entries.length} entries — tap to ${kind === "poll" ? "vote" : "check things off"}.`, ops: [{ kind: "add", obj }] };
  }

  // ---- add widget (custom type) ----
  // agent add widget <type> <title> [| <field values…>] [at x,y]
  m = cmd.match(/^add\s+widget\s+([a-z0-9-]+)\s*([\s\S]*)$/i);
  if (m) {
    const kind = m[1].toLowerCase();
    if (kind === "poll" || kind === "checklist")
      return { reply: `Usage: \`agent add widget ${kind} <title> | <a> | <b>\`.`, ops: [] };
    const type = wtypes.find((t) => t.name === kind);
    if (!type)
      return { reply: `No widget type “${kind}”. Say \`agent widgets\` to see what's available, or \`agent build widget ${kind} "<description>"\` to start one.`, ops: [] };
    if (type.status !== "active")
      return { reply: `“${type.title}” is still a draft — publish it first (\`agent publish widget ${kind}\`) or preview it in the 🧪 Widget Lab.`, ops: [] };
    let rest = m[2] || "";
    const atM = rest.match(AT_RE);
    rest = rest.replace(AT_RE, "");
    const parts = rest.split("|").map((s) => s.trim()).filter((s) => s.length > 0);
    const title = (parts.shift() || type.title).slice(0, 120);
    const entries = parts.map((s) => s.slice(0, 120));
    const spot = atM
      ? { x: clampNum(+atM[1], -2000, 4000), y: clampNum(+atM[2], -2000, 4000) }
      : cascadeSpot(objects);
    const data: Record<string, any> = { ...(type.example || {}) };
    type.fields.forEach((f, i) => {
      if (entries[i] !== undefined) data[f.key] = entries[i];
    });
    const obj: CanvasObj = {
      id: newId("w"),
      type: "widget",
      widget: kind,
      x: spot.x,
      y: spot.y,
      text: title,
      data,
    };
    return { reply: `Added ${type.title} “${title}”.`, ops: [{ kind: "add", obj }] };
  }

  // ---- build widget: scaffold a new widget type (draft) ----
  // agent build widget <name> "<description>"
  m = cmd.match(/^build\s+widget\s+([a-z0-9-]+)\s*([\s\S]*)$/i);
  if (m) {
    const name = m[1].toLowerCase();
    let description = (m[2] || "").trim().replace(/^["“”]/, "").replace(/["“”]$/, "").trim();
    const nameErr = validateWidgetName(name);
    if (nameErr) return { reply: `Can't use that name: ${nameErr}`, ops: [] };
    if (wtypes.some((t) => t.name === name))
      return { reply: `There's already a widget type called “${name}”. Say \`agent widgets\` to see them all.`, ops: [] };
    if (!description) description = "a custom mini app";
    return {
      reply: `Scaffolding “${name}” — I'll draft the starter code, then you (or @spark) can shape it in the 🧪 Widget Lab.`,
      ops: [],
      widgetType: { action: "propose", name, description },
    };
  }

  // ---- widgets: list widget types ----
  if (/^widgets$/.test(low)) {
    if (!wtypes.length)
      return { reply: "No custom widget types yet. Try `agent build widget scoreboard \"two teams, +1 buttons\"`.", ops: [] };
    const lines = wtypes.map((t) =>
      `• ${t.name} — ${t.title} [${t.status}]${t.description ? ": " + t.description.slice(0, 80) : ""}`
    );
    return { reply: "Widget types:\n" + lines.join("\n"), ops: [] };
  }

  // ---- publish / unpublish widget ----
  m = cmd.match(/^(publish|unpublish)\s+widget\s+([a-z0-9-]+)\s*$/i);
  if (m) {
    const name = m[2].toLowerCase();
    const type = wtypes.find((t) => t.name === name);
    if (!type) return { reply: `No widget type “${name}”.`, ops: [] };
    const toActive = m[1].toLowerCase() === "publish";
    if (toActive && type.status === "active") return { reply: `“${type.title}” is already live.`, ops: [] };
    if (!toActive && type.status === "draft") return { reply: `“${type.title}” is already a draft.`, ops: [] };
    return {
      reply: toActive
        ? `Publishing “${type.title}” — it'll be addable with \`agent add widget ${name} <title>\`.`
        : `Unpublished “${type.title}” — back to draft.`,
      ops: [],
      widgetType: { action: toActive ? "publish" : "unpublish", name },
    };
  }

  // ---- move ----
  m = cmd.match(/^move\s+([\s\S]+?)\s+to\s+(-?\d+)\s*,\s*(-?\d+)\s*$/i);
  if (m) {
    const hit = findMatch(m[1], objects);
    if (!hit) return { reply: `Couldn't find “${m[1]}” on the board.`, ops: [] };
    const x = clampNum(+m[2], -2000, 4000), y = clampNum(+m[3], -2000, 4000);
    const note = hit.ambiguous > 1 ? ` (${hit.ambiguous} matched — moved the first)` : "";
    return { reply: `Moved it to ${x},${y}.${note}`, ops: [{ kind: "move", id: hit.id, x, y }] };
  }

  // ---- delete ----
  m = cmd.match(/^(delete|remove)\s+([\s\S]+)$/i);
  if (m) {
    const hit = findMatch(m[2], objects);
    if (!hit) return { reply: `Couldn't find “${m[2]}” on the board.`, ops: [] };
    return { reply: "Deleted.", ops: [{ kind: "del", id: hit.id }] };
  }

  // ---- color ----
  m = cmd.match(/^colou?r\s+([\s\S]+?)\s+(yellow|pink|blue|green|purple|orange)\s*$/i);
  if (m) {
    const hit = findMatch(m[1], objects);
    if (!hit) return { reply: `Couldn't find “${m[1]}” on the board.`, ops: [] };
    return {
      reply: `Recolored to ${m[2].toLowerCase()}.`,
      ops: [{ kind: "edit", id: hit.id, patch: { color: m[2].toLowerCase() } }],
    };
  }

  // ---- arrange: tidy grid ----
  if (/^arrange$/.test(low)) {
    const ss = stickies(objects);
    if (!ss.length) return { reply: "Nothing to arrange yet — add some stickies first.", ops: [] };
    const cols = Math.max(1, Math.ceil(Math.sqrt(ss.length)));
    const ops: AgentOp[] = ss.map((s, i) => ({
      kind: "move",
      id: s.id,
      x: 80 + (i % cols) * 250,
      y: 90 + Math.floor(i / cols) * 210,
    }));
    return { reply: `Arranged ${ss.length} stickies into a grid.`, ops };
  }

  // ---- cluster: group by color into labeled columns ----
  if (/^cluster$/.test(low)) {
    const ss = stickies(objects);
    if (!ss.length) return { reply: "Nothing to cluster yet — add some stickies first.", ops: [] };
    const byColor: Record<string, CanvasObj[]> = {};
    for (const s of ss) {
      const c = s.color || "yellow";
      (byColor[c] = byColor[c] || []).push(s);
    }
    const order = [...COLORS].filter((c) => byColor[c]);
    const ops: AgentOp[] = [];
    order.forEach((c, ci) => {
      const group = byColor[c];
      ops.push({
        kind: "add",
        obj: { id: `zone-${c}`, type: "label", x: 80 + ci * 280, y: 30, text: `${c} · ${group.length}` },
      });
      group.forEach((s, ri) => {
        ops.push({ kind: "move", id: s.id, x: 80 + ci * 280, y: 90 + ri * 210 });
      });
    });
    return { reply: `Clustered ${ss.length} stickies into ${order.length} color groups.`, ops };
  }

  // ---- voting ----
  if (/^vote\s+start$/.test(low))
    return { reply: "Voting is open — tap +1 on your favorites, then `agent tally`.", ops: [{ kind: "mode", key: "vote", value: true }] };
  if (/^vote\s+stop$/.test(low))
    return { reply: "Voting is closed.", ops: [{ kind: "mode", key: "vote", value: false }] };
  if (/^tally$/.test(low)) {
    const ranked = stickies(objects)
      .filter((s) => (s.votes || 0) > 0)
      .sort((a, b) => (b.votes || 0) - (a.votes || 0));
    if (!ranked.length) return { reply: "No votes yet.", ops: [] };
    const lines = ranked.slice(0, 8).map((s, i) => `${i + 1}. “${s.text}” — ${s.votes} vote${s.votes === 1 ? "" : "s"}`);
    return { reply: "Top voted:\n" + lines.join("\n"), ops: [] };
  }

  // ---- timer ----
  m = cmd.match(/^timer\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minutes)?$/i);
  if (m) {
    const mins = parseFloat(m[1]);
    if (!(mins > 0 && mins <= 120))
      return { reply: "Timer needs 0–120 minutes: `agent timer 5`.", ops: [] };
    return { reply: `Timer set for ${mins} minute${mins === 1 ? "" : "s"}.`, ops: [], timer: mins };
  }

  // ---- clear (two-step, it's destructive) ----
  if (/^clear$/.test(low))
    return { reply: "This wipes the whole board. Say `agent clear yes` to confirm.", ops: [] };
  if (/^clear\s+yes$/.test(low))
    return { reply: "Board cleared.", ops: [{ kind: "clear" }] };

  // ---- count / summary ----
  if (/^(count|summar(y|ize)|summary|stats)$/.test(low)) {
    const ss = stickies(objects);
    const labels = Object.values(objects).filter((o) => o.type === "label").length;
    const strokes = Object.values(objects).filter((o) => o.type === "stroke").length;
    const widgets = Object.values(objects).filter((o) => o.type === "widget").length;
    const votes = ss.reduce((a, s) => a + (s.votes || 0), 0);
    const widgetBits = widgets
      ? `, ${widgets} widget${widgets === 1 ? "" : "s"}`
      : "";
    return {
      reply: `${ss.length} stickies, ${labels} labels, ${strokes} strokes${widgetBits}, ${votes} votes on the board.`,
      ops: [],
    };
  }

  return {
    reply: `I didn't understand that. Say \`agent help\` for what I can do.`,
    ops: [],
  };
}

/** Fold one op into the object map (shared by server + tests). */
export function applyOp(objects: Record<string, CanvasObj>, op: AgentOp): void {
  switch (op.kind) {
    case "add":
      if (op.obj && op.obj.id && (op.obj.type === "sticky" || op.obj.type === "stroke" || op.obj.type === "label" || op.obj.type === "widget"))
        objects[op.obj.id] = { votes: 0, ...op.obj };
      break;
    case "move": {
      const o = objects[op.id];
      if (o && Number.isFinite(op.x) && Number.isFinite(op.y)) { o.x = op.x; o.y = op.y; }
      break;
    }
    case "edit": {
      const o = objects[op.id];
      if (o && op.patch && typeof op.patch === "object") {
        if (typeof op.patch.text === "string") o.text = op.patch.text.slice(0, 500);
        if (typeof op.patch.color === "string") o.color = op.patch.color;
        // Custom widget state: full data replacement (validated server-side).
        // Built-ins (poll/checklist) use vote/toggle ops instead.
        if (o.type === "widget" && o.widget !== "poll" && o.widget !== "checklist" &&
            op.patch.data && typeof op.patch.data === "object" && !Array.isArray(op.patch.data)) {
          o.data = op.patch.data;
        }
      }
      break;
    }
    case "del":
      delete objects[op.id];
      break;
    case "vote": {
      const o = objects[op.id];
      if (!o) break;
      if (o.type === "widget" && o.widget === "poll" && Number.isInteger(op.option)) {
        const opts = o.data?.options;
        if (opts && opts[op.option]) opts[op.option].votes = (opts[op.option].votes || 0) + 1;
      } else if (o.type === "sticky" && op.option === undefined) {
        o.votes = (o.votes || 0) + 1;
      }
      break;
    }
    case "toggle": {
      const o = objects[op.id];
      const items = o && o.type === "widget" && o.widget === "checklist" ? o.data?.items : null;
      if (items && Number.isInteger(op.index) && items[op.index]) {
        items[op.index].done = !items[op.index].done;
      }
      break;
    }
    case "clear":
      for (const k of Object.keys(objects)) delete objects[k];
      break;
    // "mode" is UI state, not board state — clients handle it, fold ignores it.
  }
}

export function foldOps(ops: AgentOp[]): Record<string, CanvasObj> {
  const objects: Record<string, CanvasObj> = {};
  for (const op of ops) applyOp(objects, op);
  return objects;
}
