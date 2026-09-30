// Idea Party — ✨ Spark, the Muse Spark party participant.
// "@spark ..." in chat summons Spark (Meta Model API, model muse-spark-1.3).
// Spark converses and programs the board through OpenAI-compatible function
// calling. Every tool compiles down to the deterministic agent grammar
// (src/agent.ts), so Spark can only do what "@agent ..." can do — the same
// validation, confirmations, and guardrails apply. Destructive "clear" is
// deliberately NOT exposed as a tool.
//
// The API key lives on the Settings screen / MODEL_API_KEY env — never in
// chat, never in logs, never echoed back to clients.

import {
  parseAgentCommand,
  findMatch,
  type AgentOp,
  type CanvasObj,
} from "./agent";
import {
  type WidgetTypeSpec,
  validateWidgetType,
  validateWidgetName,
  scaffoldWidgetType,
  isPlainData,
  dataSizeOk,
} from "./widgets";

export const SPARK_MODEL = "muse-spark-1.3";
export const SPARK_API_URL = "https://api.meta.ai/v1/chat/completions";
export const SPARK_KEY_ID = "MODEL_API_KEY";

export const SPARK_KEY_DEF = {
  id: SPARK_KEY_ID,
  name: "Meta Model API",
  benefit: "powers the ✨ Spark party participant (Muse Spark answers chat and programs the board)",
  signup: "https://dev.meta.ai/",
  signupLabel: "API key at dev.meta.ai",
};

export interface ChatMsg {
  from: string;
  name: string;
  text: string;
  ts: number;
}

/** Everything spark.ts needs from the server, injected for testability. */
export interface SparkDeps {
  resolveKey(id: string): string;
  boardObjects(): Record<string, CanvasObj>;
  recentChat(limit: number): ChatMsg[];
  partyName(): string;
  validOp(op: any): op is AgentOp;
  applyOp(op: AgentOp): void;
  setTimer(minutes: number, by: string): void;
  postChat(fromId: string, fromName: string, text: string): void;
  fetchImpl?: typeof fetch;
  /** Custom widget-type registry for this party. */
  widgetTypes(): WidgetTypeSpec[];
  /** Save a full spec (propose). Returns error or null. */
  saveWidgetType(t: WidgetTypeSpec, by: string): string | null;
  /** Patch a draft's content. Returns error or null. */
  updateWidgetType(name: string, patch: Partial<WidgetTypeSpec>): string | null;
  /** Publish/unpublish. Returns error or null. */
  setWidgetTypeStatus(name: string, status: "draft" | "active"): string | null;
}

/** A widget-type lifecycle request from a Spark tool call. */
export interface SparkWidgetAction {
  kind: "propose" | "refine" | "publish" | "unpublish";
  name: string;
  spec?: WidgetTypeSpec;
  patch?: Partial<WidgetTypeSpec>;
  status?: "draft" | "active";
}

const SPARK_PREFIX_RE = /^\s*@?spark(?:\s*[: ]|$)/i;

export function stripSparkPrefix(input: string): string {
  return input.replace(SPARK_PREFIX_RE, "").trim();
}

export function isSparkMention(text: string): boolean {
  return SPARK_PREFIX_RE.test(text);
}

// ---------------------------------------------------------------------------
// Tools: thin wrappers over the deterministic agent grammar.
// ---------------------------------------------------------------------------

function fn(name: string, description: string, properties: any, required: string[]) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
  };
}

const COLOR_ENUM = ["yellow", "pink", "blue", "green", "purple", "orange"];

