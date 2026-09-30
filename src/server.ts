// Idea Party server — Bun + zero deps + SQLite.
// - Serves the SPA
// - REST: parties, canvas snapshot, agent programming endpoint
// - WebSocket: party hub — WebRTC signaling (routed peer-to-peer), canvas op
//   broadcast (server is the single sequencer), chat, presence, timers.
// Media never touches this server: voice/video is a full WebRTC mesh.

import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { parseAgentCommand, foldOps, type AgentOp, type CanvasObj } from "./agent";
import { runSparkTurn, isSparkMention, SPARK_KEY_DEF, SPARK_KEY_ID, type SparkDeps } from "./spark";

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
  const res = parseAgentCommand(raw, objects);
  const seqs: number[] = [];
  for (const op of res.ops) seqs.push(applyAndBroadcastOp(code, "agent", op));
  if (res.timer) startTimer(code, res.timer, byName);
  postChat(code, "agent", "🤖 Agent", res.reply);
  return { reply: res.reply, seqs };
}

function startTimer(code: string, minutes: number, byName: string): void {
  const endsAt = Date.now() + minutes * 60000;
  timers.set(code, { endsAt, minutes, by: byName });
  broadcast(code, { t: "timer", minutes, endsAt, by: byName });
}

/** Build the dependency bundle Spark needs for one party. */
function sparkDeps(code: string): SparkDeps {
  return {
    resolveKey,
    boardObjects: () => boardObjects(code),
    recentChat: (limit: number) =>
      (db.query("SELECT from_id AS `from`, from_name AS name, text, ts FROM chat WHERE party=? ORDER BY id DESC LIMIT ?")
        .all(code, Math.max(1, Math.min(50, limit))) as any[]).reverse(),
    partyName: () => getParty(code)?.name || "Idea party",
    validOp,
    applyOp: (op: AgentOp) => { applyAndBroadcastOp(code, "spark", op); },
    setTimer: (minutes: number, by: string) => startTimer(code, minutes, by),
    postChat: (fromId: string, fromName: string, text: string) => postChat(code, fromId, fromName, text),
  };
}

const AGENT_PREFIX = /^\s*@?agent\s*[: ]/i;

function validOp(op: any): op is AgentOp {
  if (!op || typeof op !== "object") return false;
  switch (op.kind) {
    case "add":
      return !!op.obj && typeof op.obj.id === "string" &&
        ["sticky", "stroke", "label"].includes(op.obj.type);
    case "move":
      return typeof op.id === "string" && Number.isFinite(op.x) && Number.isFinite(op.y);
    case "edit":
      return typeof op.id === "string" && !!op.patch && typeof op.patch === "object";
    case "del":
    case "vote":
      return typeof op.id === "string";
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
      const v = resolveKey(SPARK_KEY_ID);
      return Response.json({
        keys: [{ ...SPARK_KEY_DEF, configured: !!v, masked: v ? maskedKey(SPARK_KEY_ID) : "" }],
      });
    }
    if (url.pathname === "/api/keys" && req.method === "POST") {
      let id = "", value = "";
      try {
        const body = await req.json();
        id = body.id?.toString() || "";
        value = body.value?.toString() || "";
      } catch {}
      if (id !== SPARK_KEY_ID) return Response.json({ error: "unknown key id" }, { status: 400 });
      if (value && value.length > 500) return Response.json({ error: "key too long" }, { status: 400 });
      setSetting("key:" + id, value.trim());
      const v = resolveKey(id);
      return Response.json({ ok: true, configured: !!v, masked: v ? maskedKey(id) : "" });
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
          if (!validOp(msg.op)) {
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
            runSparkTurn(code, text, client.name, sparkDeps(code)).catch(() => {});
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
