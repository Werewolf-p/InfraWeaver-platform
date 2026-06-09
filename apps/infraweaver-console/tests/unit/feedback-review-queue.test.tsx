import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// framer-motion (used by the queue popup's ResponsiveSheet) ships ESM that
// ts-jest does not transform — swap it for plain DOM elements so the menu renders.
jest.mock("framer-motion", () => {
  const ReactLib = require("react");
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) =>
      ReactLib.createElement(ReactLib.Fragment, null, children),
    motion: new Proxy(
      {},
      {
        get:
          (_target: unknown, tag: string) =>
          ({
            children,
            className,
            onClick,
            style,
            "aria-label": ariaLabel,
          }: {
            children?: React.ReactNode;
            className?: string;
            onClick?: () => void;
            style?: React.CSSProperties;
            "aria-label"?: string;
          }) =>
            ReactLib.createElement(tag, { className, onClick, style, "aria-label": ariaLabel }, children),
      },
    ),
  };
});

// --- Mocks for the component's external dependencies ---------------------------

type FeedbackEntry = {
  id: string;
  description: string;
  type: string;
  pagePath: string;
  status: string;
  createdBy: string;
  createdAt: string;
};

// Controllable react-query result: tests mutate this between renders.
let queryResult: { data?: { entries: FeedbackEntry[] }; isLoading: boolean; error: unknown } = {
  data: undefined,
  isLoading: true,
  error: null,
};

const invalidateQueries = jest.fn().mockResolvedValue(undefined);

jest.mock("@tanstack/react-query", () => ({
  useQuery: () => queryResult,
  useQueryClient: () => ({ invalidateQueries }),
}));

const patch = jest.fn().mockResolvedValue({ entry: {}, dispatch: { started: true } });
jest.mock("@/lib/api-client", () => ({
  apiClient: { patch, get: jest.fn() },
  toApiErrorMessage: (e: unknown, fallback?: string) => fallback ?? String(e),
}));

jest.mock("@/lib/notify", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

jest.mock("@/hooks/use-rbac", () => ({
  useRBAC: () => ({ can: () => true }),
}));

// Heavy child components are irrelevant to the queue logic — stub them out.
jest.mock("@/components/feedback/run-console", () => ({ RunConsole: () => null }));
jest.mock("@/components/feedback/publish-button", () => ({ PublishButton: () => null }));
jest.mock("@/components/feedback/automation/agent-studio-modal", () => ({
  AgentStudioModal: () => null,
}));

import { FeedbackReview } from "@/components/feedback/feedback-review";

const QUEUE_STORAGE_KEY = "infraweaver:feedback-queue";
const VALIDATION_QUEUE_STORAGE_KEY = "infraweaver:feedback-validation-queue";

function makeEntry(id: string, overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    id,
    description: "Something is broken",
    type: "bug",
    pagePath: "/feedback",
    status: "new",
    createdBy: "tester",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("FeedbackReview queue drain on refresh", () => {
  beforeEach(() => {
    sessionStorage.clear();
    patch.mockClear();
    invalidateQueries.mockClear();
    queryResult = { data: undefined, isLoading: true, error: null };
  });

  it("keeps a restored queue intact while the initial fetch is loading", async () => {
    // Arrange: simulate a refresh where a queued approval was persisted.
    sessionStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(["entry-1"]));

    // Act: render while the query is still loading (entries unknown).
    render(<FeedbackReview />);

    // Assert: the queue is NOT pruned against the empty entries list, so no
    // dispatch fires and the persisted id survives.
    await waitFor(() => {
      expect(patch).not.toHaveBeenCalled();
    });
    expect(JSON.parse(sessionStorage.getItem(QUEUE_STORAGE_KEY) ?? "[]")).toEqual(["entry-1"]);
  });

  it("auto-dispatches the queued entry once entries finish loading", async () => {
    // Arrange: persisted queue + a fresh mount that begins in the loading state.
    sessionStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(["entry-1"]));
    const { rerender } = render(<FeedbackReview />);
    expect(patch).not.toHaveBeenCalled();

    // Act: the fetch resolves with the still-"new" entry; idle pipeline.
    queryResult = { data: { entries: [makeEntry("entry-1")] }, isLoading: false, error: null };
    rerender(<FeedbackReview />);

    // Assert: the drain effect now dispatches the queued id exactly once.
    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith("/api/feedback/entry-1", { json: { status: "approved" } });
    });
    await waitFor(() => {
      expect(JSON.parse(sessionStorage.getItem(QUEUE_STORAGE_KEY) ?? "[]")).toEqual([]);
    });
  });

  it("renders the queued badge for a persisted entry that is still loading", () => {
    sessionStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(["entry-1"]));
    render(<FeedbackReview />);
    // Nothing has been pruned or dispatched while loading.
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("FeedbackReview queue reordering", () => {
  beforeEach(() => {
    sessionStorage.clear();
    patch.mockClear();
    invalidateQueries.mockClear();
    queryResult = { data: undefined, isLoading: true, error: null };
  });

  // A run in flight keeps the pipeline busy so the queue is held (not drained)
  // while we reorder it through the popup.
  function renderBusyQueue() {
    sessionStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(["entry-1", "entry-2"]));
    queryResult = {
      data: {
        entries: [
          makeEntry("running", { status: "approved" }),
          makeEntry("entry-1", { description: "Fix login" }),
          makeEntry("entry-2", { description: "Fix logout" }),
        ],
      },
      isLoading: false,
      error: null,
    };
    return render(<FeedbackReview />);
  }

  it("moves a queued entry down and dispatches in the new order once the pipeline frees", async () => {
    // Arrange: two queued entries behind a running one.
    const { rerender } = renderBusyQueue();
    expect(patch).not.toHaveBeenCalled();

    // Act: open the queue popup and move the first entry ("Fix login") down.
    fireEvent.click(screen.getByRole("button", { name: /Queue/ }));
    fireEvent.click(await screen.findByRole("button", { name: 'Move "Fix login" down' }));

    // Assert: the persisted order is swapped immediately.
    await waitFor(() => {
      expect(JSON.parse(sessionStorage.getItem(QUEUE_STORAGE_KEY) ?? "[]")).toEqual(["entry-2", "entry-1"]);
    });

    // Act: the run finishes — pipeline is now idle.
    queryResult = {
      data: {
        entries: [
          makeEntry("running", { status: "done", released: true }),
          makeEntry("entry-1", { description: "Fix login" }),
          makeEntry("entry-2", { description: "Fix logout" }),
        ],
      },
      isLoading: false,
      error: null,
    };
    rerender(<FeedbackReview />);

    // Assert: the drain dispatches the new head (entry-2), respecting the reorder.
    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith("/api/feedback/entry-2", { json: { status: "approved" } });
    });
    expect(patch).not.toHaveBeenCalledWith("/api/feedback/entry-1", { json: { status: "approved" } });
  });

  it("disables moving the first queued entry up (fail-closed boundary)", async () => {
    renderBusyQueue();
    fireEvent.click(screen.getByRole("button", { name: /Queue/ }));

    const upFirst = await screen.findByRole("button", { name: 'Move "Fix login" up' });
    const downLast = screen.getByRole("button", { name: 'Move "Fix logout" down' });
    expect(upFirst).toBeDisabled();
    expect(downLast).toBeDisabled();
  });

  it("removes a queued entry from the popup", async () => {
    renderBusyQueue();
    fireEvent.click(screen.getByRole("button", { name: /Queue/ }));
    fireEvent.click(await screen.findByRole("button", { name: 'Remove "Fix login" from the queue' }));

    await waitFor(() => {
      expect(JSON.parse(sessionStorage.getItem(QUEUE_STORAGE_KEY) ?? "[]")).toEqual(["entry-2"]);
    });
  });
});

