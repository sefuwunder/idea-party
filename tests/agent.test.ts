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
