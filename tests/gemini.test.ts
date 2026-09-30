import { describe, test, expect } from "bun:test";
import {
  stripGeminiPrefix,
  isGeminiMention,
  geminiToolCallToOps,
  runGeminiTurn,
  _resetGeminiBusyForTests,
  GEMINI_TOOLS,
  GEMINI_MODEL,
  GEMINI_API_URL,
  GEMINI_KEY_ID,
  GEMINI_KEY_DEF,
  type GeminiDeps,
  type ToolCall,
  type ChatMsg,
} from "../src/gemini";
import { runSparkTurn, _resetBusyForTests as _resetSparkBusyForTests } from "../src/spark";
import type { AgentOp, CanvasObj } from "../src/agent";

function board(): Record<string, CanvasObj> {
  return {
    s1: { id: "s1", type: "sticky", x: 0, y: 0, text: "Raise prices", color: "yellow", votes: 2 },
    s2: { id: "s2", type: "sticky", x: 10, y: 10, text: "New logo", color: "pink", votes: 0 },
    l1: { id: "l1", type: "label", x: 5, y: 5, text: "Ideas" },
  };
}

function tc(name: string, args: any): ToolCall {
  return { id: "call_1", function: { name, arguments: JSON.stringify(args) } };
}

interface Harness {
  deps: GeminiDeps;
  applied: AgentOp[];
  chats: { fromId: string; fromName: string; text: string }[];
  timers: { minutes: number; by: string }[];
  requests: { url: string; init: any }[];
  objects: Record<string, CanvasObj>;
  key: string;
}

function harness(opts: { key?: string; fetchImpl?: any } = {}): Harness {
  const h: Harness = {
    applied: [], chats: [], timers: [], requests: [],
    objects: board(),
    key: opts.key ?? "test-gemini-key-123",
  } as any;
  h.deps = {
    resolveKey: (id: string) => h.key, // any participant id gets the test key
    boardObjects: () => JSON.parse(JSON.stringify(h.objects)),
    recentChat: (_limit: number): ChatMsg[] => [
      { from: "p1", name: "Ada", text: "let's brainstorm pricing", ts: 1 },
      { from: "p2", name: "Bo", text: "@gemini add a sticky about free trials", ts: 2 },
    ],
    partyName: () => "Friday brainstorm",
    validOp: (op: any): op is AgentOp => {
      if (!op || typeof op !== "object") return false;
      return ["add", "move", "edit", "del", "vote", "clear", "mode"].includes(op.kind);
    },
    applyOp: (op: AgentOp) => { h.applied.push(op); },
    setTimer: (minutes: number, by: string) => { h.timers.push({ minutes, by }); },
    postChat: (fromId: string, fromName: string, text: string) => {
      h.chats.push({ fromId, fromName, text });
    },
    fetchImpl: opts.fetchImpl ?? (async () => { throw new Error("fetch should not be called"); }),
    widgetTypes: () => (h as any).wtypes ?? [],
    saveWidgetType: (t: any) => { ((h as any).wtypes ??= []).push(t); return null; },
    updateWidgetType: (name: string, patch: any) => {
      const w = ((h as any).wtypes ?? []).find((x: any) => x.name === name);
      if (!w) return `No widget type "${name}".`;
      Object.assign(w, patch);
      return null;
    },
    setWidgetTypeStatus: (name: string, status: string) => {
      const w = ((h as any).wtypes ?? []).find((x: any) => x.name === name);
      if (!w) return `No widget type "${name}".`;
      w.status = status;
      return null;
    },
  };
  return h;
}

function modelReply(message: any, h: Harness): any {
  return async (url: string, init: any) => {
    h.requests.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  };
}

function deferredFetch(): { impl: any; release: () => void } {
  let release!: () => void;
  const gate = new Promise<Response>((r) => {
    release = () =>
      r(new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200 }));
  });
  return { impl: () => gate, release };
}

