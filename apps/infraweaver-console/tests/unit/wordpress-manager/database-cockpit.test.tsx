import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// framer-motion ships ESM ts-jest does not transform — swap it for plain DOM
// elements (same shim the other manage-panel tests use). Forwards real DOM/ARIA
// props so ConfirmDialog keeps role="dialog"; AnimatedNumber's animate() fires
// onUpdate once so the final value renders.
jest.mock("framer-motion", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- factory cannot reference the out-of-scope React import
  const ReactLib = require("react");
  const FRAMER_PROPS = new Set([
    "initial",
    "animate",
    "exit",
    "transition",
    "variants",
    "whileHover",
    "whileTap",
    "whileInView",
    "layout",
    "layoutId",
  ]);
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => ReactLib.createElement(ReactLib.Fragment, null, children),
    motion: new Proxy(
      {},
      {
        get:
          (_t: unknown, tag: string) =>
          ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => {
            const domProps = Object.fromEntries(Object.entries(props).filter(([k]) => !FRAMER_PROPS.has(k)));
            return ReactLib.createElement(tag, domProps, children);
          },
      },
    ),
    useReducedMotion: () => true,
    animate: (_from: number, to: number, opts?: { onUpdate?: (v: number) => void }) => {
      opts?.onUpdate?.(to);
      return { stop: () => {} };
    },
  };
});

const toastSuccess = jest.fn();
const toastError = jest.fn();
jest.mock("@/lib/notify", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}));

// Controllable react-query: useQuery serves per-key state from `queries`.
const invalidateQueries = jest.fn().mockResolvedValue(undefined);
const refetch = jest.fn().mockResolvedValue({});
let queries: Record<string, { data?: unknown; isPending?: boolean; error?: unknown }> = {};
jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
  useQuery: ({ queryKey }: { queryKey: [string, string] }) => {
    const entry = queries[queryKey[0]] ?? {};
    return { data: entry.data, isPending: entry.isPending ?? false, isFetching: false, error: entry.error ?? null, refetch };
  },
}));

// Controllable entitlements — TierGate + cockpit both read this one hook.
let entHas = (_flag: string) => true;
jest.mock("@/addons/wordpress-manager/lib/manage/use-site-entitlements", () => ({
  siteEntitlementsKey: (site: string) => ["wordpress-iwsl-link", site],
  useSiteEntitlements: () => ({
    tier: "pro",
    flags: {},
    switches: {},
    connectorActive: true,
    identitySuspended: false,
    loading: false,
    error: null,
    has: (flag: string) => entHas(flag),
    isSwitchedOff: () => false,
  }),
}));

import { DatabaseCockpit } from "@/addons/wordpress-manager/components/manage/database/database-cockpit";
import type { DbAnalyzeResponse } from "@/addons/wordpress-manager/lib/manage/database";

const SITE = "demo";

const BASE_PROBE = {
  totalMb: 100,
  tables: [{ name: "wp_options", sizeMb: 60 }],
  autoloadKb: 1200,
  autoloadCount: 320,
  transients: 12,
  revisions: 45,
};

const ANALYZE: DbAnalyzeResponse = {
  locked: false,
  gate: { unlocked: true },
  caps: { max_rows: 1000, categories: ["post_revisions", "expired_transients", "optimize_tables"] },
  totals: { db_mb: 100, overhead_mb: 38 },
  tables: [{ name: "wp_options", size_mb: 60, overhead_mb: 5 }],
  autoload: { count: 320, kb: 1200, top: [{ name: "cron", kb: 150 }] },
  schema_available: true,
  categories: [
    { id: "post_revisions", label: "Post revisions", count: 500 },
    { id: "expired_transients", label: "Expired transients", count: 0 },
    { id: "optimize_tables", label: "Optimize tables", count: 0 },
  ],
  schedule: { unlocked: true, enabled: false, frequency: "daily", categories: [], next_run: null, last_run: null },
  history: [],
};

let fetchMock: jest.Mock;

