// Idea Party — Spark (Muse Spark participant) tests.
// The model API is always faked via injected fetchImpl — no network, no key.

import { describe, test, expect } from "bun:test";
import {
  stripSparkPrefix,
  isSparkMention,
  toolCallToOps,
  buildContextBlock,
  runSparkTurn,
  _resetBusyForTests,
  SPARK_TOOLS,
  SPARK_MODEL,
  SPARK_API_URL,
  SPARK_KEY_ID,
  type SparkDeps,
  type ToolCall,
  type ChatMsg,
} from "../src/spark";
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
  deps: SparkDeps;
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
    key: opts.key ?? "test-key-123",
  } as any;
  h.deps = {
    resolveKey: (id: string) => (id === SPARK_KEY_ID ? h.key : ""),
    boardObjects: () => JSON.parse(JSON.stringify(h.objects)),
    recentChat: (_limit: number): ChatMsg[] => [
      { from: "p1", name: "Ada", text: "let's brainstorm pricing", ts: 1 },
      { from: "p2", name: "Bo", text: "@spark add a sticky about free trials", ts: 2 },
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

function modelReply(message: any): any {
  return async (url: string, init: any) => {
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  };
}

function modelReplySequence(messages: any[]): any {
  let i = 0;
  return async (url: string, init: any) => {
    const message = messages[Math.min(i++, messages.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  };
}

describe("spark mention detection", () => {
  test("matches @spark / spark: / spark prefixes", () => {
    for (const t of ["@spark hello", "spark: hello", "spark hello", "  @Spark:  hi ", "@spark"]) {
      expect(isSparkMention(t)).toBe(true);
    }
  });
  test("does not match lookalikes", () => {
    for (const t of ["sparks fly", "agent: hello", "hey sparkplug", "what a spark"]) {
      expect(isSparkMention(t)).toBe(false);
    }
  });
  test("stripSparkPrefix", () => {
    expect(stripSparkPrefix("@spark: add sticky hi")).toBe("add sticky hi");
    expect(stripSparkPrefix("spark hello there")).toBe("hello there");
    expect(stripSparkPrefix("@spark")).toBe("");
  });
});

describe("spark tools", () => {
  test("no clear/wipe tool is exposed", () => {
    const names = SPARK_TOOLS.map((t: any) => t.function.name);
    expect(names).not.toContain("clear");
    expect(names).not.toContain("clear_board");
  });

  test("add_sticky compiles to a sticky add op", () => {
    const r = toolCallToOps(tc("add_sticky", { text: "Free trials", color: "green", x: 100, y: 200 }), board());
    expect(r.ops).toHaveLength(1);
    expect(r.ops[0].kind).toBe("add");
    expect((r.ops[0] as any).obj.type).toBe("sticky");
    expect((r.ops[0] as any).obj.text).toBe("Free trials");
    expect((r.ops[0] as any).obj.color).toBe("green");
    expect((r.ops[0] as any).obj.x).toBe(100);
    expect(r.result).toContain("Free trials");
  });

  test("add_sticky without text errors", () => {
    const r = toolCallToOps(tc("add_sticky", { color: "pink" }), board());
    expect(r.ops).toHaveLength(0);
    expect(r.result).toMatch(/error/i);
  });

  test("add_label, move, delete compile", () => {
    const b = board();
    const l = toolCallToOps(tc("add_label", { text: "Costs" }), b);
    expect((l.ops[0] as any).obj.type).toBe("label");
    const mv = toolCallToOps(tc("move_object", { query: "Raise prices", x: 5, y: 6 }), b);
    expect(mv.ops[0]).toMatchObject({ kind: "move", id: "s1", x: 5, y: 6 });
    const del = toolCallToOps(tc("delete_object", { query: "New logo" }), b);
    expect(del.ops[0]).toMatchObject({ kind: "del", id: "s2" });
  });

  test("move/delete with unknown query finds nothing", () => {
    const r = toolCallToOps(tc("move_object", { query: "nope nothing", x: 1, y: 1 }), board());
    expect(r.ops).toHaveLength(0);
    expect(r.result).toContain("Couldn't find");
  });

  test("edit_object text and color produce edit ops", () => {
    const b = board();
    const t = toolCallToOps(tc("edit_object", { query: "Raise prices", text: "Lower prices" }), b);
    expect(t.ops[0]).toMatchObject({ kind: "edit", id: "s1", patch: { text: "Lower prices" } });
    const c = toolCallToOps(tc("edit_object", { query: "s2", color: "blue" }), b);
    expect(c.ops[0]).toMatchObject({ kind: "edit", id: "s2", patch: { color: "blue" } });
    const bad = toolCallToOps(tc("edit_object", { query: "s1", color: "magenta" }), b);
    expect(bad.ops).toHaveLength(0);
    expect(bad.result).toMatch(/error/i);
  });

  test("arrange / cluster / voting / count / timer", () => {
    const b = board();
    const arr = toolCallToOps(tc("arrange_board", {}), b);
    expect(arr.ops.length).toBeGreaterThan(0);
    expect(arr.ops[0].kind).toBe("move");
    const cl = toolCallToOps(tc("cluster_board", {}), b);
    expect(cl.ops.some((o) => o.kind === "add")).toBe(true);
    const vs = toolCallToOps(tc("start_voting", {}), b);
    expect(vs.ops[0]).toMatchObject({ kind: "mode", key: "vote", value: true });
    const tally = toolCallToOps(tc("tally_votes", {}), b);
    expect(tally.ops).toHaveLength(0);
    expect(tally.result).toContain("Raise prices");
    const count = toolCallToOps(tc("board_count", {}), b);
    expect(count.result).toContain("2 stickies");
    const timer = toolCallToOps(tc("set_timer", { minutes: 5 }), b);
    expect(timer.timer).toBe(5);
    expect(timer.ops).toHaveLength(0);
    const badTimer = toolCallToOps(tc("set_timer", { minutes: "soon" }), b);
    expect(badTimer.result).toMatch(/error/i);
  });

  test("unknown tool and bad JSON error cleanly", () => {
    const u = toolCallToOps(tc("nuke_board", {}), board());
    expect(u.result).toMatch(/unknown tool/);
    const j = toolCallToOps({ id: "x", function: { name: "add_sticky", arguments: "{oops" } }, board());
    expect(j.result).toMatch(/error/i);
  });
});

describe("context block", () => {
  test("includes party name, board text, and chat", () => {
    const h = harness();
    const ctx = buildContextBlock(h.deps);
    expect(ctx).toContain("Friday brainstorm");
    expect(ctx).toContain("Raise prices");
    expect(ctx).toContain("Ada: let's brainstorm pricing");
  });
});

describe("runSparkTurn", () => {
  test("no key -> settings hint, no API call", async () => {
    const h = harness({ key: "" });
    let fetched = false;
    h.deps.fetchImpl = (async () => { fetched = true; throw new Error("nope"); }) as any;
    await runSparkTurn("c1", "@spark hello", "Ada", h.deps);
    expect(fetched).toBe(false);
    expect(h.chats).toHaveLength(1);
    expect(h.chats[0].fromId).toBe("spark");
    expect(h.chats[0].text).toMatch(/Settings/);
    expect(h.applied).toHaveLength(0);
    _resetBusyForTests();
  });

  test("tool call round-trip: ops applied, reply posted, key stays secret", async () => {
    const calls: any[] = [];
    const scripted = [
      { role: "assistant", content: null, tool_calls: [tc("add_sticky", { text: "Spark was here", color: "pink" })] },
      { role: "assistant", content: "Added a sticky for us." },
    ];
    const h = harness({
      fetchImpl: async (url: string, init: any) => {
        calls.push({ url, init: JSON.parse(init.body) });
        return new Response(JSON.stringify({ choices: [{ message: scripted[calls.length - 1] }] }), { status: 200 });
      },
    });
    await runSparkTurn("c2", "@spark put a pink sticky on the board", "Bo", h.deps);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(SPARK_API_URL);
    expect(calls[0].init.model).toBe(SPARK_MODEL);
    expect(JSON.stringify(calls[0].init.messages)).toContain("Raise prices"); // board context sent
    expect(h.applied).toHaveLength(1);
    expect((h.applied[0] as any).obj.text).toBe("Spark was here");
    expect(h.chats).toHaveLength(1);
    expect(h.chats[0]).toMatchObject({ fromId: "spark", fromName: "✨ Spark", text: "Added a sticky for us." });
    expect(h.chats[0].text).not.toContain("test-key-123");
    _resetBusyForTests();
  });

  test("sends bearer auth and tool definitions", async () => {
    let seen: any;
    const h = harness({
      fetchImpl: modelReply({ role: "assistant", content: "hi" }),
    });
    const orig = h.deps.fetchImpl;
    h.deps.fetchImpl = (async (url: string, init: any) => {
      seen = init;
      return orig(url, init);
    }) as any;
    await runSparkTurn("c3", "@spark hi", "Ada", h.deps);
    expect(seen.headers.Authorization).toBe("Bearer test-key-123");
    expect(seen.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(seen.body);
    expect(body.tools.map((t: any) => t.function.name)).toContain("add_sticky");
    expect(body.tool_choice).toBe("auto");
    _resetBusyForTests();
  });

  test("API error -> graceful chat message, no throw", async () => {
    const h = harness({
      fetchImpl: async () => new Response("bad key", { status: 401 }),
    });
    await runSparkTurn("c4", "@spark hi", "Ada", h.deps);
    expect(h.chats).toHaveLength(1);
    expect(h.chats[0].text).toMatch(/snag/);
    expect(h.chats[0].text).toContain("401");
    _resetBusyForTests();
  });

  test("busy party gets a wait message", async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((res) => { release = res; });
    const h = harness({ fetchImpl: () => gate });
    const p1 = runSparkTurn("c5", "@spark one", "Ada", h.deps);
    await new Promise((r) => setTimeout(r, 20)); // let turn 1 reach the API call
    await runSparkTurn("c5", "@spark two", "Bo", h.deps);
    expect(h.chats).toHaveLength(1);
    expect(h.chats[0].text).toMatch(/Give me a sec/);
    release(new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }), { status: 200 }));
    await p1;
    expect(h.chats).toHaveLength(2);
    _resetBusyForTests();
  });

  test("timer tool triggers setTimer", async () => {
    const h = harness({
      fetchImpl: (async (url: string, init: any) => {
        const body = JSON.parse(init.body);
        const last = body.messages[body.messages.length - 1];
        if (last.role === "user") {
          return new Response(JSON.stringify({
            choices: [{ message: { role: "assistant", content: null, tool_calls: [tc("set_timer", { minutes: 10 })] } }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Timer's on." } }],
        }), { status: 200 });
      }) as any,
    });
    await runSparkTurn("c6", "@spark timer 10", "Ada", h.deps);
    expect(h.timers).toEqual([{ minutes: 10, by: "Ada" }]);
    _resetBusyForTests();
  });
});

describe("spark widget tools", () => {
  function wboard(): Record<string, CanvasObj> {
    return {
      w1: {
        id: "w1", type: "widget", widget: "poll", x: 0, y: 0, text: "Lunch?",
        data: { options: [{ label: "Pizza", votes: 2 }, { label: "Sushi", votes: 0 }] },
      },
      w2: {
        id: "w2", type: "widget", widget: "checklist", x: 0, y: 0, text: "Setup",
        data: { items: [{ text: "Chairs", done: false }, { text: "Snacks", done: true }] },
      },
    };
  }

  test("create_widget compiles to a widget add op", () => {
    const r = toolCallToOps(
      tc("create_widget", { kind: "poll", title: "Retro?", items: ["Keep", "Drop", "Try"], x: 10, y: 20 }),
      board()
    );
    expect(r.ops).toHaveLength(1);
    const obj = (r.ops[0] as any).obj;
    expect(obj.type).toBe("widget");
    expect(obj.widget).toBe("poll");
    expect(obj.text).toBe("Retro?");
    expect(obj.data.options.map((o: any) => o.label)).toEqual(["Keep", "Drop", "Try"]);
    expect(obj.x).toBe(10);
    expect(r.result).toContain("Retro?");
  });

  test("create_widget validates kind and items", () => {
    expect(toolCallToOps(tc("create_widget", { kind: "quiz", title: "t", items: ["a", "b"] }), board()).result).toMatch(/error/i);
    expect(toolCallToOps(tc("create_widget", { kind: "poll", title: "t", items: ["only"] }), board()).result).toMatch(/at least 2/);
    expect(toolCallToOps(tc("create_widget", { kind: "poll", title: "", items: ["a", "b"] }), board()).result).toMatch(/error/i);
  });

  test("create_widget sanitizes pipe characters", () => {
    const r = toolCallToOps(
      tc("create_widget", { kind: "checklist", title: "a|b", items: ["x|y", "z"] }),
      board()
    );
    const obj = (r.ops[0] as any).obj;
    expect(obj.text).toBe("a/b");
    expect(obj.data.items[0].text).toBe("x/y");
  });

  test("vote_poll emits a 0-based vote op", () => {
    const r = toolCallToOps(tc("vote_poll", { query: "Lunch", option: 2 }), wboard());
    expect(r.ops).toEqual([{ kind: "vote", id: "w1", option: 1 }]);
    expect(r.result).toContain("Sushi");
  });

  test("vote_poll validates target and range", () => {
    expect(toolCallToOps(tc("vote_poll", { query: "Lunch", option: 5 }), wboard()).result).toMatch(/only has 2/);
    expect(toolCallToOps(tc("vote_poll", { query: "Setup", option: 1 }), wboard()).result).toMatch(/not a poll/);
    expect(toolCallToOps(tc("vote_poll", { query: "Lunch", option: 0 }), wboard()).result).toMatch(/error/i);
    expect(toolCallToOps(tc("vote_poll", { query: "nope", option: 1 }), wboard()).result).toContain("Couldn't find");
  });

  test("toggle_checklist_item emits a toggle op", () => {
    const r = toolCallToOps(tc("toggle_checklist_item", { query: "Setup", item: 1 }), wboard());
    expect(r.ops).toEqual([{ kind: "toggle", id: "w2", index: 0 }]);
    expect(r.result).toContain("Chairs");
    expect(toolCallToOps(tc("toggle_checklist_item", { query: "Lunch", item: 1 }), wboard()).result).toMatch(/not a checklist/);
  });

  test("board summary shows numbered poll options and checklist state", () => {
    const h = harness();
    h.objects = { ...h.objects, ...wboard() };
    const ctx = buildContextBlock(h.deps);
    expect(ctx).toContain('1. "Pizza" — 2 votes');
    expect(ctx).toContain('2. "Sushi" — 0 votes');
    expect(ctx).toContain("[ ] Chairs");
    expect(ctx).toContain("[x] Snacks");
  });
});

describe("spark widget-type tools", () => {
  const sbType = (over: any = {}) => ({
    name: "scoreboard", title: "Scoreboard", description: "two teams",
    status: "active", fields: [{ key: "teamA", label: "Team A" }],
    example: { teamA: "Home", scoreA: 0 },
    style: "", script: "function render(state){return 'x';}", height: 220,
    version: 1, created_by: "Ada", updated_at: 1, ...over,
  });

  test("propose_widget returns a draft spec action", () => {
    const r = toolCallToOps(
      tc("propose_widget", {
        name: "dice", description: "roll a die",
        script: "function render(state){return '<button>'+state.n+'</button>';}",
      }),
      board(), []
    );
    expect(r.ops).toHaveLength(0);
    expect(r.widgetAction?.kind).toBe("propose");
    expect(r.widgetAction?.spec?.name).toBe("dice");
    expect(r.widgetAction?.spec?.status).toBe("draft");
    expect(r.result).toMatch(/Drafted/);
  });

  test("propose_widget validates name and script", () => {
    const bad = toolCallToOps(tc("propose_widget", { name: "Bad Name!", description: "x" }), board(), []);
    expect(bad.widgetAction).toBeUndefined();
    expect(bad.result).toMatch(/Error/);
    const noRender = toolCallToOps(
      tc("propose_widget", { name: "dice", description: "x", script: "var x=1;" }), board(), []);
    expect(noRender.result).toMatch(/render/);
  });

  test("refine_widget / publish_widget / unpublish_widget actions", () => {
    const ref = toolCallToOps(tc("refine_widget", { name: "dice", script: "function render(state){return 'y';}" }), board(), []);
    expect(ref.widgetAction).toMatchObject({ kind: "refine", name: "dice" });
    expect((ref.widgetAction?.patch as any)?.script).toContain("return 'y'");
    const pub = toolCallToOps(tc("publish_widget", { name: "dice" }), board(), []);
    expect(pub.widgetAction).toMatchObject({ kind: "publish", name: "dice", status: "active" });
    const unp = toolCallToOps(tc("unpublish_widget", { name: "dice" }), board(), []);
    expect(unp.widgetAction).toMatchObject({ kind: "unpublish", status: "draft" });
  });

  test("create_widget with a custom type compiles to add-widget grammar", () => {
    const r = toolCallToOps(
      tc("create_widget", { kind: "scoreboard", title: "Finals", items: ["Lions"] }),
      board(), [sbType()]
    );
    expect(r.ops).toHaveLength(1);
    const obj = (r.ops[0] as any).obj;
    expect(obj.widget).toBe("scoreboard");
    expect(obj.text).toBe("Finals");
    expect(obj.data.teamA).toBe("Lions");
  });

  test("create_widget rejects unknown and draft custom types", () => {
    expect(toolCallToOps(tc("create_widget", { kind: "nope", title: "T" }), board(), []).result).toMatch(/unknown widget type/);
    expect(toolCallToOps(tc("create_widget", { kind: "scoreboard", title: "T" }), board(), [sbType({ status: "draft" })]).result)
      .toMatch(/still a draft/);
  });

  test("update_widget replaces custom widget data", () => {
    const objs: Record<string, CanvasObj> = {
      w1: { id: "w1", type: "widget", widget: "scoreboard", x: 0, y: 0, text: "Finals", data: { scoreA: 0 } },
    };
    const r = toolCallToOps(tc("update_widget", { query: "Finals", data: { scoreA: 7 } }), objs, []);
    expect(r.ops).toEqual([{ kind: "edit", id: "w1", patch: { data: { scoreA: 7 } } }]);
  });

  test("update_widget rejects polls and bad data", () => {
    const objs: Record<string, CanvasObj> = {
      w1: {
        id: "w1", type: "widget", widget: "poll", x: 0, y: 0, text: "Lunch?",
        data: { options: [{ label: "Pizza", votes: 2 }, { label: "Sushi", votes: 0 }] },
      },
    };
    expect(toolCallToOps(tc("update_widget", { query: "Lunch", data: { x: 1 } }), objs, []).result).toMatch(/not a custom widget/);
    expect(toolCallToOps(tc("update_widget", { query: "nope", data: { x: 1 } }), objs, []).result).toMatch(/Couldn't find/);
    const w1: Record<string, CanvasObj> = {
      w1: { id: "w1", type: "widget", widget: "scoreboard", x: 0, y: 0, text: "S", data: {} },
    };
    expect(toolCallToOps(tc("update_widget", { query: "S", data: [1] }), w1, []).result).toMatch(/plain object/);
  });

  test("list_widgets compiles to the widgets grammar", () => {
    const r = toolCallToOps(tc("list_widgets", {}), board(), [sbType()]);
    expect(r.result).toContain("scoreboard");
  });

  test("board summary shows custom widget data", () => {
    const h = harness();
    h.objects.w9 = { id: "w9", type: "widget", widget: "scoreboard", x: 0, y: 0, text: "Finals", data: { scoreA: 3 } };
    const ctx = buildContextBlock(h.deps);
    expect(ctx).toContain("widget scoreboard");
    expect(ctx).toContain('"scoreA":3');
  });

  test("runSparkTurn applies widget actions through deps", async () => {
    const reply = { role: "assistant", content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "propose_widget", arguments: JSON.stringify({
        name: "dice", description: "roll a die",
        script: "function render(state){return 'd';}",
      }) } },
    ] };
    const follow = { role: "assistant", content: "Drafted it — preview in the Lab!" };
    const calls: any[] = [];
    const h = harness({
      fetchImpl: async (url: string, init: any) => {
        calls.push({ url, init: JSON.parse(init.body) });
        const message = [reply, follow][Math.min(calls.length - 1, 1)];
        return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
      },
    });
    await runSparkTurn("code1", "@spark make a dice widget", "Ada", h.deps);
    const saved = (h as any).wtypes.find((t: any) => t.name === "dice");
    expect(saved).toBeTruthy();
    expect(saved.status).toBe("draft");
    const toolMsg = calls[1].init.messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toMatch(/Drafted/);
    expect(h.chats).toHaveLength(1);
    expect(h.chats[0].text).toContain("Drafted it");
    _resetBusyForTests();
  });
});