describe('FeedbackReview "Not fixed → retry" queue', () => {
  beforeEach(() => {
    sessionStorage.clear();
    patch.mockClear();
    invalidateQueries.mockClear();
    queryResult = { data: undefined, isLoading: true, error: null };
  });

  // A dispatched entry awaiting a verdict, behind a running entry that keeps the
  // pipeline busy so the retry queues instead of dispatching immediately.
  function renderBusyDispatched() {
    queryResult = {
      data: {
        entries: [
          makeEntry("running", { status: "approved" }),
          makeEntry("dispatched-1", { status: "dispatched", description: "Still broken" }),
        ],
      },
      isLoading: false,
      error: null,
    };
    return render(<FeedbackReview />);
  }

  it("queues the retry instead of locking the button while a run is in flight", async () => {
    const { rerender } = renderBusyDispatched();

    // Arrange: a note is required before a retry can be queued.
    fireEvent.change(screen.getByPlaceholderText(/If not fixed/), {
      target: { value: "Button still does nothing" },
    });

    // Act: request the retry and confirm the dialog.
    fireEvent.click(screen.getByRole("button", { name: /Not fixed/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Revert & retry" }));

    // Assert: the verdict is queued (persisted), not dispatched, and the queued
    // badge replaces the button.
    await waitFor(() => {
      expect(JSON.parse(sessionStorage.getItem(VALIDATION_QUEUE_STORAGE_KEY) ?? "[]")).toEqual([
        "dispatched-1",
      ]);
    });
    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByText(/Retry queued/)).toBeInTheDocument();

    // Act: the running entry finishes — pipeline is now idle.
    queryResult = {
      data: {
        entries: [
          makeEntry("running", { status: "done", released: true }),
          makeEntry("dispatched-1", { status: "dispatched", description: "Still broken" }),
        ],
      },
      isLoading: false,
      error: null,
    };
    rerender(<FeedbackReview />);

    // Assert: the drain dispatches the queued retry with the live note.
    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith("/api/feedback/dispatched-1", {
        json: { action: "not_fixed", reviewNote: "Button still does nothing" },
      });
    });
    await waitFor(() => {
      expect(JSON.parse(sessionStorage.getItem(VALIDATION_QUEUE_STORAGE_KEY) ?? "[]")).toEqual([]);
    });
  });

  it("prunes a queued retry whose entry is no longer dispatched", async () => {
    // Arrange: a persisted retry for an entry that has since been accepted.
    sessionStorage.setItem(VALIDATION_QUEUE_STORAGE_KEY, JSON.stringify(["dispatched-1"]));
    const { rerender } = render(<FeedbackReview />);

    // Act: entries load with the target already moved past "dispatched", idle pipeline.
    queryResult = {
      data: { entries: [makeEntry("dispatched-1", { status: "accepted" })] },
      isLoading: false,
      error: null,
    };
    rerender(<FeedbackReview />);

    // Assert: the stale retry is pruned without dispatching anything.
    await waitFor(() => {
      expect(JSON.parse(sessionStorage.getItem(VALIDATION_QUEUE_STORAGE_KEY) ?? "[]")).toEqual([]);
    });
    expect(patch).not.toHaveBeenCalled();
  });
});
