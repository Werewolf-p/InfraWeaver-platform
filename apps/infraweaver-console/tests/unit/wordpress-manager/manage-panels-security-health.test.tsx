import React from "react";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// HealthPanel is now a live Site Health surface — its write hook uses React Query,
// so it must render inside a QueryClientProvider (the checklist itself is still fed
// canned data via the mocked useManagePanel).
function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

// The panels render the shared HealthGauge, whose framer-motion `useReducedMotion`
// reads `window.matchMedia` — absent in jsdom. Polyfill a no-op before any render.
beforeAll(() => {
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
});

// Both panels pull live data via `useManagePanel`. Mock it so we can drive the
// panel body with canned probe data (no network, no React Query).
const mockUseManagePanel = jest.fn();
jest.mock("@/addons/wordpress-manager/components/demo/manage/use-manage", () => ({
  useManagePanel: (site: string, panel: string) => mockUseManagePanel(site, panel),
}));

import { SecurityPanel } from "@/addons/wordpress-manager/components/demo/manage/panels-security";
import { HealthPanel } from "@/addons/wordpress-manager/components/demo/manage/panels-health";
import type { SecurityData } from "@/addons/wordpress-manager/lib/manage/probes/security";
import type { HealthData } from "@/addons/wordpress-manager/lib/manage/probes/health";

function loaded<T>(data: T) {
  return { data, loading: false, error: null, reload: jest.fn() };
}

/** Read the visible check-title of every posture `<li>` in DOM order. */
function checklistLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("ul li")).map((li) => li.querySelector("p")?.textContent ?? "");
}

/**
 * The verdict `Pill` is the only `<span>` that is BOTH rounded-full AND bordered
 * (the PostureSummary legend dots are rounded-full but borderless and textless), so
 * it is unambiguous even while the summary legend also renders the state words.
 */
function verdictPill(container: HTMLElement): HTMLElement | undefined {
  return Array.from(container.querySelectorAll("span")).find(
    (el) => el.className.includes("rounded-full") && el.className.includes("border") && (el.textContent ?? "").trim() !== "",
  );
}

const SECURITY_DATA: SecurityData = {
  score: 57,
  adminCount: 2,
  counts: { good: 4, recommended: 1, critical: 2 },
  checks: [
    { id: "integrity", label: "Core file integrity", state: "good", detail: "Core files verify." },
    { id: "core-current", label: "Core up to date", state: "critical", detail: "A core update is pending." },
    { id: "admin-count", label: "Administrator accounts", state: "recommended", detail: "Too many admins." },
    { id: "salts", label: "Security keys & salts", state: "good", detail: "Salts are defined." },
    { id: "ssl", label: "TLS / HTTPS", state: "critical", detail: "Site is not HTTPS." },
    { id: "file-editor", label: "File editor disabled", state: "good", detail: "Editor is off." },
    { id: "debug", label: "Debug output", state: "good", detail: "Debug disabled." },
  ],
};

const HEALTH_MIXED: HealthData = {
  wp: "6.5.2",
  php: "8.1.0",
  dbSizeMb: 42,
  counts: { good: 5, recommended: 1, critical: 1 },
  checks: [
    { id: "core", label: "WordPress core", state: "critical", detail: "A core update is available." },
    { id: "integrity", label: "Core file integrity", state: "good", detail: "Core files verify." },
    { id: "plugins", label: "Plugin updates", state: "recommended", detail: "1 plugin update available." },
    { id: "php", label: "PHP version", state: "good", detail: "Running PHP 8.1.0." },
    { id: "https", label: "HTTPS", state: "good", detail: "Served over HTTPS." },
    { id: "debug", label: "Debug mode", state: "good", detail: "Debugging is disabled." },
    { id: "cron", label: "Scheduled tasks", state: "good", detail: "No overdue events." },
  ],
};

const HEALTH_ALL_GOOD: HealthData = {
  wp: "6.5.2",
  php: "8.2.0",
  dbSizeMb: 12,
  counts: { good: 3, recommended: 0, critical: 0 },
  checks: [
    { id: "core", label: "WordPress core", state: "good", detail: "Up to date." },
    { id: "https", label: "HTTPS", state: "good", detail: "Served over HTTPS." },
    { id: "php", label: "PHP version", state: "good", detail: "Running PHP 8.2.0." },
  ],
};

afterEach(() => {
  mockUseManagePanel.mockReset();
});

describe("SecurityPanel", () => {
  test("renders the administrator exposure count", () => {
    mockUseManagePanel.mockReturnValue(loaded(SECURITY_DATA));
    const { container } = render(<SecurityPanel site="demo" />);

    expect(screen.getByText("administrator accounts")).toBeInTheDocument();
    // The headline count is the large tabular figure, not a legend tally.
    expect(container.querySelector(".text-4xl")).toHaveTextContent("2");
  });

  test("orders the checklist scary-first: critical → recommended → good", () => {
    mockUseManagePanel.mockReturnValue(loaded(SECURITY_DATA));
    const { container } = render(<SecurityPanel site="demo" />);

    const labels = checklistLabels(container);
    // Every source check is present.
    expect(labels).toHaveLength(SECURITY_DATA.checks.length);
    // Both criticals lead (stable source order preserved among equals).
    expect(labels.slice(0, 2)).toEqual(["Core up to date", "TLS / HTTPS"]);
    // The single recommended follows, before any good check.
    expect(labels[2]).toBe("Administrator accounts");
    // No good check appears before a critical/recommended one.
    const firstGood = labels.indexOf("Core file integrity");
    const lastNonGood = labels.indexOf("Administrator accounts");
    expect(firstGood).toBeGreaterThan(lastNonGood);
  });

  test("renders the PostureSummary legend counts", () => {
    mockUseManagePanel.mockReturnValue(loaded(SECURITY_DATA));
    const { container } = render(<SecurityPanel site="demo" />);

    const summary = container.querySelector("dl");
    expect(summary).not.toBeNull();
    const dl = within(summary as HTMLElement);
    // Legend rows pair a state word with its tabular count.
    expect(dl.getByText("Good")).toBeInTheDocument();
    expect(dl.getByText("Recommended")).toBeInTheDocument();
    expect(dl.getByText("Critical")).toBeInTheDocument();
  });
});

describe("HealthPanel", () => {
  test("renders the checklist, summary and a 'Critical' verdict pill when checks fail", () => {
    mockUseManagePanel.mockReturnValue(loaded(HEALTH_MIXED));
    const { container } = renderWithClient(<HealthPanel site="demo" />);

    // Overall verdict pill (a critical check present).
    expect(verdictPill(container)).toHaveTextContent("Critical");
    // Every check is listed (source order preserved).
    expect(checklistLabels(container)).toEqual(HEALTH_MIXED.checks.map((c) => c.label));
    // Environment facts still render.
    expect(screen.getByText("6.5.2")).toBeInTheDocument();
    expect(screen.getByText("42 MB")).toBeInTheDocument();
  });

  test("shows an all-clear EmptyState and 'Healthy' pill when every check passes", () => {
    mockUseManagePanel.mockReturnValue(loaded(HEALTH_ALL_GOOD));
    const { container } = renderWithClient(<HealthPanel site="demo" />);

    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("All checks passing")).toBeInTheDocument();
    // The per-check checklist is replaced by the celebratory empty state.
    expect(container.querySelectorAll("ul li")).toHaveLength(0);
  });
});
