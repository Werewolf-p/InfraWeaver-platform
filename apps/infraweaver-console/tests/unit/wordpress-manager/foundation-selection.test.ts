import {
  applyRange,
  clearSelection,
  isAllSelected,
  isIndeterminate,
  rangeBetween,
  selectAllIds,
  toggleId,
} from "@/addons/wordpress-manager/lib/manage/selection";

const ALL = ["a", "b", "c", "d", "e"];

describe("selection generic primitives", () => {
  test("toggleId adds then removes an id without mutating the input", () => {
    const empty = new Set<string>();
    const withB = toggleId(empty, "b");
    expect([...withB]).toEqual(["b"]);
    expect(empty.size).toBe(0); // input untouched
    expect([...toggleId(withB, "b")]).toEqual([]);
  });

  test("selectAllIds selects the whole universe; clearSelection empties it", () => {
    expect(isAllSelected(ALL, selectAllIds(ALL))).toBe(true);
    expect(clearSelection().size).toBe(0);
  });

  test("isIndeterminate is true only for a partial, non-empty selection", () => {
    expect(isIndeterminate(ALL, new Set())).toBe(false);
    expect(isIndeterminate(ALL, new Set(["a"]))).toBe(true);
    expect(isIndeterminate(ALL, new Set(ALL))).toBe(false);
  });
});

describe("rangeBetween", () => {
  test("returns the inclusive slice regardless of click order", () => {
    expect(rangeBetween(ALL, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(ALL, "d", "b")).toEqual(["b", "c", "d"]);
  });

  test("a single id yields just that id", () => {
    expect(rangeBetween(ALL, "c", "c")).toEqual(["c"]);
  });

  test("returns [] when either id is absent", () => {
    expect(rangeBetween(ALL, "z", "b")).toEqual([]);
    expect(rangeBetween(ALL, "b", "z")).toEqual([]);
  });
});

describe("applyRange", () => {
  test("adds a batch of ids, returning a new set", () => {
    const start = new Set(["a"]);
    const next = applyRange(start, ["b", "c"], true);
    expect([...next].sort()).toEqual(["a", "b", "c"]);
    expect([...start]).toEqual(["a"]); // immutable
  });

  test("removes a batch of ids when select is false", () => {
    const next = applyRange(new Set(["a", "b", "c"]), ["b", "c"], false);
    expect([...next]).toEqual(["a"]);
  });
});