describe("gemini mention detection", () => {
  test("matches @gemini / gemini: / gemini prefixes", () => {
    for (const t of ["@gemini hello", "gemini: hello", "gemini hello", "  @Gemini:  hi ", "@gemini"]) {
      expect(isGeminiMention(t)).toBe(true);
    }
  });
  test("does not match lookalikes or spark", () => {
    for (const t of ["geminids shower", "agent: hello", "hey geminix", "what a gemini", "@spark hello"]) {
      expect(isGeminiMention(t)).toBe(false);
    }
  });
  test("stripGeminiPrefix", () => {
    expect(stripGeminiPrefix("@gemini: add sticky hi")).toBe("add sticky hi");
    expect(stripGeminiPrefix("gemini hello there")).toBe("hello there");
    expect(stripGeminiPrefix("@gemini")).toBe("");
  });
});

describe("gemini config", () => {
  test("points at Google's OpenAI-compatible endpoint with a current model", () => {
    expect(GEMINI_API_URL).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(GEMINI_MODEL).toBe("gemini-3.8-flash");
    expect(GEMINI_KEY_ID).toBe("GEMINI_API_KEY");
  });
  test("key def points at AI Studio and differs from Spark's", () => {
    expect(GEMINI_KEY_DEF.signup).toContain("aistudio.google.com");
    expect(GEMINI_KEY_DEF.id).toBe(GEMINI_KEY_ID);
    expect(GEMINI_KEY_DEF.name).toMatch(/Gemini/);
  });
  test("no clear/wipe tool is exposed", () => {
    const names = GEMINI_TOOLS.map((t: any) => t.function.name);
    expect(names.some((n: string) => /clear|wipe|delete_all/.test(n))).toBe(false);
  });
  test("widget lifecycle tools are exposed", () => {
    const names = GEMINI_TOOLS.map((t: any) => t.function.name);
    for (const n of ["create_widget", "vote_poll", "toggle_checklist_item", "list_widgets", "propose_widget", "refine_widget", "publish_widget", "unpublish_widget", "update_widget"]) {
      expect(names).toContain(n);
    }
  });
});

describe("gemini toolCallToOps", () => {
  test("add_sticky compiles through the shared grammar", () => {
    const r = geminiToolCallToOps(tc("add_sticky", { text: "free trials rock", color: "green" }), board());
    expect(r.ops.length).toBe(1);
    expect(r.ops[0].kind).toBe("add");
    expect((r.ops[0] as any).obj.type).toBe("sticky");
    expect((r.ops[0] as any).obj.text).toBe("free trials rock");
    expect((r.ops[0] as any).obj.color).toBe("green");
  });
  test("unknown tool errors", () => {
    const r = geminiToolCallToOps(tc("do_anything", {}), board());
    expect(r.ops.length).toBe(0);
    expect(r.result).toMatch(/unknown tool/);
  });
});