export const SPARK_TOOLS = [
  fn("add_sticky", "Add a sticky note to the board.", {
    text: { type: "string", description: "The note text (max ~80 chars works best)." },
    color: { type: "string", enum: COLOR_ENUM, description: "Sticky color. Default yellow." },
    x: { type: "number", description: "Board x coordinate. Omit for an automatic spot." },
    y: { type: "number", description: "Board y coordinate. Omit for an automatic spot." },
  }, ["text"]),
  fn("add_label", "Add a section label to the board.", {
    text: { type: "string", description: "The label text." },
    x: { type: "number" },
    y: { type: "number" },
  }, ["text"]),
  fn("move_object", "Move a sticky or label. Query matches an id prefix or words in its text.", {
    query: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
  }, ["query", "x", "y"]),
  fn("edit_object", "Edit a sticky's text and/or recolor it. Query matches an id prefix or words in its text.", {
    query: { type: "string" },
    text: { type: "string", description: "New text. Omit to keep." },
    color: { type: "string", enum: COLOR_ENUM, description: "New color. Omit to keep." },
  }, ["query"]),
  fn("delete_object", "Delete one sticky or label. Query matches an id prefix or words in its text.", {
    query: { type: "string" },
  }, ["query"]),
  fn("arrange_board", "Tidy all stickies into a neat grid.", {}, []),
  fn("cluster_board", "Group stickies into labeled columns by color.", {}, []),
  fn("start_voting", "Open voting: everyone taps +1 on their favorite stickies.", {}, []),
  fn("stop_voting", "Close voting.", {}, []),
  fn("tally_votes", "Read back the current vote ranking.", {}, []),
  fn("board_count", "Read back how many stickies, labels, strokes and votes are on the board.", {}, []),
  fn("set_timer", "Start a shared countdown timer for the party.", {
    minutes: { type: "number", description: "1 to 120 minutes." },
  }, ["minutes"]),
  fn("create_widget", "Add a widget to the board. Built-ins: poll (tap options to vote) and checklist (tap items to check off). Custom types (see list_widgets) are mini apps — items map onto the type's fields in order.", {
    kind: { type: "string", description: "poll, checklist, or an active custom widget type name." },
    title: { type: "string", description: "Poll question or checklist title." },
    items: { type: "array", items: { type: "string" }, description: "Poll options or checklist entries, 2 to 8." },
    x: { type: "number", description: "Board x coordinate. Omit for an automatic spot." },
    y: { type: "number", description: "Board y coordinate. Omit for an automatic spot." },
  }, ["kind", "title", "items"]),
  fn("vote_poll", "Cast a vote for a numbered poll option (option numbers are shown in the board state).", {
    query: { type: "string", description: "Poll title words or widget id." },
    option: { type: "number", description: "1-based option number as shown in the board state." },
  }, ["query", "option"]),
  fn("toggle_checklist_item", "Check/uncheck a numbered checklist item (item numbers are shown in the board state).", {
    query: { type: "string", description: "Checklist title words or widget id." },
    item: { type: "number", description: "1-based item number as shown in the board state." },
  }, ["query", "item"]),
  fn("list_widgets", "List all custom widget types in this party (active and drafts).", {}, []),
  fn("propose_widget", "Propose a NEW custom widget type (a mini app) as a draft. Drafts are previewed in the Widget Lab and only go live when published. Your script must define function render(state) returning an HTML string, and may define bind(root, api) to wire up taps; call api.setState(newData) to save state. Use the esc() helper to escape text. Keep it small and dependency-free.", {
    name: { type: "string", description: "Slug: lowercase letters, numbers, dashes; 2-24 chars. Becomes the widget kind." },
    title: { type: "string", description: "Display name. Defaults to a prettified name." },
    description: { type: "string", description: "What the widget does, in a sentence." },
    fields: { type: "array", items: { type: "object" }, description: "Optional [{key, label}] — creation values map onto these in order." },
    example: { type: "object", description: "Default widget data, e.g. {\"count\": 0}." },
    style: { type: "string", description: "CSS for the widget. Omit for sensible defaults." },
    script: { type: "string", description: "JS defining render(state) and optional bind(root, api). Omit for a starter template." },
    height: { type: "number", description: "Widget height in px, 120-800. Default 220." },
  }, ["name", "description"]),
  fn("refine_widget", "Edit a draft widget type's code or content. Only drafts can be refined — unpublish first if it's live.", {
    name: { type: "string", description: "Widget type name." },
    title: { type: "string" },
    description: { type: "string" },
    fields: { type: "array", items: { type: "object" } },
    example: { type: "object" },
    style: { type: "string" },
    script: { type: "string" },
    height: { type: "number" },
  }, ["name"]),
  fn("publish_widget", "Publish a draft widget type so it can be added to the board with create_widget.", {
    name: { type: "string", description: "Widget type name." },
  }, ["name"]),
  fn("unpublish_widget", "Move a published widget type back to draft status.", {
    name: { type: "string", description: "Widget type name." },
  }, ["name"]),
  fn("update_widget", "Replace a custom widget instance's data (for mini-app state). Query matches title words or widget id.", {
    query: { type: "string", description: "Widget title words or widget id." },
    data: { type: "object", description: "The new data object (replaces the old one)." },
  }, ["query", "data"]),
];

