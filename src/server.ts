// Idea Party server — Bun + zero deps + SQLite.
// - Serves the SPA
// - REST: parties, canvas snapshot, agent programming endpoint
// - WebSocket: party hub — WebRTC signaling (routed peer-to-peer), canvas op
//   broadcast (server is the single sequencer), chat, presence, timers.
// Media never touches this server: voice/video is a full WebRTC mesh.

import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { parseAgentCommand, foldOps, type AgentOp, type CanvasObj, type WidgetTypeAction } from "./agent";
import { runSparkTurn, isSparkMention, SPARK_KEY_DEF, SPARK_KEY_ID, type SparkDeps } from "./spark";
import { runGeminiTurn, isGeminiMention, GEMINI_KEY_DEF, GEMINI_KEY_ID } from "./gemini";
import {
  type WidgetTypeSpec,
  validateWidgetType,
  validateWidgetName,
  scaffoldWidgetType,
  isPlainData,
  dataSizeOk,
} from "./widgets";

const PORT = Number(process.env.PORT || 3011);
const ROOT = new URL("..", import.meta.url).pathname;
const DATA_DIR = ROOT + "data";
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DATA_DIR + "/party.db");
db.exec("PRAGMA journal_mode=WAL;");
db.exec(`
CREATE TABLE IF NOT EXISTS parties(code TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS canvas_ops(id INTEGER PRIMARY KEY, party TEXT NOT NULL, seq INTEGER NOT NULL, client TEXT NOT NULL, op TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chat(id INTEGER PRIMARY KEY, party TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ops_party_seq ON canvas_ops(party, seq);
CREATE INDEX IF NOT EXISTS idx_chat_party ON chat(party, id);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS widget_types(
  party TEXT NOT NULL, name TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  fields TEXT NOT NULL DEFAULT '[]', example TEXT NOT NULL DEFAULT '{}',
  style TEXT NOT NULL DEFAULT '', script TEXT NOT NULL DEFAULT '',
  height INTEGER NOT NULL DEFAULT 240, version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
  PRIMARY KEY (party, name));
`);

