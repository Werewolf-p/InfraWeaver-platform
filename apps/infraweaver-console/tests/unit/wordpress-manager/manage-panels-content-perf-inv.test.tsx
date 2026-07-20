import React from "react";
import { render, screen, within } from "@testing-library/react";

// framer-motion ships ESM that ts-jest does not transform — swap it for plain DOM
// (StatTile's AnimatedNumber uses animate(); manage-ui's Modal uses motion/AnimatePresence).
jest.mock("framer-motion", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factory cannot reference the out-of-scope React import
  const ReactLib = require("react");
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) =>
      ReactLib.createElement(ReactLib.Fragment, null, children),
    motion: new Proxy(
      {},
      {
        get:
          (_t: unknown, tag: string) =>
          ({ children, className }: { children?: React.ReactNode; className?: string }) =>
            ReactLib.createElement(tag, { className }, children),
      },
    ),
    useReducedMotion: () => true,
    useInView: () => true,
    // Snap straight to the final value so the rendered number is deterministic.
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

// Controllable Manage data layer. `mockState` feeds every useManagePanel read;
// tests set `mockState.data` before rendering. useManageAction is a no-op stub
// (useActionRunner in manage-ui composes over it).
const mockState: { data: unknown; loading: boolean; error: string | null; reload: jest.Mock } = {
  data: null,
  loading: false,
  error: null,
  reload: jest.fn(),
};
jest.mock("@/addons/wordpress-manager/components/demo/manage/use-manage", () => ({
  useManagePanel: () => mockState,
  useManageAction: () => ({ run: jest.fn().mockResolvedValue({ ok: true, message: "Done." }), pending: false }),
}));

import { ContentPanel } from "@/addons/wordpress-manager/components/demo/manage/panels-content";
import { PerformancePanel } from "@/addons/wordpress-manager/components/demo/manage/panels-performance";
import { InventoryPanel } from "@/addons/wordpress-manager/components/demo/manage/panels-inventory";
import type { ContentData } from "@/addons/wordpress-manager/lib/manage/probes/content";
import type { PerformanceData } from "@/addons/wordpress-manager/lib/manage/probes/performance";
import type { InventoryData } from "@/addons/wordpress-manager/lib/manage/probes/inventory";

const SITE = "demo";

function setData(data: unknown): void {
  mockState.data = data;
}

beforeEach(() => {
  mockState.data = null;
  mockState.reload.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
});

// ── Content ───────────────────────────────────────────────────────────────────

const CONTENT_WITH_QUEUE: ContentData = {
  posts: 12,
  pages: 4,
  drafts: 3,
  comments: 20,
  pendingComments: 5,
  spamComments: 2,
  revisions: 7,
  recent: [
    { title: "Hello World", date: "2026-07-01 10:00:00", status: "publish" },
    { title: "Draft idea", date: "2026-07-02 09:00:00", status: "draft" },
  ],
};

