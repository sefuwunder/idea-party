import { describe, test, expect } from "bun:test";
import { parseAgentCommand, applyOp, foldOps, findMatch, type CanvasObj, type AgentOp } from "../src/agent";

function board(): Record<string, CanvasObj> {
  return {
    s1: { id: "s1", type: "sticky", x: 0, y: 0, text: "Raise prices", color: "yellow", votes: 2 },
    s2: { id: "s2", type: "sticky", x: 10, y: 10, text: "New logo", color: "pink", votes: 0 },
  };
}

describe("agent prefix stripping", () => {
  test("agent: / @agent / bare agent all work", () => {
    for (const p of ["agent: help", "@agent help", "agent help", "  Agent:  help "]) {
      const r = parseAgentCommand(p, {});
      expect(r.reply).toContain("I program the board");
    }
  });
});

describe("add", () => {
  test("add sticky with text", () => {
    const r = parseAgentCommand("agent add sticky Ship the new onboarding", board());
    expect(r.ops).toHaveLength(1);
    expect(r.ops[0].kind).toBe("add");
    expect(r.ops[0].obj.type).toBe("sticky");
    expect(r.ops[0].obj.text).toBe("Ship the new onboarding");
    expect(r.ops[0].obj.color).toBe("yellow");
    expect(r.reply).toContain("Added");
  });
  test("add sticky with color and position", () => {
    const r = parseAgentCommand("agent add sticky Fix churn color blue at 300,400", board());
    expect(r.ops[0].obj.color).toBe("blue");
    expect(r.ops[0].obj.x).toBe(300);
    expect(r.ops[0].obj.y).toBe(400);
  });
  test("add label", () => {
    const r = parseAgentCommand("agent add label Sprint ideas at 50,60", board());
    expect(r.ops[0].obj.type).toBe("label");
    expect(r.ops[0].obj.text).toBe("Sprint ideas");
  });
  test("add sticky with no text asks for text", () => {
    const r = parseAgentCommand("agent add sticky   ", board());
    expect(r.ops).toHaveLength(0);
    expect(r.reply).toContain("some text");
  });
});

describe("move / delete / color", () => {
  test("move by text match", () => {
    const r = parseAgentCommand("agent move logo to 500,600", board());
    expect(r.ops).toEqual([{ kind: "move", id: "s2", x: 500, y: 600 }]);
  });
  test("move by id prefix", () => {
    const r = parseAgentCommand("agent move s1 to 1,2", board());
    expect(r.ops[0].id).toBe("s1");
  });
  test("move unknown reports miss", () => {
    const r = parseAgentCommand("agent move zzz to 1,2", board());
    expect(r.ops).toHaveLength(0);
    expect(r.reply).toContain("Couldn't find");
  });
  test("delete", () => {
    const r = parseAgentCommand("agent delete prices", board());
    expect(r.ops).toEqual([{ kind: "del", id: "s1" }]);
  });
  test("color", () => {
    const r = parseAgentCommand("agent color logo green", board());
    expect(r.ops).toEqual([{ kind: "edit", id: "s2", patch: { color: "green" } }]);
  });
});

describe("arrange / cluster", () => {
  test("arrange grids every sticky", () => {
    const r = parseAgentCommand("agent arrange", board());
    expect(r.ops).toHaveLength(2);
    expect(r.ops.every((o) => o.kind === "move")).toBe(true);
    expect(r.reply).toContain("2 stickies");
  });
  test("cluster groups by color with zone labels", () => {
    const r = parseAgentCommand("agent cluster", board());
    const labels = r.ops.filter((o) => o.kind === "add" && o.obj.type === "label");
    const moves = r.ops.filter((o) => o.kind === "move");
    expect(labels).toHaveLength(2); // yellow + pink
    expect(moves).toHaveLength(2);
    expect(labels[0].obj.id).toBe("zone-yellow");
    // idempotent: re-clustering replaces the same zone labels
    const seed: AgentOp[] = (Object.values(board()) as CanvasObj[]).map((o) => ({ kind: "add", obj: o }));
    const objs = foldOps([...seed, ...r.ops]);
    const r2 = parseAgentCommand("agent cluster", objs);
    const labels2 = r2.ops.filter((o) => o.kind === "add");
    expect(labels2.map((o) => o.obj.id).sort()).toEqual(["zone-pink", "zone-yellow"]);
  });
  test("arrange on empty board", () => {
    const r = parseAgentCommand("agent arrange", {});
    expect(r.ops).toHaveLength(0);
  });
});

