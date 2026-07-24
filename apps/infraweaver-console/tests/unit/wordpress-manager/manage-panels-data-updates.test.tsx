import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// framer-motion ships ESM that ts-jest does not transform — swap it for plain DOM
// elements. AnimatedNumber/ProgressRing/Modal all draw from it, so the shim also
// exports `animate` (fires onUpdate once → the final value renders) and
// `useReducedMotion`.
jest.mock("framer-motion", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factory cannot reference the out-of-scope React import
  const ReactLib = require("react");
  // Framer-only props that must NOT leak onto real DOM elements.
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
    AnimatePresence: ({ children }: { children: React.ReactNode }) =>
      ReactLib.createElement(ReactLib.Fragment, null, children),
    motion: new Proxy(
      {},
      {
        // Forward real DOM/ARIA props (role, aria-*, tabIndex, onMouseDown, className,
        // svg geometry…) so the dialog keeps role="dialog"; strip framer-only
        // animation props that would be invalid DOM attributes.
        get:
          (_target: unknown, tag: string) =>
          ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => {
            const domProps = Object.fromEntries(
              Object.entries(props).filter(([key]) => !FRAMER_PROPS.has(key)),
            );
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
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

// --- Controllable react-query mock (matches use-manage.ts) ----------------------
// useQuery serves panel data keyed by queryKey[0]; useMutation runs the real
// mutationFn (against the mocked fetch) via mutateAsync and calls onSuccess.
let panelData: Record<string, unknown> = {};
const invalidateQueries = jest.fn().mockResolvedValue(undefined);
const refetch = jest.fn().mockResolvedValue({});

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
  useQuery: ({ queryKey }: { queryKey: [string, string, string] }) => ({
    data: panelData[queryKey[0]],
    isPending: false,
    isFetching: false,
    error: null,
    refetch,
  }),
  useMutation: (opts: {
    mutationFn: (arg?: unknown) => Promise<unknown>;
    onSuccess?: (data: unknown, arg?: unknown) => void;
  }) => ({
    isPending: false,
    mutateAsync: async (arg?: unknown) => {
      const data = await opts.mutationFn(arg);
      opts.onSuccess?.(data, arg);
      return data;
    },
  }),
}));

import { DataPanel } from "@/addons/wordpress-manager/components/demo/manage/panels-data";
import { UpdatesPanel } from "@/addons/wordpress-manager/components/demo/manage/panels-updates";

const SITE = "demo";
const MANAGE_KEY = "wordpress-manage-panel";

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

let fetchMock: jest.Mock;

beforeEach(() => {
  panelData = {};
  invalidateQueries.mockClear();
  refetch.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  fetchMock = jest.fn().mockResolvedValue(okResponse({ ok: true, message: "Done." }));
  global.fetch = fetchMock as unknown as typeof fetch;
});

// --- Database panel -------------------------------------------------------------

const DATA = {
  totalMb: 100,
  tables: [
    { name: "wp_options", sizeMb: 60 },
    { name: "wp_posts", sizeMb: 10 },
  ],
  autoloadKb: 1200,
  autoloadCount: 320,
  transients: 12,
  revisions: 45,
};

describe("DataPanel", () => {
  test("renders plain-language tile labels for the owner", () => {
    panelData[MANAGE_KEY] = DATA;
    render(<DataPanel site={SITE} />);

    expect(screen.getByText("Total size")).toBeInTheDocument();
    expect(screen.getByText("Slow-load weight")).toBeInTheDocument();
    expect(screen.getByText("Temporary data")).toBeInTheDocument();
    expect(screen.getByText("Old drafts")).toBeInTheDocument();
  });

  test("flags a dominant table as Large and totals the size in the footer", () => {
    panelData[MANAGE_KEY] = DATA;
    render(<DataPanel site={SITE} />);

    // DataTable renders a phone card stack AND the desktop table; scope to the table.
    const table = within(screen.getByRole("table"));
    // wp_options is 60% of the 100 MB total → Large.
    const optionsRow = table.getByText("wp_options").closest("tr") as HTMLElement;
    expect(within(optionsRow).getByText("Large")).toBeInTheDocument();
    // wp_posts is only 10% → not flagged.
    const postsRow = table.getByText("wp_posts").closest("tr") as HTMLElement;
    expect(within(postsRow).queryByText("Large")).toBeNull();

    expect(table.getByText("Total")).toBeInTheDocument();
    expect(table.getByText("100 MB")).toBeInTheDocument();
  });

  test("surfaces a warn pill when autoload weight is high", () => {
    panelData[MANAGE_KEY] = DATA; // 1200 KB > 800 KB
    render(<DataPanel site={SITE} />);
    expect(screen.getByText("Slow-load weight is high")).toBeInTheDocument();
  });

  test("hides the autoload warning when weight is healthy", () => {
    panelData[MANAGE_KEY] = { ...DATA, autoloadKb: 200 };
    render(<DataPanel site={SITE} />);
    expect(screen.queryByText("Slow-load weight is high")).toBeNull();
  });

  // Mutations retired from the read-only base panel: the raw `optimize-db` (whole-DB
  // `wp db optimize`) and purge-ALL-transients buttons that bypassed the connector's
  // capped, gated, preview-first engine are gone. The read-only base panel now POSTs
  // nothing — all database mutation lives in the fused Database cockpit's signed
  // db.cleanup path (covered by database-cockpit.test.tsx).
  test("read-only base panel exposes no raw mutation buttons and POSTs nothing", () => {
    panelData[MANAGE_KEY] = DATA;
    render(<DataPanel site={SITE} />);

    expect(screen.queryByRole("button", { name: /optimize tables/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /purge temporary data/i })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("empty tables render an EmptyState", () => {
    panelData[MANAGE_KEY] = { ...DATA, tables: [] };
    render(<DataPanel site={SITE} />);
    expect(screen.getByText("No tables to show")).toBeInTheDocument();
  });
});

// --- Updates panel --------------------------------------------------------------

const UPDATES = {
  core: { current: "6.4", latest: "6.5", upToDate: false, php: "8.2" },
  components: [
    { kind: "plugin", slug: "akismet", name: "Akismet", from: "5.0", to: "5.3" },
    { kind: "theme", slug: "twentytwenty", name: "Twenty Twenty", from: "1.0", to: "2.0" },
  ],
  autoUpdatePlugins: 2,
  totalPlugins: 8,
};

describe("UpdatesPanel", () => {
  test("shows the primary Update all CTA with the real pending count", () => {
    panelData[MANAGE_KEY] = UPDATES;
    render(<UpdatesPanel site={SITE} />);
    // 2 bulk-updatable components (plugin + theme).
    expect(screen.getByRole("button", { name: /update all \(2\)/i })).toBeInTheDocument();
  });

  test("offers an Update core button when core is behind", () => {
    panelData[MANAGE_KEY] = UPDATES;
    render(<UpdatesPanel site={SITE} />);
    expect(screen.getByRole("button", { name: /update core/i })).toBeInTheDocument();
  });

  test("per-row Update posts the slug and shows an optimistic Updating state, then completes", async () => {
    panelData[MANAGE_KEY] = UPDATES;
    let resolveFetch: () => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFetch = () => res(okResponse({ ok: true, message: "Plugin updated." }));
        }),
    );
    render(<UpdatesPanel site={SITE} />);

    // Scope to the desktop table (DataTable also renders a phone card copy).
    const row = (): HTMLElement =>
      within(screen.getByRole("table")).getByText("Akismet").closest("tr") as HTMLElement;
    fireEvent.click(within(row()).getByRole("button", { name: /update/i }));

    // While the request is in flight the row swaps its button for a progress ring.
    await waitFor(() => expect(within(row()).getByText(/updating/i)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/wordpress/sites/${SITE}/manage`,
      expect.objectContaining({ body: JSON.stringify({ type: "update-plugin", slug: "akismet" }) }),
    );

    resolveFetch();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Plugin updated."));
  });

  test("everything up to date renders an EmptyState with no update table", () => {
    panelData[MANAGE_KEY] = {
      ...UPDATES,
      core: { ...UPDATES.core, upToDate: true },
      components: [],
    };
    render(<UpdatesPanel site={SITE} />);

    expect(screen.getByText("Everything is up to date")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /update all/i })).toBeNull();
  });
});
