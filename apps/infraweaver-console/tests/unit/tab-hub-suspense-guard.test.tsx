import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, act } from "@testing-library/react";
import { TabHub, type HubTab } from "@/components/layout/tab-hub";

/**
 * Regression guard for the blank-nav bug class (fixed on /wordpress 2026-07-19,
 * flagged latent on /workloads). Every hub page (`/workloads`, `/config`,
 * `/identity`, …) is a `"use client"` page that mounts `TabHub`, which reads
 * `useSearchParams()`. When a hub page is statically prerendered and that read is
 * NOT inside a `<Suspense>` boundary, Next trips `missing-suspense-with-csr-bailout`
 * and the route blanks on soft-nav. The fix moved the read into `TabHubInner` and
 * wrapped it in Suspense inside `TabHub`, so the safety holds by construction for
 * every hub — no per-page `force-dynamic` needed.
 *
 * These tests prove: (1) TabHub renders its own Suspense boundary (a suspending
 * `useSearchParams()` falls into the fallback instead of throwing), and (2) the
 * functional behaviour — default tab + `?tab=` deep-link selection — is intact.
 */

// jest hoists this mock; only `mock`-prefixed outer refs may be used inside it.
const mockNav = {
  pending: false,
  params: new URLSearchParams(),
  suspender: Promise.resolve() as Promise<unknown>,
  resolve: () => {},
  /** Arm a fresh unresolved suspender so the next `useSearchParams()` throws it. */
  arm(this: typeof mockNav) {
    this.pending = true;
    this.suspender = new Promise((res) => {
      this.resolve = () => {
        this.pending = false;
        res(undefined);
      };
    });
  },
};

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => {
    if (mockNav.pending) throw mockNav.suspender;
    return mockNav.params;
  },
}));

const tabs: HubTab[] = [
  { value: "first", label: "First", Component: () => <div>FIRST VIEW</div> },
  { value: "second", label: "Second", Component: () => <div>SECOND VIEW</div> },
];

beforeEach(() => {
  mockNav.pending = false;
  mockNav.params = new URLSearchParams();
});

describe("TabHub functional behaviour", () => {
  test("renders the default (first) tab when there is no ?tab", () => {
    render(<TabHub basePath="/workloads" tabs={tabs} />);
    expect(screen.getByText("FIRST VIEW")).toBeInTheDocument();
    expect(screen.queryByText("SECOND VIEW")).not.toBeInTheDocument();
  });

  test("honours a deep-linked ?tab=second", () => {
    mockNav.params = new URLSearchParams("tab=second");
    render(<TabHub basePath="/workloads" tabs={tabs} />);
    expect(screen.getByText("SECOND VIEW")).toBeInTheDocument();
  });

  test("falls back to the first tab for an unknown ?tab value", () => {
    mockNav.params = new URLSearchParams("tab=does-not-exist");
    render(<TabHub basePath="/workloads" tabs={tabs} />);
    expect(screen.getByText("FIRST VIEW")).toBeInTheDocument();
  });
});

describe("TabHub is prerender-safe by construction (self-wrapped Suspense)", () => {
  test("a suspending useSearchParams falls into the fallback default tab, then resolves to ?tab", async () => {
    mockNav.arm();
    mockNav.params = new URLSearchParams("tab=second");

    // No external <Suspense> here on purpose: if TabHub didn't wrap its own read,
    // this render would THROW ("a component suspended … no Suspense boundary").
    render(<TabHub basePath="/workloads" tabs={tabs} />);

    // While params are pending, the fallback shows the default (first) tab.
    expect(screen.getByText("FIRST VIEW")).toBeInTheDocument();
    expect(screen.queryByText("SECOND VIEW")).not.toBeInTheDocument();

    // Resolve params → inner takes over and honours ?tab=second.
    await act(async () => {
      mockNav.resolve();
    });
    expect(await screen.findByText("SECOND VIEW")).toBeInTheDocument();
  });
});

describe("TabHub source keeps the read behind a boundary (lint)", () => {
  const src = readFileSync(
    join(__dirname, "../../src/components/layout/tab-hub.tsx"),
    "utf8",
  );

  test("imports Suspense and wraps the inner hub in it", () => {
    expect(src).toMatch(/import\s+\{[^}]*\bSuspense\b[^}]*\}\s+from\s+"react"/);
    expect(src).toMatch(/<Suspense[\s\S]*?<TabHubInner/);
  });

  test("the exported TabHub itself does not read useSearchParams (only the inner does)", () => {
    // The read must live in the Suspense child, never in the boundary owner.
    const exportedBody = src.slice(src.indexOf("export function TabHub"));
    expect(exportedBody).not.toMatch(/useSearchParams\s*\(/);
  });
});
