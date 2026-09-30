import { describe, test, expect } from "bun:test";
import {
  validateWidgetName,
  validateWidgetType,
  scaffoldWidgetType,
  buildWidgetSrcdoc,
  isPlainData,
  dataSizeOk,
  WIDGET_DATA_LIMIT,
} from "../src/widgets";

describe("widget type validation", () => {
  test("names: ok, bad chars, reserved", () => {
    expect(validateWidgetName("scoreboard")).toBeNull();
    expect(validateWidgetName("my-widget-2")).toBeNull();
    expect(validateWidgetName("Poll")).not.toBeNull();
    expect(validateWidgetName("checklist")).not.toBeNull();
    expect(validateWidgetName("a")).not.toBeNull();
    expect(validateWidgetName("has space")).not.toBeNull();
    expect(validateWidgetName("UPPER")).not.toBeNull();
    expect(validateWidgetName("x".repeat(25))).not.toBeNull();
  });

  test("scaffold passes validation", () => {
    const s = scaffoldWidgetType("scoreboard", "two teams, +1 buttons", "Ada");
    expect(s.status).toBe("draft");
    expect(s.created_by).toBe("Ada");
    expect(validateWidgetType(s)).toBeNull();
  });

  test("script must define render(state)", () => {
    const s = scaffoldWidgetType("x-y", "desc", "");
    expect(validateWidgetType({ ...s, script: "var x = 1;" })).toMatch(/render/);
  });

  test("height bounds and size limits", () => {
    const s = scaffoldWidgetType("x-y", "desc", "");
    expect(validateWidgetType({ ...s, height: 50 })).toMatch(/height/);
    expect(validateWidgetType({ ...s, height: 900 })).toMatch(/height/);
    expect(validateWidgetType({ ...s, style: "x".repeat(20000) })).toMatch(/style/);
    expect(validateWidgetType({ ...s, title: "" })).toMatch(/title/);
  });

  test("fields validation", () => {
    const s = scaffoldWidgetType("x-y", "desc", "");
    expect(validateWidgetType({ ...s, fields: [{ key: "teamA", label: "Team A" }] })).toBeNull();
    expect(validateWidgetType({ ...s, fields: [{ key: "9bad", label: "x" }] })).toMatch(/field key/);
  });
});

describe("widget data guards", () => {
  test("isPlainData rejects prototype pollution and arrays", () => {
    expect(isPlainData({ a: 1 })).toBe(true);
    expect(isPlainData([1])).toBe(false);
    expect(isPlainData(null)).toBe(false);
    expect(isPlainData(JSON.parse('{"__proto__":1}'))).toBe(false);
    expect(isPlainData({ "a-b": 1 })).toBe(false);
  });

  test("dataSizeOk caps at 16KB", () => {
    expect(dataSizeOk({ a: 1 })).toBe(true);
    expect(dataSizeOk({ big: "x".repeat(WIDGET_DATA_LIMIT) })).toBe(false);
  });
});

describe("buildWidgetSrcdoc", () => {
  const type = scaffoldWidgetType("demo", "desc", "");

  test("embeds id, data, and a no-network CSP", () => {
    const html = buildWidgetSrcdoc(type, "w123", { count: 3 });
    expect(html).toContain("w123");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("function render(");
    expect(html).toContain("api.setState");
    expect(html).toContain("ip-widget-set");
    expect(html).toContain("ip-widget-state");
  });

  test("escapes closing script tags in data and code", () => {
    const evil = { ...type, script: "function render(s){return '</scr'+'ipt>';}" };
    const html = buildWidgetSrcdoc(evil, "w1", { x: "</script><script>alert(1)" });
    // No literal </script> may appear inside the script block except the real closer.
    const withoutCloser = html.replace(/<\/script><\/body><\/html>$/, "");
    expect(withoutCloser).not.toContain("</script>");
  });

  test("falls back to empty data for non-plain input", () => {
    const html = buildWidgetSrcdoc(type, "w1", [1, 2] as any);
    expect(html).toContain("var state={}");
  });
});