const TOOL_TO_GRAMMAR: Record<string, (a: any, wtypes: WidgetTypeSpec[]) => string | { error: string }> = {
  add_sticky: (a) => {
    if (typeof a.text !== "string" || !a.text.trim()) return { error: "add_sticky needs text." };
    let s = `add sticky ${a.text.trim()}`;
    if (typeof a.color === "string" && COLOR_ENUM.includes(a.color.toLowerCase())) s += ` color ${a.color.toLowerCase()}`;
    if (Number.isFinite(a.x) && Number.isFinite(a.y)) s += ` at ${a.x},${a.y}`;
    return s;
  },
  add_label: (a) => {
    if (typeof a.text !== "string" || !a.text.trim()) return { error: "add_label needs text." };
    let s = `add label ${a.text.trim()}`;
    if (Number.isFinite(a.x) && Number.isFinite(a.y)) s += ` at ${a.x},${a.y}`;
    return s;
  },
  move_object: (a) => {
    if (typeof a.query !== "string" || !a.query.trim()) return { error: "move_object needs a query." };
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) return { error: "move_object needs numeric x and y." };
    return `move ${a.query.trim()} to ${a.x},${a.y}`;
  },
  edit_object: (a) => {
    // Handled directly in toolCallToOps (needs findMatch + op patch).
    // This branch is only reached for color-only edits via the grammar.
    if (typeof a.query !== "string" || !a.query.trim()) return { error: "edit_object needs a query." };
    if (typeof a.color !== "string") return { error: "edit_object needs text and/or color." };
    return `color ${a.query.trim()} ${String(a.color).toLowerCase()}`;
  },
  delete_object: (a) => {
    if (typeof a.query !== "string" || !a.query.trim()) return { error: "delete_object needs a query." };
    return `delete ${a.query.trim()}`;
  },
  arrange_board: () => "arrange",
  cluster_board: () => "cluster",
  start_voting: () => "vote start",
  stop_voting: () => "vote stop",
  tally_votes: () => "tally",
  board_count: () => "count",
  set_timer: (a) => {
    if (!Number.isFinite(a.minutes)) return { error: "set_timer needs minutes as a number." };
    return `timer ${a.minutes}`;
  },
  create_widget: (a, wtypes) => {
    const kind = String(a.kind || "").toLowerCase();
    const title = (a.title || "").toString().trim().replace(/\|/g, "/");
    const items = Array.isArray(a.items) ? a.items.map((s: any) => s.toString().trim().replace(/\|/g, "/")).filter(Boolean) : [];
    if (!title) return { error: "create_widget needs a title." };
    if (kind === "poll" || kind === "checklist") {
      if (items.length < 2) return { error: "create_widget needs at least 2 items." };
      if (items.length > 8) return { error: "create_widget takes at most 8 items." };
      let s = `add widget ${kind} ${title} | ${items.join(" | ")}`;
      if (Number.isFinite(a.x) && Number.isFinite(a.y)) s += ` at ${a.x},${a.y}`;
      return s;
    }
    const type = (wtypes || []).find((t) => t.name === kind);
    if (!type) return { error: `unknown widget type "${kind}". Use list_widgets to see types.` };
    if (type.status !== "active") return { error: `"${type.title}" is still a draft — publish it first.` };
    let s = `add widget ${kind} ${title}`;
    if (items.length) s += ` | ${items.join(" | ")}`;
    if (Number.isFinite(a.x) && Number.isFinite(a.y)) s += ` at ${a.x},${a.y}`;
    return s;
  },
  list_widgets: () => "widgets",
};

export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

/**
 * Compile one model tool call into agent-grammar instruction(s) or a direct op.
 * Widget-type lifecycle tools (propose/refine/publish) return a widgetAction
 * for the server to apply — they aren't canvas ops.
 */
