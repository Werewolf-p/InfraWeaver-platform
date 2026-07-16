import { createAuditStore } from "@/lib/audit/store";
import { AuditConflictError, type AuditSink, type AuditSnapshot } from "@/lib/audit/sink";
import type { AuditAppendInput } from "@/lib/audit/types";

function makeInput(overrides: Partial<AuditAppendInput> = {}): AuditAppendInput {
  return {
    timestamp: new Date("2026-07-16T00:00:00.000Z").toISOString(),
    action: "rbac:assign",
    category: "rbac",
    severity: "notice",
    user: "tester@example.com",
    result: "success",
    resource: "role/admin",
    target: "role/admin",
    detail: "assigned admin",
    ...overrides,
  };
}

/** In-memory sink mirroring the ConfigMap compare-and-swap contract. */
function makeMemorySink(initial: string[] = []) {
  let lines = [...initial];
  let version = 0;
  const sink: AuditSink = {
    async read(): Promise<AuditSnapshot> {
      return { lines: [...lines], version: String(version) };
    },
    async write(next: string[], v?: string): Promise<void> {
      if (v !== undefined && v !== String(version)) throw new AuditConflictError();
      lines = [...next];
      version += 1;
    },
  };
  return { sink, getLines: () => lines };
}

describe("audit store hash chain", () => {
  it("assigns a monotonic seq and links prevHash to the previous hash", async () => {
    // Arrange
    const { sink } = makeMemorySink();
    const store = createAuditStore(sink);

    // Act
    const first = await store.appendAudit(makeInput({ detail: "one" }));
    const second = await store.appendAudit(makeInput({ detail: "two" }));

    // Assert
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.prevHash).toBeUndefined();
    expect(second.prevHash).toBe(first.hash);
    expect(second.hash).toBeDefined();
    expect(second.hash).not.toBe(first.hash);
  });

  it("verifyChain passes for an untouched chain", async () => {
    // Arrange
    const { sink } = makeMemorySink();
    const store = createAuditStore(sink);
    await store.appendAudit(makeInput({ detail: "a" }));
    await store.appendAudit(makeInput({ detail: "b" }));
    await store.appendAudit(makeInput({ detail: "c" }));

    // Act
    const result = await store.verifyChain();

    // Assert
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(3);
  });

  it("verifyChain detects a mutated line", async () => {
    // Arrange
    const { sink, getLines } = makeMemorySink();
    const store = createAuditStore(sink);
    await store.appendAudit(makeInput({ detail: "a" }));
    await store.appendAudit(makeInput({ detail: "b" }));
    await store.appendAudit(makeInput({ detail: "c" }));

    // Tamper with the second record's detail WITHOUT recomputing its hash.
    const lines = getLines();
    const tampered = JSON.parse(lines[1]);
    tampered.detail = "MUTATED";
    lines[1] = JSON.stringify(tampered);

    // Act
    const result = await store.verifyChain();

    // Assert
    expect(result.ok).toBe(false);
    expect(result.brokenSeq).toBe(2);
  });
});

describe("audit store ring buffer", () => {
  it("trims the oldest entries once the count cap is exceeded", async () => {
    // Arrange
    const { sink } = makeMemorySink();
    const store = createAuditStore(sink, { maxEntries: 3 });

    // Act
    for (let i = 1; i <= 6; i += 1) {
      await store.appendAudit(makeInput({ detail: `entry-${i}` }));
    }
    const page = await store.queryAudit({ limit: 100 });

    // Assert — only the newest 3 survive, newest-first.
    expect(page.entries).toHaveLength(3);
    expect(page.entries.map((entry) => entry.detail)).toEqual(["entry-6", "entry-5", "entry-4"]);
  });

  it("trims oldest entries under a byte cap", async () => {
    // Arrange — a tiny byte cap forces aggressive trimming.
    const { sink } = makeMemorySink();
    const store = createAuditStore(sink, { maxEntries: 1000, maxBytes: 400 });

    // Act
    for (let i = 0; i < 20; i += 1) {
      await store.appendAudit(makeInput({ detail: `padding-detail-number-${i}` }));
    }
    const page = await store.queryAudit({ limit: 1000 });

    // Assert — retained set is far smaller than the 20 appended.
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.entries.length).toBeLessThan(20);
  });
});

describe("audit store serialization", () => {
  it("does not lose entries when appends are fired concurrently", async () => {
    // Arrange
    const { sink } = makeMemorySink();
    const store = createAuditStore(sink);

    // Act — fire 25 appends without awaiting between them.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.appendAudit(makeInput({ detail: `concurrent-${i}` }))),
    );
    const page = await store.queryAudit({ limit: 1000 });

    // Assert — all landed with a contiguous 1..25 seq range.
    expect(page.total).toBe(25);
    const seqs = page.entries.map((entry) => entry.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("retries and still lands the entry after a stale-version conflict", async () => {
    // Arrange — a sink that rejects the first write with a conflict.
    const { sink } = makeMemorySink();
    let writes = 0;
    const flaky: AuditSink = {
      read: sink.read,
      async write(next, version) {
        writes += 1;
        if (writes === 1) throw new AuditConflictError();
        return sink.write(next, version);
      },
    };
    const store = createAuditStore(flaky);

    // Act
    const record = await store.appendAudit(makeInput({ detail: "survives-conflict" }));
    const page = await store.queryAudit({ limit: 10 });

    // Assert
    expect(record.seq).toBe(1);
    expect(page.total).toBe(1);
    expect(writes).toBeGreaterThanOrEqual(2);
  });
});

describe("audit store query filters", () => {
  it("filters by severity and paginates newest-first with a cursor", async () => {
    // Arrange
    const { sink } = makeMemorySink();
    const store = createAuditStore(sink);
    await store.appendAudit(makeInput({ severity: "info", detail: "i1" }));
    await store.appendAudit(makeInput({ severity: "critical", detail: "c1" }));
    await store.appendAudit(makeInput({ severity: "critical", detail: "c2" }));

    // Act
    const page = await store.queryAudit({ severity: "critical", limit: 1 });

    // Assert — newest critical first, cursor points to it for the next page.
    expect(page.total).toBe(2);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].detail).toBe("c2");
    expect(page.nextCursor).toBe(page.entries[0].seq);
  });
});