describe("voting", () => {
  test("vote start/stop emit mode ops", () => {
    expect(parseAgentCommand("agent vote start", board()).ops).toEqual([
      { kind: "mode", key: "vote", value: true },
    ]);
    expect(parseAgentCommand("agent vote stop", board()).ops).toEqual([
      { kind: "mode", key: "vote", value: false },
    ]);
  });
  test("tally ranks by votes", () => {
    const r = parseAgentCommand("agent tally", board());
    expect(r.reply).toContain("Raise prices");
    expect(r.reply).toContain("2 votes");
    expect(r.ops).toHaveLength(0);
  });
  test("tally with no votes", () => {
    const r = parseAgentCommand("agent tally", {});
    expect(r.reply).toContain("No votes");
  });
});

describe("timer / clear / count", () => {
  test("timer returns minutes", () => {
    const r = parseAgentCommand("agent timer 5", board());
    expect(r.timer).toBe(5);
    expect(r.ops).toHaveLength(0);
  });
  test("timer rejects nonsense", () => {
    expect(parseAgentCommand("agent timer 500", board()).timer).toBeUndefined();
    expect(parseAgentCommand("agent timer abc", board()).reply).toContain("didn't understand");
  });
  test("clear needs confirmation", () => {
    const r1 = parseAgentCommand("agent clear", board());
    expect(r1.ops).toHaveLength(0);
    expect(r1.reply).toContain("clear yes");
    const r2 = parseAgentCommand("agent clear yes", board());
    expect(r2.ops).toEqual([{ kind: "clear" }]);
  });
  test("count summarizes", () => {
    const r = parseAgentCommand("agent count", board());
    expect(r.reply).toContain("2 stickies");
    expect(r.reply).toContain("2 votes");
  });
  test("unknown command suggests help", () => {
    const r = parseAgentCommand("agent frobnicate the board", board());
    expect(r.reply).toContain("agent help");
  });
});

describe("fold", () => {
  test("add/move/edit/vote/del/clear fold correctly", () => {
    const objs: Record<string, CanvasObj> = {};
    applyOp(objs, { kind: "add", obj: { id: "a", type: "sticky", x: 1, y: 2, text: "hi", votes: 0 } });
    applyOp(objs, { kind: "move", id: "a", x: 9, y: 9 });
    applyOp(objs, { kind: "vote", id: "a" });
    applyOp(objs, { kind: "edit", id: "a", patch: { color: "blue" } });
    expect(objs.a.x).toBe(9);
    expect(objs.a.votes).toBe(1);
    expect(objs.a.color).toBe("blue");
    applyOp(objs, { kind: "del", id: "a" });
    expect(objs.a).toBeUndefined();
    applyOp(objs, { kind: "add", obj: { id: "b", type: "sticky", x: 0, y: 0, text: "x", votes: 0 } });
    applyOp(objs, { kind: "clear" });
    expect(Object.keys(objs)).toHaveLength(0);
  });
  test("mode ops are ignored by the fold", () => {
    const objs = board();
    applyOp(objs, { kind: "mode", key: "vote", value: true });
    expect(Object.keys(objs)).toHaveLength(2);
  });
  test("findMatch prefers id prefix over text", () => {
    const hit = findMatch("s1", board());
    expect(hit!.id).toBe("s1");
    expect(findMatch("logo", board())!.id).toBe("s2");
    expect(findMatch("nope", board())).toBeNull();
  });
});

