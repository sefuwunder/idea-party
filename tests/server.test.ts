import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";

const PORT = 34119;
const BASE = `http://127.0.0.1:${PORT}`;
let proc: any;
let code: string;

function wsJoin(name: string): Promise<{ ws: WebSocket; msgs: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?party=${code}`);
    const msgs: any[] = [];
    const timer = setTimeout(() => reject(new Error("ws timeout")), 5000);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data.toString());
      msgs.push(m);
      if (m.t === "welcome") { clearTimeout(timer); resolve({ ws, msgs }); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
    ws.onopen = () => ws.send(JSON.stringify({ t: "hello", name }));
  });
}

function waitFor(msgs: any[], pred: (m: any) => boolean, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const hit = msgs.find(pred);
      if (hit) { clearInterval(iv); resolve(hit); }
      else if (Date.now() - start > timeout) { clearInterval(iv); reject(new Error("waitFor timeout")); }
    }, 25);
  });
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", "src/server.ts"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, PORT: String(PORT) },
    stdout: "ignore",
    stderr: "ignore",
  });
  // wait for port
  for (let i = 0; i < 100; i++) {
    try { await fetch(BASE + "/api/parties/nonexistent"); break; }
    catch { await Bun.sleep(50); }
  }
  const res = await fetch(BASE + "/api/parties", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Test party" }),
  });
  const j = await res.json();
  expect(j.code).toMatch(/^[a-z0-9]{8}$/);
  code = j.code;
});

afterAll(() => {
  proc?.kill();
  // clean up test rows
  const db = new Database(import.meta.dir + "/../data/party.db");
  db.query("DELETE FROM canvas_ops WHERE party=?").run(code);
  db.query("DELETE FROM chat WHERE party=?").run(code);
  db.query("DELETE FROM parties WHERE code=?").run(code);
});

describe("server", () => {
  test("agent HTTP endpoint programs the canvas", async () => {
    const res = await fetch(`${BASE}/api/parties/${code}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "agent add sticky Test idea color pink" }),
    });
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.reply).toContain("Added");
    expect(j.seqs).toHaveLength(1);

    const canvas = await (await fetch(`${BASE}/api/parties/${code}/canvas`)).json();
    expect(canvas.ops).toHaveLength(1);
    expect(canvas.ops[0].op.obj.text).toBe("Test idea");
    expect(canvas.ops[0].op.obj.color).toBe("pink");
  });

  test("two clients: join, op broadcast, chat agent, signaling", async () => {
    const a = await wsJoin("Ada");
    const welcome = a.msgs[0];
    expect(welcome.canvas).toHaveLength(1);
    expect(welcome.chat.some((c: any) => c.name === "🤖 Agent")).toBe(true);

    const b = await wsJoin("Bo");
    const join = await waitFor(a.msgs, (m) => m.t === "peer-join");
    expect(join.name).toBe("Bo");

    // op from A reaches B with a sequence number
    a.ws.send(JSON.stringify({ t: "op", op: { kind: "add", obj: { id: "sx", type: "sticky", x: 5, y: 5, text: "hi", votes: 0 } } }));
    const opMsg = await waitFor(b.msgs, (m) => m.t === "op" && m.op?.obj?.id === "sx");
    expect(opMsg.seq).toBeGreaterThan(1);

    // chat "agent: ..." triggers the party agent for everyone
    a.ws.send(JSON.stringify({ t: "chat", text: "agent: count" }));
    const agentChat = await waitFor(b.msgs, (m) => m.t === "chat" && m.name === "🤖 Agent" && m.text.includes("stickies"));
    expect(agentChat).toBeTruthy();

    // signaling routes peer-to-peer through the hub
    const bid = b.msgs[0].id;
    a.ws.send(JSON.stringify({ t: "signal", to: bid, data: { sdp: { type: "offer", sdp: "fake" } } }));
    const sig = await waitFor(b.msgs, (m) => m.t === "signal" && m.data?.sdp?.type === "offer");
    expect(sig.from).toBe(a.msgs[0].id);

    // cursor + media state broadcast
    a.ws.send(JSON.stringify({ t: "cursor", x: 10, y: 20 }));
    const cur = await waitFor(b.msgs, (m) => m.t === "cursor" && m.x === 10);
    expect(cur.name).toBe("Ada");

    b.ws.close();
    const left = await waitFor(a.msgs, (m) => m.t === "peer-leave" && m.id === bid);
    expect(left).toBeTruthy();
    a.ws.close();
  });

  test("invalid op is rejected", async () => {
    const a = await wsJoin("Zed");
    a.ws.send(JSON.stringify({ t: "op", op: { kind: "explode" } }));
    const err = await waitFor(a.msgs, (m) => m.t === "error");
    expect(err.message).toBe("invalid op");
    a.ws.close();
  });
});