describe("ContentPanel", () => {
  test("renders the four stat tiles and recent posts in a table with status pills", () => {
    setData(CONTENT_WITH_QUEUE);
    render(<ContentPanel site={SITE} />);

    expect(screen.getByText("Posts")).toBeInTheDocument();
    expect(screen.getByText("Pages")).toBeInTheDocument();
    // A real semantic table with an sr-only caption for the recent posts.
    // DataTable renders a phone card stack too — scope row assertions to the table.
    const posts = within(screen.getByRole("table", { name: /recent posts on this site/i }));
    expect(posts.getByText("Hello World")).toBeInTheDocument();
    expect(posts.getByText("Published")).toBeInTheDocument();
    expect(posts.getByText("Draft")).toBeInTheDocument();
  });

  test("shows the moderation queue with actions when comments are pending", () => {
    setData(CONTENT_WITH_QUEUE);
    render(<ContentPanel site={SITE} />);

    expect(screen.getByRole("button", { name: /approve pending/i })).toBeInTheDocument();
    // The pending count is emphasised in the queue card.
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  test("collapses the queue to a single line and empties recent posts when there is nothing to do", () => {
    setData({ ...CONTENT_WITH_QUEUE, pendingComments: 0, recent: [] });
    render(<ContentPanel site={SITE} />);

    expect(screen.getByText("No comments awaiting moderation.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve pending/i })).not.toBeInTheDocument();
    // Empty recent posts → EmptyState, not a lonely table.
    expect(screen.getByText("No posts yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

// ── Performance ─────────────────────────────────────────────────────────────────

const PERF_GOOD: PerformanceData = {
  objectCacheDropin: true,
  cacheType: "Redis",
  persistentObjectCache: true,
  pageCachePlugin: "wp-rocket",
  autoloadKb: 120,
  php: "8.2.0",
  memoryLimit: "256M",
  transients: 10,
  recommendations: [],
};

const PERF_BAD: PerformanceData = {
  objectCacheDropin: false,
  cacheType: "Default",
  persistentObjectCache: false,
  pageCachePlugin: null,
  autoloadKb: 1200,
  php: "8.0.0",
  memoryLimit: "128M",
  transients: 800,
  recommendations: [
    "No persistent object cache detected — add Redis or Memcached to cut repeat database queries.",
    "800 transients are stored — purge them to slim the options table.",
  ],
};

describe("PerformancePanel", () => {
  test("leads with a Good verdict and On cache pills when there are no issues", () => {
    setData(PERF_GOOD);
    render(<PerformancePanel site={SITE} />);

    expect(screen.getByText("Speed: Good")).toBeInTheDocument();
    // Both cache posture rows read On.
    expect(screen.getAllByText("On").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("No speed issues detected.")).toBeInTheDocument();
  });

  test("relabels the tuning buttons in plain language and keeps the tech term as a tooltip", () => {
    setData(PERF_GOOD);
    render(<PerformancePanel site={SITE} />);

    const flush = screen.getByRole("button", { name: /clear cached pages/i });
    expect(flush).toHaveAttribute("title", "Flush cache");
    expect(screen.getByRole("button", { name: /fix broken links/i })).toHaveAttribute("title", "Flush rewrites");
  });

  test("leads with a Needs work verdict and offers a Purge action on the transient recommendation", () => {
    setData(PERF_BAD);
    render(<PerformancePanel site={SITE} />);

    expect(screen.getByText("Speed: Needs work")).toBeInTheDocument();
    expect(screen.getByText(/800 transients are stored/i)).toBeInTheDocument();
    // The transient recommendation carries a matching Purge action button.
    expect(screen.getByRole("button", { name: /purge/i })).toBeInTheDocument();
    // Cache posture is Off.
    expect(screen.getAllByText("Off").length).toBeGreaterThanOrEqual(2);
  });
});

// ── Inventory ───────────────────────────────────────────────────────────────────

const INVENTORY: InventoryData = {
  plugins: [
    {
      slug: "akismet",
      name: "Akismet",
      status: "active",
      active: true,
      version: "5.3",
      updateAvailable: false,
      updateVersion: null,
      autoUpdate: true,
      canAct: true,
    },
    {
      slug: "jetpack",
      name: "Jetpack",
      status: "inactive",
      active: false,
      version: "12.0",
      updateAvailable: true,
      updateVersion: "12.1",
      autoUpdate: false,
      canAct: true,
    },
  ],
  themes: [
    {
      slug: "twentytwentyfour",
      name: "Twenty Twenty-Four",
      status: "active",
      active: true,
      version: "1.0",
      updateAvailable: false,
      canAct: true,
    },
  ],
  activePlugins: 1,
  pluginUpdates: 1,
  themeUpdates: 0,
};

describe("InventoryPanel", () => {
  test("renders plugins and themes in tables with a status filter rail", () => {
    setData(INVENTORY);
    render(<InventoryPanel site={SITE} />);

    expect(screen.getByRole("group", { name: /filter plugins by status/i })).toBeInTheDocument();
    const plugins = within(screen.getByRole("table", { name: /installed plugins/i }));
    const themes = within(screen.getByRole("table", { name: /installed themes/i }));
    expect(plugins.getByText("Akismet")).toBeInTheDocument();
    expect(plugins.getByText("Jetpack")).toBeInTheDocument();
    expect(themes.getByText("Twenty Twenty-Four")).toBeInTheDocument();
  });

  test("surfaces update state as a pill and preserves the per-row actions", () => {
    setData(INVENTORY);
    render(<InventoryPanel site={SITE} />);

    // Jetpack (inactive, canAct, has update) surfaces the pending version and keeps
    // its Update / Activate / Delete actions. Scope to the plugins table (DataTable
    // also renders a phone card copy of every row + its actions).
    const plugins = within(screen.getByRole("table", { name: /installed plugins/i }));
    expect(plugins.getByText(/→\s*12\.1/)).toBeInTheDocument();
    expect(plugins.getByRole("button", { name: /^update$/i })).toBeInTheDocument();
    // Anchored so /activate/ does not also match Akismet's "Deactivate".
    expect(plugins.getByRole("button", { name: /^activate$/i })).toBeInTheDocument();
    expect(plugins.getByRole("button", { name: /^delete$/i })).toBeInTheDocument();
    // Bulk "Update all" is offered because updates are pending.
    expect(screen.getByRole("button", { name: /update all/i })).toBeInTheDocument();
  });
});
