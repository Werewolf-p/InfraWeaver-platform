import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// framer-motion ships ESM that ts-jest does not transform — swap it for plain
// DOM elements (same shim as feedback-review-queue.test.tsx).
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
          (_target: unknown, tag: string) =>
          ({ children, className }: { children?: React.ReactNode; className?: string }) =>
            ReactLib.createElement(tag, { className }, children),
      },
    ),
  };
});

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// The runtime card drags in the firewall surface (and next-auth ESM via
// useRBAC); its logic is covered by its own unit tests — stub it out here.
jest.mock("@/addons/wordpress-manager/components/site-runtime-card", () => ({
  SiteRuntimeCard: () => null,
}));

const toastSuccess = jest.fn();
const toastError = jest.fn();
jest.mock("@/lib/notify", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

// --- Controllable react-query mock ---------------------------------------------
// useQuery serves data/error keyed by queryKey[0]; useMutation runs the real
// mutationFn (against the mocked fetch) and keeps its resolved value so the
// component's `mutation.data` panels render after a rerender.

let queryData: Record<string, unknown> = {};
let queryErrors: Record<string, boolean> = {};
const invalidateQueries = jest.fn().mockResolvedValue(undefined);

let mutationIndex = 0;
let mutationData: Record<number, unknown> = {};

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => {
    // Called once at the top of every component render — reuse it to reset the
    // per-render useMutation counter so indexed mutation state stays stable.
    mutationIndex = 0;
    return { invalidateQueries };
  },
  useQuery: ({ queryKey }: { queryKey: [string, string] }) => ({
    data: queryData[queryKey[0]],
    isLoading: false,
    isError: Boolean(queryErrors[queryKey[0]]),
  }),
  useMutation: (opts: {
    mutationFn: (arg?: unknown) => Promise<unknown>;
    onSuccess?: (data: unknown, arg?: unknown) => void;
    onError?: (error: Error) => void;
  }) => {
    const idx = mutationIndex++;
    return {
      isPending: false,
      data: mutationData[idx],
      mutate: (arg?: unknown) => {
        opts.mutationFn(arg).then(
          (data) => {
            mutationData[idx] = data;
            opts.onSuccess?.(data, arg);
          },
          (error) => opts.onError?.(error as Error),
        );
      },
    };
  },
}));

import { SiteDetailView } from "@/addons/wordpress-manager/components/site-detail-view";

const SITE = "demo";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

let fetchMock: jest.Mock;

beforeEach(() => {
  queryData = {
    "wordpress-plugins": { catalog: [], installed: [] },
    "wordpress-site-status": { site: SITE, host: `${SITE}.example.com`, ready: true, replicas: 1 },
    "wordpress-access": { group: "g", allowed: [] },
    "wordpress-maintenance": { site: SITE, enabled: false },
  };
  queryErrors = {};
  mutationData = {};
  invalidateQueries.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  fetchMock = jest.fn().mockResolvedValue(jsonResponse({}));
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("SiteDetailView maintenance card", () => {
  test("shows the Off pill and an enable button when maintenance is disabled", () => {
    render(<SiteDetailView site={SITE} />);

    expect(screen.getByText("Maintenance mode")).toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enable maintenance/i })).toBeEnabled();
  });

  test("enabling maintenance PUTs { enabled: true } and reports success", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ site: SITE, enabled: true }));
    render(<SiteDetailView site={SITE} />);

    fireEvent.click(screen.getByRole("button", { name: /enable maintenance/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(`/api/wordpress/sites/${SITE}/maintenance`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["wordpress-maintenance", SITE] });
  });

  test("disabling maintenance PUTs { enabled: false } from the enabled state", async () => {
    queryData["wordpress-maintenance"] = { site: SITE, enabled: true };
    fetchMock.mockResolvedValue(jsonResponse({ site: SITE, enabled: false }));
    render(<SiteDetailView site={SITE} />);

    expect(screen.getByText("Maintenance page up")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /take out of maintenance/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/wordpress/sites/${SITE}/maintenance`,
      expect.objectContaining({ body: JSON.stringify({ enabled: false }) }),
    );
  });

  test("shows a fallback note instead of the toggle when the state has never been read", () => {
    queryData["wordpress-maintenance"] = undefined;
    queryErrors["wordpress-maintenance"] = true;
    render(<SiteDetailView site={SITE} />);

    expect(screen.getByText(/can.t be read right now/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enable maintenance/i })).not.toBeInTheDocument();
  });

  test("keeps the toggle when a background refetch fails but cached state exists", () => {
    queryData["wordpress-maintenance"] = { site: SITE, enabled: true };
    queryErrors["wordpress-maintenance"] = true;
    render(<SiteDetailView site={SITE} />);

    expect(screen.queryByText(/can.t be read right now/i)).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /take out of maintenance/i });
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  test("surfaces the server error message when the toggle fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "site pod is not running" }, false, 503));
    render(<SiteDetailView site={SITE} />);

    fireEvent.click(screen.getByRole("button", { name: /enable maintenance/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("site pod is not running"));
  });
});

describe("SiteDetailView plugin updates card", () => {
  test("POSTs to the bulk update endpoint and lists per-plugin results", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        updated: [
          { slug: "akismet", oldVersion: "5.0", newVersion: "5.3", status: "Updated" },
          { slug: "broken-plugin", oldVersion: "1.0", newVersion: null, status: "Error" },
        ],
      }),
    );
    const { rerender } = render(<SiteDetailView site={SITE} />);

    fireEvent.click(screen.getByRole("button", { name: /update all plugins/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Plugin update finished (2 processed)"));
    expect(fetchMock).toHaveBeenCalledWith(`/api/wordpress/sites/${SITE}/plugins/update`, { method: "POST" });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["wordpress-plugins", SITE] });

    // The results panel reads mutation.data — rerender to pick up the resolved value.
    rerender(<SiteDetailView site={SITE} />);
    expect(screen.getByText("akismet")).toBeInTheDocument();
    expect(screen.getByText("5.0 → 5.3")).toBeInTheDocument();
    expect(screen.getByText("Updated")).toBeInTheDocument();
    expect(screen.getByText("broken-plugin")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  test("reports everything up to date when no plugins needed updating", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ updated: [] }));
    const { rerender } = render(<SiteDetailView site={SITE} />);

    fireEvent.click(screen.getByRole("button", { name: /update all plugins/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("All plugins are already up to date"));
    rerender(<SiteDetailView site={SITE} />);
    expect(screen.getByText("Everything is already up to date.")).toBeInTheDocument();
  });

  test("surfaces the server error message when the bulk update fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "update failed" }, false, 500));
    render(<SiteDetailView site={SITE} />);

    fireEvent.click(screen.getByRole("button", { name: /update all plugins/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("update failed"));
  });
});
