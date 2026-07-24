import {
  completedCount,
  initLedger,
  markDone,
  markRunning,
  runItems,
  summarize,
  type ItemOutcome,
} from "@/addons/wordpress-manager/lib/manage/run-ledger";

describe("ledger transitions", () => {
  test("initLedger starts every id pending, order preserved", () => {
    const ledger = initLedger(["x", "y"]);
    expect(ledger).toEqual([
      { id: "x", status: "pending" },
      { id: "y", status: "pending" },
    ]);
  });

  test("markRunning / markDone update one id immutably", () => {
    const a = initLedger(["x", "y"]);
    const b = markRunning(a, "x");
    expect(a[0].status).toBe("pending"); // original untouched
    expect(b[0].status).toBe("running");
    const c = markDone(b, "x", { ok: true, message: "done" });
    expect(c[0]).toEqual({ id: "x", status: "ok", message: "done" });
    const d = markDone(c, "y", { ok: false, message: "boom" });
    expect(d[1]).toEqual({ id: "y", status: "error", message: "boom" });
  });

  test("summarize + completedCount roll a ledger up", () => {
    const ledger = [
      { id: "x", status: "ok" as const },
      { id: "y", status: "error" as const },
      { id: "z", status: "running" as const },
    ];
    expect(summarize(ledger)).toEqual({ total: 3, ok: 1, failed: 1, done: false });
    expect(completedCount(ledger)).toBe(2);
  });
});

describe("runItems", () => {
  test("runs every id, records outcomes, and reports live via onUpdate", async () => {
    const outcomes: Record<string, ItemOutcome> = {
      a: { ok: true, message: "ok-a" },
      b: { ok: false, message: "fail-b" },
      c: { ok: true },
    };
    const updates: number[] = [];
    const final = await runItems(
      ["a", "b", "c"],
      async (id) => outcomes[id],
      (ledger) => updates.push(completedCount(ledger)),
      2,
    );
    expect(summarize(final)).toEqual({ total: 3, ok: 2, failed: 1, done: true });
    expect(final.find((r) => r.id === "b")).toEqual({ id: "b", status: "error", message: "fail-b" });
    // onUpdate fired at least once per transition, ending at all-complete.
    expect(updates[updates.length - 1]).toBe(3);
    expect(updates.length).toBeGreaterThan(1);
  });

  test("a thrown worker error is caught and recorded as a failure", async () => {
    const final = await runItems(
      ["a"],
      async () => {
        throw new Error("kaboom");
      },
      () => undefined,
      1,
    );
    expect(final[0]).toEqual({ id: "a", status: "error", message: "kaboom" });
  });
});