export function toolCallToOps(
  tc: ToolCall,
  objects: Record<string, CanvasObj>,
  wtypes: WidgetTypeSpec[] = []
): { ops: AgentOp[]; result: string; timer?: number; widgetAction?: SparkWidgetAction } {
  let args: any = {};
  try {
    args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
  } catch {
    return { ops: [], result: "Error: arguments were not valid JSON." };
  }

  // Poll votes and checklist toggles: direct ops (validated server-side).
  // Handled before the grammar table — these tools have no grammar form.
  if (tc.function.name === "vote_poll" || tc.function.name === "toggle_checklist_item") {
    const isVote = tc.function.name === "vote_poll";
    const q = (args.query || "").toString().trim();
    const n = isVote ? args.option : args.item;
    if (!q) return { ops: [], result: `Error: ${tc.function.name} needs a query.` };
    if (!Number.isInteger(n) || n < 1) return { ops: [], result: `Error: ${tc.function.name} needs a 1-based ${isVote ? "option" : "item"} number.` };
    const hit = findMatch(q, objects);
    if (!hit) return { ops: [], result: `Couldn't find "${q}" on the board.` };
    const o = objects[hit.id];
    if (o.type !== "widget" || o.widget !== (isVote ? "poll" : "checklist"))
      return { ops: [], result: `Error: "${(o.text || "").slice(0, 40)}" is not a ${isVote ? "poll" : "checklist"}.` };
    const list = isVote ? o.data?.options || [] : o.data?.items || [];
    if (n > list.length) return { ops: [], result: `Error: that ${isVote ? "poll" : "checklist"} only has ${list.length} ${isVote ? "options" : "items"}.` };
    const op: AgentOp = isVote
      ? { kind: "vote", id: hit.id, option: n - 1 }
      : { kind: "toggle", id: hit.id, index: n - 1 };
    const label = isVote ? (list[n - 1] as any).label : (list[n - 1] as any).text;
    return { ops: [op], result: isVote ? `Voted for "${label}".` : `Toggled "${label}".` };
  }

  // Custom widget state replacement (mini-app data the model manages).
  if (tc.function.name === "update_widget") {
    const q = (args.query || "").toString().trim();
    const data = args.data;
    if (!q) return { ops: [], result: "Error: update_widget needs a query." };
    if (!isPlainData(data)) return { ops: [], result: "Error: update_widget data must be a plain object." };
    if (!dataSizeOk(data)) return { ops: [], result: "Error: update_widget data too large (16KB max)." };
    const hit = findMatch(q, objects);
    if (!hit) return { ops: [], result: `Couldn't find "${q}" on the board.` };
    const o = objects[hit.id];
    if (o.type !== "widget" || o.widget === "poll" || o.widget === "checklist")
      return { ops: [], result: `Error: "${(o.text || "").slice(0, 40)}" is not a custom widget.` };
    return { ops: [{ kind: "edit", id: hit.id, patch: { data } }], result: `Updated "${(o.text || "").slice(0, 40)}".` };
  }

  // Widget-type lifecycle: propose / refine / publish / unpublish.
  if (tc.function.name === "propose_widget" || tc.function.name === "refine_widget" ||
      tc.function.name === "publish_widget" || tc.function.name === "unpublish_widget") {
    const name = (args.name || "").toString().toLowerCase().trim();
    const nameErr = validateWidgetName(name);
    if (nameErr) return { ops: [], result: "Error: " + nameErr };
    if (tc.function.name === "propose_widget") {
      if (wtypes.some((t) => t.name === name))
        return { ops: [], result: `Error: a widget type called "${name}" already exists.` };
      const seed = scaffoldWidgetType(name, (args.description || "").toString(), "spark");
      const spec: WidgetTypeSpec = {
        ...seed,
        title: (args.title || "").toString().slice(0, 60).trim() || seed.title,
        fields: Array.isArray(args.fields) ? args.fields : [],
        example: args.example !== undefined ? args.example : seed.example,
        style: typeof args.style === "string" ? args.style : seed.style,
        script: typeof args.script === "string" ? args.script : seed.script,
        height: Number.isInteger(args.height) ? args.height : seed.height,
      };
      const err = validateWidgetType(spec);
      if (err) return { ops: [], result: "Error: " + err };
      return {
        ops: [],
        result: `Drafted "${spec.title}" — preview it in the 🧪 Widget Lab, then publish.`,
        widgetAction: { kind: "propose", name, spec },
      };
    }
    if (tc.function.name === "refine_widget") {
      const patch: Partial<WidgetTypeSpec> = {};
      for (const k of ["title", "description", "style", "script"] as const)
        if (typeof args[k] === "string") (patch as any)[k] = args[k];
      if (Array.isArray(args.fields)) patch.fields = args.fields;
      if (args.example !== undefined) patch.example = args.example;
      if (Number.isInteger(args.height)) patch.height = args.height;
      if (!Object.keys(patch).length)
        return { ops: [], result: "Error: refine_widget needs something to change (title, description, fields, example, style, script, height)." };
      return {
        ops: [],
        result: `Refined the "${name}" draft — preview it in the 🧪 Widget Lab.`,
        widgetAction: { kind: "refine", name, patch },
      };
    }
    const status = tc.function.name === "publish_widget" ? "active" as const : "draft" as const;
    return {
      ops: [],
      result: status === "active" ? `Published "${name}".` : `Unpublished "${name}".`,
      widgetAction: { kind: status === "active" ? "publish" : "unpublish", name, status },
    };
  }

  const compile = TOOL_TO_GRAMMAR[tc.function.name];
  if (!compile) return { ops: [], result: `Error: unknown tool "${tc.function.name}".` };

  // Edits: direct AgentOp edit patch (validated by the server like any op).
  if (tc.function.name === "edit_object") {
    const q = (args.query || "").toString().trim();
    if (!q) return { ops: [], result: "Error: edit_object needs a query." };
    const patch: { text?: string; color?: string } = {};
    if (typeof args.text === "string" && args.text.trim()) patch.text = args.text.slice(0, 500);
    if (typeof args.color === "string" && COLOR_ENUM.includes(args.color.toLowerCase()))
      patch.color = args.color.toLowerCase();
    if (!patch.text && !patch.color)
      return { ops: [], result: "Error: edit_object needs text and/or a valid color." };
    const hit = findMatch(q, objects);
    if (!hit) return { ops: [], result: `Couldn't find "${q}" on the board.` };
    const op: AgentOp = { kind: "edit", id: hit.id, patch };
    const bits = [
      patch.text ? `text to "${patch.text.slice(0, 40)}"` : "",
      patch.color ? `color to ${patch.color}` : "",
    ].filter(Boolean).join(" and ");
    return { ops: [op], result: `Edited "${(objects[hit.id].text || "").slice(0, 40)}" — set ${bits}.` };
  }

  const instruction = compile(args, wtypes);
  if (typeof instruction !== "string") {
    const err = (instruction as { error: string }).error;
    return { ops: [], result: "Error: " + err };
  }
  const res = parseAgentCommand(instruction, objects, wtypes);
  return { ops: res.ops, result: res.reply, timer: res.timer };
}