function getSetting(key: string): string {
  const row = db.query("SELECT value FROM settings WHERE key=?").get(key) as any;
  return (row?.value || "").toString();
}
function setSetting(key: string, value: string): void {
  db.query("INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, value);
}

/** env first, then the Settings-screen store. */
function resolveKey(id: string): string {
  const env = (process.env[id] || "").trim();
  if (env) return env;
  return getSetting("key:" + id).trim();
}
function maskedKey(id: string): string {
  const v = resolveKey(id);
  if (!v) return "";
  if (v.length <= 8) return "••••••••";
  return v.slice(0, 4) + "••••" + v.slice(-4);
}

const PEER_COLORS = ["#f5b544", "#7dd3a8", "#8ab4ff", "#e58bb1", "#b9a7ff", "#ffb37d", "#6fd6d0", "#ff8a8a"];

interface Client {
  id: string;
  name: string;
  color: string;
  party: string;
  ws: any;
}

const partyClients = new Map<string, Set<Client>>(); // code -> clients
const seqCounters = new Map<string, number>(); // code -> last seq
const timers = new Map<string, { endsAt: number; minutes: number; by: string }>();

function rand(n: number): string {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const buf = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(buf, (b) => abc[b % abc.length]).join("");
}

function nextSeq(code: string): number {
  let s = seqCounters.get(code);
  if (s === undefined) {
    const row = db.query("SELECT MAX(seq) AS m FROM canvas_ops WHERE party=?").get(code) as any;
    s = row?.m ?? 0;
    seqCounters.set(code, s);
  }
  s += 1;
  seqCounters.set(code, s);
  return s;
}

function boardObjects(code: string): Record<string, CanvasObj> {
  const rows = db.query("SELECT op FROM canvas_ops WHERE party=? ORDER BY seq").all(code) as any[];
  return foldOps(rows.map((r) => JSON.parse(r.op) as AgentOp));
}

// ---------------------------------------------------------------------------
// Widget-type registry (custom mini apps). One registry per party.
// ---------------------------------------------------------------------------

function rowToWidgetType(r: any): WidgetTypeSpec {
  return {
    name: r.name,
    title: r.title,
    description: r.description || "",
    status: r.status === "active" ? "active" : "draft",
    fields: JSON.parse(r.fields || "[]"),
    example: JSON.parse(r.example || "{}"),
    style: r.style || "",
    script: r.script || "",
    height: r.height || 240,
    version: r.version || 1,
    created_by: r.created_by || "",
    updated_at: r.updated_at || 0,
  };
}

function getWidgetTypes(code: string): WidgetTypeSpec[] {
  const rows = db.query("SELECT * FROM widget_types WHERE party=? ORDER BY name").all(code) as any[];
  return rows.map(rowToWidgetType);
}

function getWidgetType(code: string, name: string): WidgetTypeSpec | null {
  const r = db.query("SELECT * FROM widget_types WHERE party=? AND name=?").get(code, name) as any;
  return r ? rowToWidgetType(r) : null;
}

function activeWidgetNames(code: string): Set<string> {
  return new Set(getWidgetTypes(code).filter((t) => t.status === "active").map((t) => t.name));
}

/** Insert or replace a widget type. Returns an error string, or null on success. */
function saveWidgetType(code: string, t: WidgetTypeSpec): string | null {
  const err = validateWidgetType(t);
  if (err) return err;
  db.query(
    `INSERT INTO widget_types(party,name,title,description,status,fields,example,style,script,height,version,created_by,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(party,name) DO UPDATE SET
       title=excluded.title, description=excluded.description, status=excluded.status,
       fields=excluded.fields, example=excluded.example, style=excluded.style,
       script=excluded.script, height=excluded.height, version=excluded.version,
       created_by=excluded.created_by, updated_at=excluded.updated_at`
  ).run(
    code, t.name, t.title, t.description, t.status,
    JSON.stringify(t.fields), JSON.stringify(t.example),
    t.style, t.script, t.height, t.version, t.created_by, t.updated_at
  );
  broadcast(code, { t: "widget-types", types: getWidgetTypes(code) });
  return null;
}

function setWidgetTypeStatus(code: string, name: string, status: "draft" | "active"): string | null {
  const t = getWidgetType(code, name);
  if (!t) return `No widget type "${name}".`;
  if (t.status === status) return null;
  t.status = status;
  t.updated_at = Date.now();
  return saveWidgetType(code, t);
}

/** Perform an agent-grammar widget-type action. Returns the chat reply. */
function handleWidgetTypeAction(code: string, a: WidgetTypeAction, byName: string): string {
  if (a.action === "propose") {
    if (getWidgetType(code, a.name)) return `There's already a widget type called "${a.name}".`;
    const spec = scaffoldWidgetType(a.name, a.description || "", byName);
    const err = saveWidgetType(code, spec);
    if (err) return `Couldn't scaffold "${a.name}": ${err}`;
    return `Drafted "${spec.title}" — open the 🧪 Widget Lab to preview it, or ask @spark to write the real code. Publish it when it's ready.`;
  }
  if (a.action === "publish" || a.action === "unpublish") {
    const err = setWidgetTypeStatus(code, a.name, a.action === "publish" ? "active" : "draft");
    if (err) return err;
    return a.action === "publish"
      ? `“${a.name}” is live — add it with \`agent add widget ${a.name} <title>\`.`
      : `“${a.name}” is back to draft.`;
  }
  return "Unknown widget action.";
}

function broadcast(code: string, msg: any, except?: Client) {
  const set = partyClients.get(code);
  if (!set) return;
  const text = JSON.stringify(msg);
  for (const c of set) {
    if (c !== except) {
      try { c.ws.send(text); } catch { /* dead socket */ }
    }
  }
}

function postChat(code: string, fromId: string, fromName: string, text: string) {
  const ts = Date.now();
  db.query("INSERT INTO chat(party, from_id, from_name, text, ts) VALUES (?,?,?,?,?)")
    .run(code, fromId, fromName, text.slice(0, 2000), ts);
  broadcast(code, { t: "chat", from: fromId, name: fromName, text: text.slice(0, 2000), ts });
}

function applyAndBroadcastOp(code: string, clientId: string, op: AgentOp): number {
  const seq = nextSeq(code);
  db.query("INSERT INTO canvas_ops(party, seq, client, op, ts) VALUES (?,?,?,?,?)")
    .run(code, seq, clientId, JSON.stringify(op), Date.now());
  broadcast(code, { t: "op", seq, op, from: clientId });
  return seq;
}

/** Run the Party Agent: parse -> persist ops -> broadcast -> chat reply. */
function runAgent(code: string, raw: string, byName: string): { reply: string; seqs: number[] } {
  const objects = boardObjects(code);
  const wtypes = getWidgetTypes(code);
  const res = parseAgentCommand(raw, objects, wtypes);
  const seqs: number[] = [];
  for (const op of res.ops) seqs.push(applyAndBroadcastOp(code, "agent", op));
  if (res.timer) startTimer(code, res.timer, byName);
  let reply = res.reply;
  if (res.widgetType) reply = handleWidgetTypeAction(code, res.widgetType, byName);
  postChat(code, "agent", "🤖 Agent", reply);
  return { reply, seqs };
}

function startTimer(code: string, minutes: number, byName: string): void {
  const endsAt = Date.now() + minutes * 60000;
  timers.set(code, { endsAt, minutes, by: byName });
  broadcast(code, { t: "timer", minutes, endsAt, by: byName });
}

/** Build the dependency bundle a participant needs for one party. */
function participantDeps(code: string): SparkDeps {
  return {
    resolveKey,
    boardObjects: () => boardObjects(code),
    recentChat: (limit: number) =>
      (db.query("SELECT from_id AS `from`, from_name AS name, text, ts FROM chat WHERE party=? ORDER BY id DESC LIMIT ?")
        .all(code, Math.max(1, Math.min(50, limit))) as any[]).reverse(),
    partyName: () => getParty(code)?.name || "Idea party",
    validOp: (op: any) => validOp(op),
    applyOp: (op: AgentOp) => { applyAndBroadcastOp(code, "spark", op); },
    setTimer: (minutes: number, by: string) => startTimer(code, minutes, by),
    postChat: (fromId: string, fromName: string, text: string) => postChat(code, fromId, fromName, text),
    widgetTypes: () => getWidgetTypes(code),
    saveWidgetType: (t: WidgetTypeSpec, _by: string) => saveWidgetType(code, t),
    updateWidgetType: (name: string, patch: Partial<WidgetTypeSpec>) => {
      const cur = getWidgetType(code, name);
      if (!cur) return `No widget type "${name}".`;
      if (cur.status !== "draft") return `“${cur.title}” is published — unpublish it before editing.`;
      const next: WidgetTypeSpec = {
        ...cur,
        title: typeof patch.title === "string" ? patch.title : cur.title,
        description: typeof patch.description === "string" ? patch.description : cur.description,
        fields: Array.isArray(patch.fields) ? patch.fields : cur.fields,
        example: patch.example !== undefined ? patch.example : cur.example,
        style: typeof patch.style === "string" ? patch.style : cur.style,
        script: typeof patch.script === "string" ? patch.script : cur.script,
        height: Number.isInteger(patch.height) ? patch.height as number : cur.height,
        version: cur.version + 1,
        updated_at: Date.now(),
      };
      return saveWidgetType(code, next);
    },
    setWidgetTypeStatus: (name: string, status: "draft" | "active") => setWidgetTypeStatus(code, name, status),
  };
}

const AGENT_PREFIX = /^\s*@?agent\s*[: ]/i;

function validWidget(obj: any, activeWidgets: Set<string>): boolean {
  if (obj.widget === "poll" || obj.widget === "checklist") {
    if (typeof obj.text !== "string" || !obj.text.trim() || obj.text.length > 120) return false;
    const data = obj.data;
    if (!data || typeof data !== "object") return false;
    if (obj.widget === "poll") {
      if (!Array.isArray(data.options) || data.options.length < 2 || data.options.length > 8) return false;
      return data.options.every((o: any) =>
        o && typeof o.label === "string" && o.label.trim().length > 0 && o.label.length <= 60 &&
        typeof o.votes === "number" && o.votes >= 0);
    }
    if (!Array.isArray(data.items) || data.items.length < 2 || data.items.length > 8) return false;
    return data.items.every((it: any) =>
      it && typeof it.text === "string" && it.text.trim().length > 0 && it.text.length <= 60 &&
      typeof it.done === "boolean");
  }
  // Custom mini-app widget: kind must be an active type, data is free-form.
  if (typeof obj.widget !== "string" || !activeWidgets.has(obj.widget)) return false;
  if (typeof obj.text !== "string" || obj.text.length > 120) return false;
  return isPlainData(obj.data) && dataSizeOk(obj.data);
}

export interface ValidOpCtx {
  objects?: Record<string, CanvasObj>;
  activeWidgets?: Set<string>;
}

function validOp(op: any, ctx: ValidOpCtx = {}): op is AgentOp {
  if (!op || typeof op !== "object") return false;
  switch (op.kind) {
    case "add":
      return !!op.obj && typeof op.obj.id === "string" &&
        ["sticky", "stroke", "label", "widget"].includes(op.obj.type) &&
        (op.obj.type !== "widget" || validWidget(op.obj, ctx.activeWidgets ?? new Set()));
    case "move":
      return typeof op.id === "string" && Number.isFinite(op.x) && Number.isFinite(op.y);
    case "edit": {
      if (typeof op.id !== "string" || !op.patch || typeof op.patch !== "object") return false;
      const d = op.patch.data;
      if (d !== undefined) {
        // Custom-widget state replacement: plain object, size-capped.
        if (!isPlainData(d) || !dataSizeOk(d)) return false;
        if (ctx.objects) {
          const target = ctx.objects[op.id];
          if (!target || target.type !== "widget") return false;
          if (target.widget === "poll" || target.widget === "checklist") return false;
        }
      }
      return true;
    }
    case "del":
      return typeof op.id === "string";
    case "vote":
      return typeof op.id === "string" &&
        (op.option === undefined || (Number.isInteger(op.option) && op.option >= 0 && op.option < 8));
    case "toggle":
      return typeof op.id === "string" &&
        Number.isInteger(op.index) && op.index >= 0 && op.index < 8;
    case "clear":
      return true;
    case "mode":
      return op.key === "vote" && typeof op.value === "boolean";
    default:
      return false;
  }
}

function getParty(code: string) {
  return db.query("SELECT code, name FROM parties WHERE code=?").get(code) as any;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // --- WebSocket upgrade ---
    if (url.pathname === "/ws") {
      const code = (url.searchParams.get("party") || "").toLowerCase();
      if (!getParty(code)) return new Response("unknown party", { status: 404 });
      if (server.upgrade(req, { data: { code } })) return undefined as any;
      return new Response("upgrade failed", { status: 500 });
    }

    // --- REST ---
    if (url.pathname === "/api/parties" && req.method === "POST") {
      let name = "Idea party";
      try { name = (await req.json()).name?.toString().slice(0, 80) || name; } catch {}
      const code = rand(8);
      db.query("INSERT INTO parties(code, name, created_at) VALUES (?,?,?)").run(code, name, Date.now());
      return Response.json({ code, name });
    }
    let m = url.pathname.match(/^\/api\/parties\/([a-z0-9]+)$/);
    if (m && req.method === "GET") {
      const p = getParty(m[1]);
      if (!p) return Response.json({ error: "unknown party" }, { status: 404 });
      return Response.json({ code: p.code, name: p.name, peers: partyClients.get(p.code)?.size ?? 0 });
    }
    m = url.pathname.match(/^\/api\/parties\/([a-z0-9]+)\/canvas$/);
    if (m && req.method === "GET") {
      if (!getParty(m[1])) return Response.json({ error: "unknown party" }, { status: 404 });
      const rows = db.query("SELECT seq, op FROM canvas_ops WHERE party=? ORDER BY seq").all(m[1]) as any[];
      return Response.json({ ops: rows.map((r) => ({ seq: r.seq, op: JSON.parse(r.op) })) });
    }
    m = url.pathname.match(/^\/api\/parties\/([a-z0-9]+)\/agent$/);
    if (m && req.method === "POST") {
      if (!getParty(m[1])) return Response.json({ error: "unknown party" }, { status: 404 });
      let instruction = "";
      try { instruction = (await req.json()).instruction?.toString() || ""; } catch {}
      if (!instruction.trim()) return Response.json({ error: "instruction required" }, { status: 400 });
      const { reply, seqs } = runAgent(m[1], instruction, "api");
      return Response.json({ ok: true, reply, seqs });
    }

    // --- keys (Settings screen; values never leave the server) ---
    if (url.pathname === "/api/keys" && req.method === "GET") {
      const defs = [
        { def: SPARK_KEY_DEF, id: SPARK_KEY_ID },
        { def: GEMINI_KEY_DEF, id: GEMINI_KEY_ID },
      ];
      return Response.json({
        keys: defs.map(({ def, id }) => {
          const v = resolveKey(id);
          return { ...def, configured: !!v, masked: v ? maskedKey(id) : "" };
        }),
      });
    }
    if (url.pathname === "/api/keys" && req.method === "POST") {
      let id = "", value = "";
      try {
        const body = await req.json();
        id = body.id?.toString() || "";
        value = body.value?.toString() || "";
      } catch {}
      if (id !== SPARK_KEY_ID && id !== GEMINI_KEY_ID)
        return Response.json({ error: "unknown key id" }, { status: 400 });
      if (value && value.length > 500) return Response.json({ error: "key too long" }, { status: 400 });
      setSetting("key:" + id, value.trim());
      const v = resolveKey(id);
      return Response.json({ ok: true, configured: !!v, masked: v ? maskedKey(id) : "" });
    }

    // --- widget types (custom mini apps) ---
    m = url.pathname.match(/^\/api\/parties\/([a-z0-9]+)\/widget-types$/);
    if (m && req.method === "GET") {
      if (!getParty(m[1])) return Response.json({ error: "unknown party" }, { status: 404 });
      return Response.json({ types: getWidgetTypes(m[1]) });
    }
    if (m && req.method === "POST") {
      if (!getParty(m[1])) return Response.json({ error: "unknown party" }, { status: 404 });
      let body: any = {};
      try { body = await req.json(); } catch {}
      const name = (body.name || "").toString().toLowerCase().trim();
      const nameErr = validateWidgetName(name);
      if (nameErr) return Response.json({ error: nameErr }, { status: 400 });
      if (getWidgetType(m[1], name)) return Response.json({ error: `widget type "${name}" already exists` }, { status: 409 });
      const seed = scaffoldWidgetType(name, (body.description || "").toString(), (body.by || "").toString().slice(0, 40));
      const spec: WidgetTypeSpec = {
        ...seed,
        title: (body.title || "").toString().slice(0, 60).trim() || seed.title,
        fields: Array.isArray(body.fields) ? body.fields : [],
        example: body.example !== undefined ? body.example : seed.example,
        style: typeof body.style === "string" ? body.style : seed.style,
        script: typeof body.script === "string" ? body.script : seed.script,
        height: Number.isInteger(body.height) ? body.height : seed.height,
      };
      const err = saveWidgetType(m[1], spec);
      if (err) return Response.json({ error: err }, { status: 400 });
      return Response.json({ ok: true, type: getWidgetType(m[1], name) }, { status: 201 });
    }
    m = url.pathname.match(/^\/api\/parties\/([a-z0-9]+)\/widget-types\/([a-z0-9-]+)$/);
    if (m && req.method === "PUT") {
      if (!getParty(m[1])) return Response.json({ error: "unknown party" }, { status: 404 });
      const cur = getWidgetType(m[1], m[2]);
      if (!cur) return Response.json({ error: "unknown widget type" }, { status: 404 });
      if (cur.status !== "draft") return Response.json({ error: "unpublish before editing" }, { status: 409 });
      let body: any = {};
      try { body = await req.json(); } catch {}
      const next: WidgetTypeSpec = {
        ...cur,
        title: typeof body.title === "string" ? body.title : cur.title,
        description: typeof body.description === "string" ? body.description : cur.description,
        fields: Array.isArray(body.fields) ? body.fields : cur.fields,
        example: body.example !== undefined ? body.example : cur.example,
        style: typeof body.style === "string" ? body.style : cur.style,
        script: typeof body.script === "string" ? body.script : cur.script,
        height: Number.isInteger(body.height) ? body.height : cur.height,
        version: cur.version + 1,
        updated_at: Date.now(),
      };
      const err = saveWidgetType(m[1], next);
      if (err) return Response.json({ error: err }, { status: 400 });
      return Response.json({ ok: true, type: getWidgetType(m[1], m[2]) });
    }
    if (m && req.method === "DELETE") {
      if (!getParty(m[1])) return Response.json({ error: "unknown party" }, { status: 404 });
      if (!getWidgetType(m[1], m[2])) return Response.json({ error: "unknown widget type" }, { status: 404 });
      const objs = boardObjects(m[1]);
      const used = Object.values(objs).some((o) => o.type === "widget" && o.widget === m[2]);
      if (used) return Response.json({ error: "widget type is on the board — delete those widgets first" }, { status: 409 });
      db.query("DELETE FROM widget_types WHERE party=? AND name=?").run(m[1], m[2]);
      broadcast(m[1], { t: "widget-types", types: getWidgetTypes(m[1]) });
      return Response.json({ ok: true });
    }
    m = url.pathname.match(/^\/api\/parties\/([a-z0-9]+)\/widget-types\/([a-z0-9-]+)\/(publish|unpublish)$/);
    if (m && req.method === "POST") {
      if (!getParty(m[1])) return Response.json({ error: "unknown party" }, { status: 404 });
      const err = setWidgetTypeStatus(m[1], m[2], m[3] === "publish" ? "active" : "draft");
      if (err) return Response.json({ error: err }, { status: 400 });
      return Response.json({ ok: true, type: getWidgetType(m[1], m[2]) });
    }

    // --- SPA ---
    if (url.pathname === "/" || url.pathname.startsWith("/p/")) {
      return new Response(Bun.file(ROOT + "public/index.html"), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    const file = Bun.file(ROOT + "public" + url.pathname);
    if (await file.exists()) return new Response(file);
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws: any) {
      ws.data.client = null;
    },
    message(ws: any, raw: any) {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const code: string = ws.data.code;
      const client: Client | null = ws.data.client;

      // First message must be hello.
      if (!client) {
        if (msg.t !== "hello") { ws.close(); return; }
        const name = (msg.name || "Guest").toString().slice(0, 40);
        const set = partyClients.get(code) ?? new Set<Client>();
        const color = PEER_COLORS[set.size % PEER_COLORS.length];
        const c: Client = { id: "p" + rand(6), name, color, party: code, ws };
        ws.data.client = c;
        set.add(c);
        partyClients.set(code, set);

        const ops = (db.query("SELECT seq, op FROM canvas_ops WHERE party=? ORDER BY seq").all(code) as any[])
          .map((r) => ({ seq: r.seq, op: JSON.parse(r.op) }));
        const chatRows = db.query("SELECT from_id, from_name, text, ts FROM chat WHERE party=? ORDER BY id DESC LIMIT 50").all(code) as any[];
        const timer = timers.get(code);
        if (timer && timer.endsAt <= Date.now()) timers.delete(code);
        ws.send(JSON.stringify({
          t: "welcome",
          id: c.id, name: c.name, color: c.color,
          peers: [...set].filter((p) => p !== c).map((p) => ({ id: p.id, name: p.name, color: p.color })),
          canvas: ops,
          chat: chatRows.reverse().map((r) => ({ from: r.from_id, name: r.from_name, text: r.text, ts: r.ts })),
          timer: timers.get(code) ?? null,
          widgetTypes: getWidgetTypes(code),
        }));
        broadcast(code, { t: "peer-join", id: c.id, name: c.name, color: c.color }, c);
        return;
      }

      switch (msg.t) {
        case "ping": {
          // heartbeat: keeps the socket alive through proxies with idle timeouts (e.g. Cloudflare ~100s)
          try { ws.send(JSON.stringify({ t: "pong" })); } catch {}
          break;
        }
        case "signal": {
          // Pure routing: SDP/ICE go straight to the target peer. Media is P2P.
          if (typeof msg.to !== "string" || !msg.data) break;
          const target = [...(partyClients.get(code) ?? [])].find((p) => p.id === msg.to);
          if (target) {
            try { target.ws.send(JSON.stringify({ t: "signal", from: client.id, data: msg.data })); } catch {}
          }
          break;
        }
        case "op": {
          if (!validOp(msg.op, { objects: boardObjects(code), activeWidgets: activeWidgetNames(code) })) {
            ws.send(JSON.stringify({ t: "error", message: "invalid op" }));
            break;
          }
          applyAndBroadcastOp(code, client.id, msg.op);
          break;
        }
        case "cursor": {
          if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) break;
          broadcast(code, { t: "cursor", from: client.id, name: client.name, color: client.color, x: msg.x, y: msg.y }, client);
          break;
        }
        case "chat": {
          const text = (msg.text || "").toString().slice(0, 2000);
          if (!text.trim()) break;
          postChat(code, client.id, client.name, text);
          if (AGENT_PREFIX.test(text)) runAgent(code, text, client.name);
          if (isSparkMention(text)) {
            // async — Spark answers when the model responds; never blocks chat.
            runSparkTurn(code, text, client.name, participantDeps(code)).catch(() => {});
          }
          if (isGeminiMention(text)) {
            // async — Gemini answers when the model responds; never blocks chat.
            runGeminiTurn(code, text, client.name, participantDeps(code)).catch(() => {});
          }
          break;
        }
        case "media": {
          broadcast(code, { t: "media", from: client.id, audio: !!msg.audio, video: !!msg.video }, client);
          break;
        }
      }
    },
    close(ws: any) {
      const client: Client | null = ws.data?.client;
      if (!client) return;
      const set = partyClients.get(client.party);
      if (set) {
        set.delete(client);
        if (!set.size) partyClients.delete(client.party);
      }
      broadcast(client.party, { t: "peer-leave", id: client.id });
    },
  },
});

console.log(`idea-party on http://localhost:${PORT}`);