/** A fetch mock that branches the db.cleanup response on the wire `dry_run` flag. */
function installFetch(): void {
  fetchMock = jest.fn(async (_url: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as { verb: string; params: { dry_run?: boolean } }) : { verb: "", params: {} };
    if (body.verb === "cleanup") {
      const dryRun = body.params.dry_run;
      const cleaners =
        dryRun === false
          ? [{ id: "post_revisions", label: "Post revisions", deleted: 500 }]
          : [{ id: "post_revisions", label: "Post revisions", count: 500 }];
      return { ok: true, status: 200, json: async () => ({ ok: true, mode: dryRun === false ? "run" : "preview", cleaners, total: 500, cap: 1000 }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

/** Parsed bodies of every db.cleanup POST, in order. */
function cleanupBodies(): { params: { dry_run?: boolean; categories?: string[] } }[] {
  return fetchMock.mock.calls
    .map((c) => (c[1]?.body ? JSON.parse(c[1].body as string) : null))
    .filter((b): b is { verb: string; params: { dry_run?: boolean } } => !!b && b.verb === "cleanup");
}

beforeEach(() => {
  queries = {};
  entHas = () => true;
  invalidateQueries.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  installFetch();
});

describe("DatabaseCockpit — preview-before-delete", () => {
  beforeEach(() => {
    queries["wordpress-manage-panel"] = { data: BASE_PROBE };
    queries["wordpress-db-analyze"] = { data: ANALYZE };
  });

  test("Delete is disabled until the current selection is previewed, then labelled with the total", async () => {
    render(<DatabaseCockpit site={SITE} />);

    // Before any preview: Delete reads 0 rows and is disabled.
    const deleteBefore = screen.getByRole("button", { name: /delete 0 rows/i });
    expect(deleteBefore).toBeDisabled();

    // Tick a category and preview — the wire call is an EXPLICIT dry_run: true.
    // "Post revisions" appears in both the cleanup grid (first) and the automation
    // subset; the cleanup grid renders first in DOM order.
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Post revisions" })[0]);
    fireEvent.click(screen.getByRole("button", { name: /preview cleanup/i }));

    await waitFor(() => expect(screen.getByText(/would remove 500/i)).toBeInTheDocument());
    const previewCall = cleanupBodies()[0];
    expect(previewCall.params.dry_run).toBe(true);

    // Delete now enabled + labelled with the previewed total.
    const deleteAfter = await screen.findByRole("button", { name: "Delete 500 rows" });
    expect(deleteAfter).toBeEnabled();
  });

  test("Delete requires a confirm dialog and then POSTs an explicit dry_run: false", async () => {
    render(<DatabaseCockpit site={SITE} />);
    // "Post revisions" appears in both the cleanup grid (first) and the automation
    // subset; the cleanup grid renders first in DOM order.
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Post revisions" })[0]);
    fireEvent.click(screen.getByRole("button", { name: /preview cleanup/i }));
    const deleteBtn = await screen.findByRole("button", { name: "Delete 500 rows" });

    // Opening the confirm dialog does NOT delete yet.
    fireEvent.click(deleteBtn);
    const dialog = await screen.findByRole("dialog");
    expect(cleanupBodies().some((b) => b.params.dry_run === false)).toBe(false);

    // Confirm — now the destructive run fires with a literal false.
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete 500 rows" }));
    await waitFor(() => expect(cleanupBodies().some((b) => b.params.dry_run === false)).toBe(true));
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalled());
  });

  test("shows the reclaimable-overhead estimate on Safe optimize and renders overhead in the table", () => {
    render(<DatabaseCockpit site={SITE} />);
    expect(screen.getByRole("button", { name: /safe optimize \(~38 MB reclaimable\)/i })).toBeInTheDocument();
    // DataTable renders desktop + mobile-card headers, so the column appears twice.
    expect(screen.getAllByText("Overhead (MB)").length).toBeGreaterThan(0);
  });
});

describe("DatabaseCockpit — gating + degradation", () => {
  test("tier-locked site shows the upsell, keeps the base sizes, and offers no mutation buttons", () => {
    entHas = () => false; // not entitled → analyze is not fetched
    queries["wordpress-manage-panel"] = { data: BASE_PROBE };

    render(<DatabaseCockpit site={SITE} />);

    // The upsell (TierGate LockedCard) is shown, never fake data or dead buttons.
    expect(screen.getAllByText(/Database cleanup & optimization/i).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /manage plan/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /preview cleanup/i })).toBeNull();

    // Base sizes still render (the always-available probe layer).
    expect(screen.getByText("Total size")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("connector too old degrades to the base read-out with an update hint, no cleanup zone", () => {
    queries["wordpress-manage-panel"] = { data: BASE_PROBE };
    queries["wordpress-db-analyze"] = { error: Object.assign(new Error("too old"), { status: 501 }) };

    render(<DatabaseCockpit site={SITE} />);

    expect(screen.getByText(/too old for the fused Database tools/i)).toBeInTheDocument();
    expect(screen.getByText("Total size")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /preview cleanup/i })).toBeNull();
  });
});
