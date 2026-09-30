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

  test("widget ops round-trip: add, vote, toggle", async () => {
    const a = await wsJoin("Ada");
    const b = await wsJoin("Bo");
    const widget = {
      id: "wtest1", type: "widget", widget: "poll", x: 10, y: 20, text: "Lunch?",
      data: { options: [{ label: "Pizza", votes: 0 }, { label: "Sushi", votes: 0 }] },
    };
    a.ws.send(JSON.stringify({ t: "op", op: { kind: "add", obj: widget } }));
    const added = await waitFor(b.msgs, (m) => m.t === "op" && m.op?.kind === "add" && m.op?.obj?.id === "wtest1");
    expect(added.op.obj.widget).toBe("poll");

    b.ws.send(JSON.stringify({ t: "op", op: { kind: "vote", id: "wtest1", option: 1 } }));
    const voted = await waitFor(a.msgs, (m) => m.t === "op" && m.op?.kind === "vote" && m.op?.id === "wtest1");
    expect(voted.op.option).toBe(1);

    const badWidget = { ...widget, id: "wbad", widget: "quiz", data: {} };
    a.ws.send(JSON.stringify({ t: "op", op: { kind: "add", obj: badWidget } }));
    const err = await waitFor(a.msgs, (m) => m.t === "error");
    expect(err.message).toBe("invalid op");

    const badVote = { kind: "vote", id: "wtest1", option: 99 };
    b.ws.send(JSON.stringify({ t: "op", op: badVote }));
    const err2 = await waitFor(b.msgs, (m) => m.t === "error");
    expect(err2.message).toBe("invalid op");

    a.ws.close();
    b.ws.close();
  });

  test("checklist toggle op round-trips", async () => {
    const a = await wsJoin("Ada");
    const b = await wsJoin("Bo");
    const widget = {
      id: "wtest2", type: "widget", widget: "checklist", x: 0, y: 0, text: "Setup",
      data: { items: [{ text: "Chairs", done: false }, { text: "Snacks", done: false }] },
    };
    a.ws.send(JSON.stringify({ t: "op", op: { kind: "add", obj: widget } }));
    await waitFor(b.msgs, (m) => m.t === "op" && m.op?.obj?.id === "wtest2");
    b.ws.send(JSON.stringify({ t: "op", op: { kind: "toggle", id: "wtest2", index: 0 } }));
    const toggled = await waitFor(a.msgs, (m) => m.t === "op" && m.op?.kind === "toggle");
    expect(toggled.op.index).toBe(0);
    a.ws.close();
    b.ws.close();
  });
});

