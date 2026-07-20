// Pure selection logic backing the fleet overview's bulk-action controls.
// Covers the header controls (select-all / none / invert), the "all but one"
// flow (select-all then untick one), tri-state derivation, and stale pruning
// across a fleet refetch. All helpers must be immutable — the input Set is
// never mutated.
import {
  toggleSite,
  selectAll,
  selectNone,
  invertSelection,
  pruneSelection,
  orderedSelection,
  isAllSelected,
  isIndeterminate,
  countSelected,
} from "@/addons/wordpress-manager/lib/selection";

const FLEET = ["blog", "shop", "docs", "news"] as const;

describe("selectAll / selectNone", () => {
  test("selectAll picks every visible site", () => {
    expect([...selectAll(FLEET)].sort()).toEqual([...FLEET].sort());
  });

  test("selectNone clears everything", () => {
    expect(selectNone().size).toBe(0);
  });
});

describe("toggleSite", () => {
  test("adds an absent site and removes a present one without mutating the input", () => {
    const start = new Set<string>(["blog"]);

    const added = toggleSite(start, "shop");
    expect([...added].sort()).toEqual(["blog", "shop"]);

    const removed = toggleSite(start, "blog");
    expect([...removed]).toEqual([]);

    // Input untouched.
    expect([...start]).toEqual(["blog"]);
  });
});

describe("invertSelection", () => {
  test("flips selection within the universe", () => {
    const selection = new Set<string>(["blog"]);
    expect([...invertSelection(FLEET, selection)]).toEqual(["shop", "docs", "news"]);
  });

  test("inverting twice returns the original selection", () => {
    const selection = new Set<string>(["blog", "docs"]);
    const once = invertSelection(FLEET, selection);
    const twice = invertSelection(FLEET, once);
    expect([...twice].sort()).toEqual([...selection].sort());
  });

  test("drops names outside the universe", () => {
    const selection = new Set<string>(["ghost"]);
    expect([...invertSelection(FLEET, selection)].sort()).toEqual([...FLEET].sort());
  });
});

describe('"all but one" flow', () => {
  test("select-all then untick one leaves everything except that site", () => {
    const all = selectAll(FLEET);
    const allButShop = toggleSite(all, "shop");
    expect([...allButShop].sort()).toEqual(["blog", "docs", "news"].sort());
    expect(countSelected(FLEET, allButShop)).toBe(3);
    expect(isAllSelected(FLEET, allButShop)).toBe(false);
    expect(isIndeterminate(FLEET, allButShop)).toBe(true);
  });
});

describe("tri-state derivation", () => {
  test("none selected -> not all, not indeterminate", () => {
    const none = selectNone();
    expect(isAllSelected(FLEET, none)).toBe(false);
    expect(isIndeterminate(FLEET, none)).toBe(false);
  });

  test("some selected -> indeterminate", () => {
    const some = new Set<string>(["blog", "docs"]);
    expect(isAllSelected(FLEET, some)).toBe(false);
    expect(isIndeterminate(FLEET, some)).toBe(true);
  });

  test("all selected -> all, not indeterminate", () => {
    const all = selectAll(FLEET);
    expect(isAllSelected(FLEET, all)).toBe(true);
    expect(isIndeterminate(FLEET, all)).toBe(false);
  });

  test("empty universe is never all-selected", () => {
    expect(isAllSelected([], new Set())).toBe(false);
    expect(isIndeterminate([], new Set())).toBe(false);
  });
});

describe("pruneSelection", () => {
  test("drops sites that disappeared from the fleet", () => {
    const selection = new Set<string>(["blog", "shop", "gone"]);
    const nextFleet = ["blog", "docs"];
    expect([...pruneSelection(nextFleet, selection)]).toEqual(["blog"]);
  });
});

describe("orderedSelection", () => {
  test("returns selected sites in the fleet's display order", () => {
    const selection = new Set<string>(["news", "blog"]);
    expect(orderedSelection(FLEET, selection)).toEqual(["blog", "news"]);
  });
});
