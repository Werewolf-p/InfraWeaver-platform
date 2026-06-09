import React from "react";
import { render, screen, waitFor } from "@testing-library/react";

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

function makeEntry(id: string): FeedbackEntry {
  return {
    id,
    description: "Something is broken",
    type: "bug",
    pagePath: "/feedback",
    status: "new",
    createdBy: "tester",
    createdAt: new Date().toISOString(),
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