describe("widget types (mini apps)", () => {
  const wt = (p: string = "") => `/api/parties/${code}/widget-types${p}`;

  test("propose -> list -> publish -> add via agent", async () => {
    // propose a draft
    let r = await fetch(BASE + wt(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "dice", description: "roll a die", by: "Ada" }),
    });
    expect(r.status).toBe(201);
    let j = await r.json();
    expect(j.type.status).toBe("draft");
    expect(j.type.script).toContain("function render(");

    // list
    r = await fetch(BASE + wt());
    j = await r.json();
    expect(j.types.map((t: any) => t.name)).toContain("dice");

    // agent can't add a draft
    r = await fetch(BASE + `/api/parties/${code}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "add widget dice Roll!" }),
    });
    j = await r.json();
    expect(j.reply).toMatch(/still a draft/);

    // publish, then add
    r = await fetch(BASE + wt() + "/dice/publish", { method: "POST" });
    expect(r.status).toBe(200);
    r = await fetch(BASE + `/api/parties/${code}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "add widget dice Roll!" }),
    });
    j = await r.json();
    expect(j.reply).toMatch(/Added/);
    expect(j.seqs).toHaveLength(1);
  });

  test("agent build widget scaffolds a draft", async () => {
    const r = await fetch(BASE + `/api/parties/${code}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: 'agent: build widget scoreboard "two teams, +1 buttons"' }),
    });
    const j = await r.json();
    expect(j.reply).toMatch(/Drafted/);
    const lr = await fetch(BASE + wt());
    const lj = await lr.json();
    const sb = lj.types.find((t: any) => t.name === "scoreboard");
    expect(sb).toBeTruthy();
    expect(sb.status).toBe("draft");
  });

  test("PUT updates a draft; published types are edit-locked", async () => {
    let r = await fetch(BASE + wt() + "/scoreboard", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script: "function render(state){return '<b>hi</b>';}" }),
    });
    expect(r.status).toBe(200);
    let j = await r.json();
    expect(j.type.script).toContain("<b>hi</b>");
    expect(j.type.version).toBe(2);

    // publish then try to edit -> 409
    await fetch(BASE + wt() + "/scoreboard/publish", { method: "POST" });
    r = await fetch(BASE + wt() + "/scoreboard", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Nope" }),
    });
    expect(r.status).toBe(409);
  });

  test("DELETE refuses when instances are on the board", async () => {
    const r = await fetch(BASE + wt() + "/dice", { method: "DELETE" });
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error).toMatch(/on the board/);
  });

  test("custom widget data edits round-trip over WS; poll data edits rejected", async () => {
    const a = await wsJoin("Ada");
    const b = await wsJoin("Bo");
    // add a custom widget instance directly
    a.ws.send(JSON.stringify({ t: "op", op: {
      kind: "add",
      obj: { id: "wcustom1", type: "widget", widget: "dice", x: 10, y: 10, text: "Roll!", data: { n: 1 } },
    }}));
    await waitFor(b.msgs, (m) => m.t === "op" && m.op?.obj?.id === "wcustom1");

    // data edit on the custom widget is accepted and broadcast
    b.ws.send(JSON.stringify({ t: "op", op: { kind: "edit", id: "wcustom1", patch: { data: { n: 6 } } } }));
    const edited = await waitFor(a.msgs, (m) => m.t === "op" && m.op?.kind === "edit" && m.op?.id === "wcustom1");
    expect(edited.op.patch.data).toEqual({ n: 6 });

    // data edit on a poll is rejected
    a.ws.send(JSON.stringify({ t: "op", op: {
      kind: "add",
      obj: { id: "wpoll1", type: "widget", widget: "poll", x: 0, y: 0, text: "Q?",
             data: { options: [{ label: "a", votes: 0 }, { label: "b", votes: 0 }] } },
    }}));
    await waitFor(b.msgs, (m) => m.t === "op" && m.op?.obj?.id === "wpoll1");
    b.ws.send(JSON.stringify({ t: "op", op: { kind: "edit", id: "wpoll1", patch: { data: { hacked: 1 } } } }));
    const err = await waitFor(b.msgs, (m) => m.t === "error");
    expect(err.message).toBe("invalid op");

    // widget-types broadcast fires on publish/unpublish via agent chat
    a.ws.send(JSON.stringify({ t: "chat", text: "agent: unpublish widget scoreboard" }));
    await waitFor(b.msgs, (m) =>
      m.t === "widget-types" && m.types.find((t: any) => t.name === "scoreboard")?.status === "draft");
    a.ws.send(JSON.stringify({ t: "chat", text: "agent: publish widget scoreboard" }));
    const wt = await waitFor(b.msgs, (m) =>
      m.t === "widget-types" && m.types.find((t: any) => t.name === "scoreboard")?.status === "active");
    expect(wt.types.find((t: any) => t.name === "scoreboard").status).toBe("active");
    a.ws.close();
    b.ws.close();
  });

  test("welcome carries widget types", async () => {
    const { ws, msgs } = await wsJoin("Zed");
    const welcome = msgs.find((m) => m.t === "welcome");
    expect(welcome.widgetTypes.map((t: any) => t.name)).toContain("dice");
    ws.close();
  });
});