describe("widgets", () => {
  test("add widget poll parses question and options", () => {
    const r = parseAgentCommand("add widget poll Best date? | Oct 12 | Oct 19 | Nov 2", {});
    expect(r.ops).toHaveLength(1);
    const obj = (r.ops[0] as any).obj;
    expect(obj.type).toBe("widget");
    expect(obj.widget).toBe("poll");
    expect(obj.text).toBe("Best date?");
    expect(obj.data.options).toEqual([
      { label: "Oct 12", votes: 0 },
      { label: "Oct 19", votes: 0 },
      { label: "Nov 2", votes: 0 },
    ]);
    expect(r.reply).toContain("Best date?");
  });

  test("add widget checklist parses title and items", () => {
    const r = parseAgentCommand("agent: add widget checklist Setup | Chairs | Snacks", {});
    const obj = (r.ops[0] as any).obj;
    expect(obj.widget).toBe("checklist");
    expect(obj.data.items).toEqual([
      { text: "Chairs", done: false },
      { text: "Snacks", done: false },
    ]);
  });

  test("add widget validates entries", () => {
    expect(parseAgentCommand("add widget poll Lonely?", {}).ops).toHaveLength(0);
    expect(parseAgentCommand("add widget poll Q? | only-one", {}).reply).toMatch(/at least 2/);
    expect(parseAgentCommand("add widget poll Q? | " + Array(9).fill("x").join(" | "), {}).reply).toMatch(/8 entries max/);
    expect(parseAgentCommand("add widget poll", {}).reply).toMatch(/Usage:/);
  });

  test("add widget supports at x,y", () => {
    const r = parseAgentCommand("add widget poll Q? | a | b at 400,300", {});
    const obj = (r.ops[0] as any).obj;
    expect(obj.x).toBe(400);
    expect(obj.y).toBe(300);
    expect(obj.data.options.map((o: any) => o.label)).toEqual(["a", "b"]);
  });

  test("vote op with option increments poll option votes", () => {
    const objs = foldOps([
      { kind: "add", obj: { id: "w1", type: "widget", widget: "poll", x: 0, y: 0, text: "Q?", data: { options: [{ label: "a", votes: 0 }, { label: "b", votes: 0 }] } } },
    ]);
    applyOp(objs, { kind: "vote", id: "w1", option: 1 });
    applyOp(objs, { kind: "vote", id: "w1", option: 1 });
    applyOp(objs, { kind: "vote", id: "w1", option: 0 });
    expect(objs.w1.data!.options![0].votes).toBe(1);
    expect(objs.w1.data!.options![1].votes).toBe(2);
    // out-of-range option is a safe no-op
    applyOp(objs, { kind: "vote", id: "w1", option: 7 });
    expect(objs.w1.data!.options![1].votes).toBe(2);
  });

  test("vote op with option does not touch sticky votes", () => {
    const objs = board();
    applyOp(objs, { kind: "vote", id: "s1", option: 0 });
    expect(objs.s1.votes).toBe(2); // unchanged
    applyOp(objs, { kind: "vote", id: "s1" });
    expect(objs.s1.votes).toBe(3);
  });

  test("toggle op flips checklist items", () => {
    const objs = foldOps([
      { kind: "add", obj: { id: "w2", type: "widget", widget: "checklist", x: 0, y: 0, text: "T", data: { items: [{ text: "a", done: false }, { text: "b", done: true }] } } },
    ]);
    applyOp(objs, { kind: "toggle", id: "w2", index: 0 });
    expect(objs.w2.data!.items![0].done).toBe(true);
    applyOp(objs, { kind: "toggle", id: "w2", index: 0 });
    expect(objs.w2.data!.items![0].done).toBe(false);
    // bad index / wrong target are safe no-ops
    applyOp(objs, { kind: "toggle", id: "w2", index: 9 });
    applyOp(objs, { kind: "toggle", id: "nope", index: 0 });
    expect(objs.w2.data!.items![1].done).toBe(true);
  });

  test("count includes widgets", () => {
    const objs = foldOps([
      { kind: "add", obj: { id: "w1", type: "widget", widget: "poll", x: 0, y: 0, text: "Q?", data: { options: [{ label: "a", votes: 0 }, { label: "b", votes: 0 }] } } },
    ]);
    const r = parseAgentCommand("agent: count", objs);
    expect(r.reply).toContain("1 widget");
  });

  test("findMatch finds widgets by title", () => {
    const objs = foldOps([
      { kind: "add", obj: { id: "w9", type: "widget", widget: "poll", x: 0, y: 0, text: "Lunch plans?", data: { options: [{ label: "a", votes: 0 }, { label: "b", votes: 0 }] } } },
    ]);
    expect(findMatch("lunch", objs)!.id).toBe("w9");
    const r = parseAgentCommand("agent: delete lunch plans?", objs);
    expect(r.ops[0]).toMatchObject({ kind: "del", id: "w9" });
  });
});