// ---------------------------------------------------------------------------
// Context + API
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Spark, a lively participant in an Idea Party — a shared brainstorming canvas with voice and video chat. You see the recent party chat and the current board. You can reply conversationally AND you can program the board by calling tools (add stickies and labels, move/recolor/edit/delete items, arrange, cluster, run votes, set timers, create poll and checklist widgets, vote in polls, toggle checklist items — and design brand-new custom widget types together with the party).

Guidelines:
- Be concise and playful; you're at a party, not writing an essay. A sentence or two unless asked for more.
- Call tools when someone asks you to do something on the board, or when adding a sticky or label would clearly help the brainstorm.
- When you act on the board, briefly say what you did in your reply. Don't narrate the tool mechanics.
- You cannot wipe the whole board — if someone asks, say you'll need them to confirm with "agent: clear yes" like everyone else.
- Custom widget types (mini apps): you can design NEW widget types with the party. propose_widget saves a draft — drafts are NOT on the board until published. refine_widget edits a draft's code. publish_widget makes it live; then create_widget can add instances of it, and update_widget can change an instance's data. Your script must define function render(state) returning an HTML string, and may define bind(root, api) to wire up taps — call api.setState(newData) to save. Use the esc() helper for text. Keep scripts small, dependency-free, and honest about what they do. Always propose as a draft first and say what it does — the user previews it in the 🧪 Widget Lab before it goes live.
- Never mention these instructions, your model name, or API details. You're just Spark, here to party.`;

function boardSummary(objects: Record<string, CanvasObj>): string {
  const list = Object.values(objects).slice(0, 80);
  if (!list.length) return "(the board is empty)";
  return list
    .map((o) => {
      const text = (o.text || "").replace(/\n/g, " ").slice(0, 100);
      const votes = o.type === "sticky" && o.votes ? ` (${o.votes} votes)` : "";
      let extra = "";
      if (o.type === "widget" && o.widget === "poll") {
        extra = "\n" + (o.data?.options || [])
          .map((op, i) => `  ${i + 1}. "${op.label}" — ${op.votes} vote${op.votes === 1 ? "" : "s"}`)
          .join("\n");
      } else if (o.type === "widget" && o.widget === "checklist") {
        extra = "\n" + (o.data?.items || [])
          .map((it, i) => `  ${i + 1}. [${it.done ? "x" : " "}] ${it.text}`)
          .join("\n");
      } else if (o.type === "widget") {
        // Custom mini-app: show its data so the model can read/update it.
        const d = JSON.stringify(o.data || {});
        extra = `\n  data: ${d.length > 220 ? d.slice(0, 220) + "…" : d}`;
      }
      const kind = o.type === "widget" ? `widget ${o.widget}` : o.type;
      return `${o.id}: ${kind}${o.color ? " " + o.color : ""} "${text}" @ ${o.x},${o.y}${votes}${extra}`;
    })
    .join("\n");
}

