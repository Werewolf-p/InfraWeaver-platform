import {
  fieldNum,
  fieldStr,
  parseJsonArray,
  parseJsonObject,
  parseKv,
  safeWpArg,
  sliceJson,
  toInt,
  toNum,
  toStr,
} from "@/addons/wordpress-manager/lib/manage/wp-probe";
import { parseUpdates } from "@/addons/wordpress-manager/lib/manage/probes/updates";

describe("wp-probe helpers", () => {
  test("safeWpArg passes slugs/versions and rejects shell metacharacters", () => {
    expect(safeWpArg("woocommerce")).toBe("woocommerce");
    expect(safeWpArg("6.5.2")).toBe("6.5.2");
    for (const bad of ["a b", "a;rm -rf", "$(x)", "a|b", "`x`", "a&b", ""]) {
      expect(() => safeWpArg(bad)).toThrow();
    }
  });

  test("parseKv reads KEY=VALUE lines and tolerates noise", () => {
    const kv = parseKv("WP_VERSION=6.5.2\nPHP_VERSION=8.2.1\nSuccess: done\n=bad\n");
    expect(kv.get("WP_VERSION")).toBe("6.5.2");
    expect(kv.get("PHP_VERSION")).toBe("8.2.1");
    expect(kv.has("Success: done")).toBe(false);
  });

  test("numeric + string coercion handles units and blanks", () => {
    expect(toInt("12")).toBe(12);
    expect(toInt("")).toBeNull();
    expect(toInt(undefined)).toBeNull();
    expect(toNum("42.5mb")).toBe(42.5);
    expect(toNum("90%")).toBe(90);
    expect(toStr("  x ")).toBe("x");
    expect(toStr("   ")).toBeNull();
  });

  test("sliceJson extracts JSON even with wp-cli chatter around it", () => {
    expect(sliceJson('Warning: x\n[{"a":1}]\n')).toBe('[{"a":1}]');
    expect(sliceJson('{"k":"v"} trailing')).toBe('{"k":"v"}');
    expect(sliceJson("Success: nothing to do")).toBeNull();
  });

  test("parseJsonArray/Object are lenient on bad input", () => {
    expect(parseJsonArray('[{"name":"a"},{"name":"b"}]')).toHaveLength(2);
    expect(parseJsonArray("not json")).toEqual([]);
    expect(parseJsonObject('{"x":1}')).toEqual({ x: 1 });
    expect(parseJsonObject("[]")).toBeNull();
  });

  test("field accessors narrow cells safely", () => {
    const row = { name: "woo", count: "7", empty: "" } as Record<string, unknown>;
    expect(fieldStr(row, "name")).toBe("woo");
    expect(fieldStr(row, "empty")).toBeNull();
    expect(fieldNum(row, "count")).toBe(7);
    expect(fieldNum(row, "missing")).toBeNull();
  });
});

describe("parseUpdates", () => {
  test("builds core + plugin + theme components from wp-cli output", () => {
    const data = parseUpdates({
      scalars: "WP_VERSION=6.5.1\nPHP_VERSION=8.2.10",
      core: '[{"version":"6.5.3"}]',
      plugins: '[{"name":"akismet","title":"Akismet","version":"5.0","update_version":"5.3"}]',
      themes: '[{"name":"twentytwentyfour","title":"Twenty Twenty-Four","version":"1.0","update_version":"1.1"}]',
      allPlugins: '[{"name":"akismet","auto_update":"on"},{"name":"hello","auto_update":"off"}]',
    });
    expect(data.core.upToDate).toBe(false);
    expect(data.core.current).toBe("6.5.1");
    expect(data.core.latest).toBe("6.5.3");
    expect(data.components.map((c) => c.kind)).toEqual(["core", "plugin", "theme"]);
    expect(data.autoUpdatePlugins).toBe(1);
    expect(data.totalPlugins).toBe(2);
  });

  test("no available updates ⇒ core up to date, empty components", () => {
    const data = parseUpdates({
      scalars: "WP_VERSION=6.5.3\nPHP_VERSION=8.3.0",
      core: "Success: WordPress is at the latest version.",
      plugins: "[]",
      themes: "[]",
      allPlugins: "[]",
    });
    expect(data.core.upToDate).toBe(true);
    expect(data.components).toHaveLength(0);
  });
});
