// Idea Party — deterministic canvas agent. Zero dependencies.
// Parses "agent ..." chat instructions into canvas ops. The same parser runs
// for in-party chat and for the HTTP /api/parties/:code/agent endpoint, so
// Milton (or any outside agent) programs the board through the same grammar.

export interface CanvasObj {
  id: string;
  type: "sticky" | "stroke" | "label";
  x: number;
  y: number;
  text?: string;
  color?: string;
  points?: number[];
  w?: number;
  votes?: number;
}

export type OpKind = "add" | "move" | "edit" | "del" | "vote" | "clear" | "mode";

export interface AgentOp {
  kind: OpKind;
  [k: string]: any;
}

export interface AgentResult {
  reply: string;
  ops: AgentOp[];
  /** minutes — when set, the server broadcasts a countdown timer */
  timer?: number;
}

export const COLORS = ["yellow", "pink", "blue", "green", "purple", "orange"] as const;

export const HELP =
  "I program the board. Try:\n" +
  "• agent add sticky <text> [color pink] [at 100,200]\n" +
  "• agent add label <text> [at 100,200]\n" +
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

/** Deterministic cascade spot for a new sticky. */
function cascadeSpot(objects: Record<string, CanvasObj>): { x: number; y: number } {
  const n = stickies(objects).length;
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
  objects: Record<string, CanvasObj>
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
    const votes = ss.reduce((a, s) => a + (s.votes || 0), 0);
    return {
      reply: `${ss.length} stickies, ${labels} labels, ${strokes} strokes, ${votes} votes on the board.`,
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
      if (op.obj && op.obj.id && (op.obj.type === "sticky" || op.obj.type === "stroke" || op.obj.type === "label"))
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
      }
      break;
    }
    case "del":
      delete objects[op.id];
      break;
    case "vote": {
      const o = objects[op.id];
      if (o && o.type === "sticky") o.votes = (o.votes || 0) + 1;
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