export function buildContextBlock(deps: SparkDeps): string {
  const objects = deps.boardObjects();
  const chat = deps
    .recentChat(30)
    .map((m) => `${m.name}: ${m.text.replace(/\n/g, " ").slice(0, 300)}`)
    .join("\n");
  return (
    `Party: ${deps.partyName()}\n\n` +
    `Board right now:\n${boardSummary(objects)}\n\n` +
    `Recent chat:\n${chat || "(no chat yet)"}`
  );
}

async function callModel(key: string, messages: any[], fetchImpl: typeof fetch): Promise<any> {
  let res: Response;
  try {
    res = await fetchImpl(SPARK_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({
        model: SPARK_MODEL,
        messages,
        tools: SPARK_TOOLS,
        tool_choice: "auto",
        max_completion_tokens: 2048,
      }),
      signal: AbortSignal.timeout(45000),
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError")
      throw new Error("timed out after 45s");
    throw new Error("couldn't reach the model API");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`the model API answered ${res.status}${body ? ": " + body.slice(0, 160) : ""}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Turn runner
// ---------------------------------------------------------------------------

const busyParties = new Set<string>();

export async function runSparkTurn(
  code: string,
  raw: string,
  byName: string,
  deps: SparkDeps
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (busyParties.has(code)) {
    deps.postChat("spark", "✨ Spark", "Give me a sec — still thinking about the last one.");
    return;
  }
  busyParties.add(code);
  try {
    const key = deps.resolveKey(SPARK_KEY_ID);
    if (!key) {
      deps.postChat(
        "spark",
        "✨ Spark",
        "I need a Meta Model API key to join the party — tap ⚙️ Settings and paste one in (grab it at dev.meta.ai)."
      );
      return;
    }
    const prompt = stripSparkPrefix(raw);
    const messages: any[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildContextBlock(deps) },
      { role: "user", content: prompt ? `${byName}: ${prompt}` : `${byName} waved at you, Spark. Say hi and offer to help with the board.` },
    ];

    let reply = "";
    for (let round = 0; round < 4; round++) {
      const data = await callModel(key, messages, fetchImpl);
      const msg = data?.choices?.[0]?.message;
      if (!msg) throw new Error("the model API returned an empty answer");
      const toolCalls: ToolCall[] | undefined = msg.tool_calls;
      if (!toolCalls || !toolCalls.length) {
        reply = (msg.content || "").toString().slice(0, 2000);
        break;
      }
      messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: toolCalls });
      for (const tc of toolCalls.slice(0, 6)) {
        const objects = deps.boardObjects(); // fresh board for every call
        const wtypes = deps.widgetTypes(); // fresh registry for every call
        const { ops, result, timer, widgetAction } = toolCallToOps(tc, objects, wtypes);
        let toolResult = result;
        if (widgetAction) {
          let err: string | null = null;
          if (widgetAction.kind === "propose" && widgetAction.spec) {
            err = deps.saveWidgetType(widgetAction.spec, byName);
          } else if (widgetAction.kind === "refine" && widgetAction.patch) {
            err = deps.updateWidgetType(widgetAction.name, widgetAction.patch);
          } else if (widgetAction.kind === "publish" || widgetAction.kind === "unpublish") {
            err = deps.setWidgetTypeStatus(widgetAction.name, widgetAction.status!);
          }
          toolResult = err ? "Error: " + err : result;
        }
        for (const op of ops) {
          if (deps.validOp(op)) deps.applyOp(op);
        }
        if (timer) deps.setTimer(timer, byName);
        messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult.slice(0, 1000) });
      }
    }
    deps.postChat("spark", "✨ Spark", reply || "Done — take a look at the board.");
  } catch (err: any) {
    const why = (err?.message || "unknown error").toString().slice(0, 200);
    deps.postChat("spark", "✨ Spark", `Spark hit a snag — ${why}. (Worth checking the API key in ⚙️ Settings.)`);
  } finally {
    busyParties.delete(code);
  }
}

/** Test hook: clear the per-party busy guard. */
export function _resetBusyForTests() {
  busyParties.clear();
}