describe("widget types (mini apps)", () => {
  const sb = {
    name: "scoreboard", title: "Scoreboard", description: "two teams",
    status: "active" as const, fields: [{ key: "teamA", label: "Team A" }, { key: "teamB", label: "Team B" }],
    example: { teamA: "Home", teamB: "Away", scoreA: 0, scoreB: 0 },
    style: "", script: "function render(state){return 'x';}", height: 220,
    version: 1, created_by: "Ada", updated_at: 1,
  };
  const draft = { ...sb, name: "idea-vault", title: "Idea Vault", status: "draft" as const };

  test("build widget scaffolds a draft action", () => {
    const r = parseAgentCommand('agent: build widget scoreboard "two teams, +1 buttons"', {}, []);
    expect(r.ops).toHaveLength(0);
    expect(r.widgetType).toMatchObject({ action: "propose", name: "scoreboard" });
    expect(r.widgetType!.description).toContain("two teams");
    expect(r.reply).toMatch(/Scaffold/);
  });

  test("build widget validates name and duplicates", () => {
    expect(parseAgentCommand("agent: build widget Poll x", {}, []).widgetType).toBeUndefined();
    expect(parseAgentCommand("agent: build widget Poll x", {}, []).reply).toMatch(/Can't use that name/);
    const dup = parseAgentCommand("agent: build widget scoreboard x", {}, [sb]);
    expect(dup.widgetType).toBeUndefined();
    expect(dup.reply).toMatch(/already/);
  });

  test("widgets lists active and drafts", () => {
    const r = parseAgentCommand("agent: widgets", {}, [sb, draft]);
    expect(r.reply).toContain("scoreboard");
    expect(r.reply).toContain("[active]");
    expect(r.reply).toContain("idea-vault");
    expect(r.reply).toContain("[draft]");
    const empty = parseAgentCommand("agent: widgets", {}, []);
    expect(empty.reply).toMatch(/No custom widget types/);
  });

  test("publish / unpublish widget actions", () => {
    expect(parseAgentCommand("agent: publish widget idea-vault", {}, [sb, draft]).widgetType)
      .toMatchObject({ action: "publish", name: "idea-vault" });
    expect(parseAgentCommand("agent: publish widget scoreboard", {}, [sb]).reply).toMatch(/already live/);
    expect(parseAgentCommand("agent: unpublish widget scoreboard", {}, [sb]).widgetType)
      .toMatchObject({ action: "unpublish", name: "scoreboard" });
    expect(parseAgentCommand("agent: publish widget nope", {}, []).reply).toMatch(/No widget type/);
  });

  test("add widget <custom> maps values onto fields", () => {
    const r = parseAgentCommand("agent: add widget scoreboard Finals | Lions | Tigers", {}, [sb]);
    expect(r.ops).toHaveLength(1);
    const obj = (r.ops[0] as any).obj;
    expect(obj.type).toBe("widget");
    expect(obj.widget).toBe("scoreboard");
    expect(obj.text).toBe("Finals");
    expect(obj.data.teamA).toBe("Lions");
    expect(obj.data.teamB).toBe("Tigers");
    expect(obj.data.scoreA).toBe(0); // example defaults kept
  });

  test("add widget rejects unknown and draft types", () => {
    expect(parseAgentCommand("agent: add widget nope T", {}, [sb]).reply).toMatch(/No widget type/);
    expect(parseAgentCommand("agent: add widget idea-vault T", {}, [sb, draft]).reply).toMatch(/still a draft/);
  });

  test("edit op with data folds for custom widgets only", () => {
    const objs = foldOps([
      { kind: "add", obj: { id: "w1", type: "widget", widget: "scoreboard", x: 0, y: 0, text: "S", data: { scoreA: 0 } } },
      { kind: "add", obj: { id: "w2", type: "widget", widget: "poll", x: 0, y: 0, text: "P", data: { options: [{ label: "a", votes: 0 }, { label: "b", votes: 0 }] } } },
    ]);
    applyOp(objs, { kind: "edit", id: "w1", patch: { data: { scoreA: 5 } } });
    expect(objs.w1.data).toEqual({ scoreA: 5 });
    applyOp(objs, { kind: "edit", id: "w2", patch: { data: { hacked: true } } });
    expect((objs.w2.data as any).hacked).toBeUndefined();
  });
});