describe("runGeminiTurn", () => {
  test("posts a graceful no-key message naming the Gemini key", async () => {
    const h = harness({ key: "" });
    await runGeminiTurn("C1", "@gemini hello", "Ada", h.deps);
    expect(h.chats.length).toBe(1);
    expect(h.chats[0].fromId).toBe("gemini");
    expect(h.chats[0].fromName).toBe("✦ Gemini");
    expect(h.chats[0].text).toMatch(/Google Gemini API key/);
    expect(h.chats[0].text).toMatch(/aistudio\.google\.com/);
  });

  test("simple reply posts as ✦ Gemini", async () => {
    const h = harness();
    h.deps.fetchImpl = modelReply({ content: "Love it — pricing first!" }, h);
    await runGeminiTurn("C1", "@gemini what do you think?", "Ada", h.deps);
    expect(h.chats.length).toBe(1);
    expect(h.chats[0]).toMatchObject({ fromId: "gemini", fromName: "✦ Gemini", text: "Love it — pricing first!" });
  });

  test("hits the Google endpoint with the right model and Bearer auth", async () => {
    const h = harness();
    h.deps.fetchImpl = modelReply({ content: "hi" }, h);
    await runGeminiTurn("C1", "@gemini hi", "Ada", h.deps);
    expect(h.requests.length).toBe(1);
    const { url, init } = h.requests[0];
    expect(url).toBe(GEMINI_API_URL);
    expect(init.headers.Authorization).toBe("Bearer test-gemini-key-123");
    const body = JSON.parse(init.body);
    expect(body.model).toBe(GEMINI_MODEL);
    expect(body.tools.map((t: any) => t.function.name)).toContain("add_sticky");
  });

  test("tool call applies an op, then the follow-up reply posts", async () => {
    const h = harness();
    const toolMsg = {
      content: null,
      tool_calls: [tc("add_sticky", { text: "free trials", color: "green" })],
    };
    let i = 0;
    h.deps.fetchImpl = async (url: string, init: any) => {
      h.requests.push({ url, init });
      const message = i++ === 0 ? toolMsg : { content: "Added it in green." };
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    };
    await runGeminiTurn("C1", "@gemini add a sticky about free trials", "Ada", h.deps);
    expect(h.applied.length).toBe(1);
    expect(h.applied[0].kind).toBe("add");
    expect((h.applied[0] as any).obj.text).toBe("free trials");
    expect((h.applied[0] as any).obj.color).toBe("green");
    expect(h.chats.length).toBe(1);
    expect(h.chats[0].text).toBe("Added it in green.");
  });

  test("propose_widget saves a draft attributed to gemini", async () => {
    const h = harness();
    const toolMsg = {
      content: null,
      tool_calls: [tc("propose_widget", { name: "mood-meter", description: "a mood dial" })],
    };
    let i = 0;
    h.deps.fetchImpl = async (url: string, init: any) => {
      const message = i++ === 0 ? toolMsg : { content: "Drafted it — check the Lab." };
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    };
    await runGeminiTurn("C1", "@gemini build a mood widget", "Ada", h.deps);
    const wtypes = (h as any).wtypes;
    expect(wtypes.length).toBe(1);
    expect(wtypes[0]).toMatchObject({ name: "mood-meter", status: "draft", created_by: "gemini" });
  });

  test("busy guard is per-participant: spark busy does not block gemini", async () => {
    _resetSparkBusyForTests();
    _resetGeminiBusyForTests();
    // Spark's fetch waits on a gate -> runSparkTurn holds the spark busy slot.
    const sparkGate = deferredFetch();
    const sparkH = harness({ fetchImpl: sparkGate.impl });
    const gemH = harness();
    gemH.deps.fetchImpl = modelReply({ content: "Gemini here!" }, gemH);
    const sparkRun = runSparkTurn("C1", "@spark think hard", "Ada", sparkH.deps);
    // Give spark's turn a tick to grab its busy slot.
    await new Promise((r) => setTimeout(r, 20));
    await runGeminiTurn("C1", "@gemini hi", "Ada", gemH.deps);
    expect(gemH.chats.length).toBe(1);
    expect(gemH.chats[0].text).toBe("Gemini here!");
    // Release spark so its turn finishes and clears its busy slot.
    sparkGate.release();
    await sparkRun;
    expect(sparkH.chats.length).toBe(1);
  });

  test("second concurrent gemini turn gets a wait message", async () => {
    _resetGeminiBusyForTests();
    const gate = deferredFetch();
    const h1 = harness({ fetchImpl: gate.impl });
    const h2 = harness({ fetchImpl: gate.impl });
    const first = runGeminiTurn("C1", "@gemini one", "Ada", h1.deps);
    await new Promise((r) => setTimeout(r, 20));
    await runGeminiTurn("C1", "@gemini two", "Ada", h2.deps);
    expect(h2.chats.length).toBe(1);
    expect(h2.chats[0].text).toMatch(/still thinking/);
    gate.release();
    await first;
    expect(h1.chats.length).toBe(1);
  });

  test("API error posts a graceful snag message, never the key", async () => {
    const h = harness();
    h.deps.fetchImpl = async () => new Response("bad key", { status: 401 });
    await runGeminiTurn("C1", "@gemini hi", "Ada", h.deps);
    expect(h.chats.length).toBe(1);
    expect(h.chats[0].text).toMatch(/snag/);
    expect(h.chats[0].text).not.toContain("test-gemini-key-123");
  });
});
