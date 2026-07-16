import { describe, expect, it } from "@jest/globals";
import { selectAsyncState } from "@/components/ui/async-boundary-state";

describe("selectAsyncState", () => {
  it("prioritizes error above all", () => {
    expect(selectAsyncState({ isLoading: true, isError: true, isEmpty: true })).toBe("error");
  });
  it("shows loading before empty (first load = skeleton, not empty)", () => {
    expect(selectAsyncState({ isLoading: true, isError: false, isEmpty: true })).toBe("loading");
  });
  it("shows empty when loaded with no data", () => {
    expect(selectAsyncState({ isLoading: false, isError: false, isEmpty: true })).toBe("empty");
  });
  it("shows ready when loaded with data", () => {
    expect(selectAsyncState({ isLoading: false, isError: false, isEmpty: false })).toBe("ready");
  });
  it("treats missing isEmpty as not empty", () => {
    expect(selectAsyncState({ isLoading: false, isError: false })).toBe("ready");
  });
});
