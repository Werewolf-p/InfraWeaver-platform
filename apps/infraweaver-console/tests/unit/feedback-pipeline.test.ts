import type { FeedbackEntry } from "@/lib/feedback-store";
import type { DispatchRun } from "@/lib/feedback-dispatch";

// `server-only` is a build-time marker with no Jest resolution; stub it out.
jest.mock("server-only", () => ({}), { virtual: true });

// The pipeline orchestrates two collaborators; stub them so the test asserts
// only the status-reconciliation logic in `reconcileFromRuns`.
const patchFeedbackEntry = jest.fn();
jest.mock("@/lib/feedback-store", () => ({
  patchFeedbackEntry: (...args: unknown[]) => patchFeedbackEntry(...args),
  markAllAcceptedDone: jest.fn(),
  updateFeedbackStatus: jest.fn(),
}));

const listFeedbackRuns = jest.fn();
jest.mock("@/lib/feedback-dispatch", () => ({
  dispatchApprovedFeedback: jest.fn(),
  validateFeedback: jest.fn(),
  publishAllFeedback: jest.fn(),
  listFeedbackRuns: (...args: unknown[]) => listFeedbackRuns(...args),
}));

import { reconcileStaleEntries } from "@/lib/feedback-pipeline";

function makeEntry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    id: "fb-1",
    description: "broken",
    type: "bug",
    pagePath: "/feedback",
    status: "approved",
    createdBy: "u@example.com",
    createdAt: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<DispatchRun> = {}): DispatchRun {
  return {
    runId: "run-1",
    feedbackId: "fb-1",
    kind: "approve",
    phase: "build",
    status: "failed",
    startedAt: "2026-06-10T00:00:00.000Z",
    finishedAt: "2026-06-10T00:15:00.000Z",
    exitCode: 1,
    previewUrl: null,
    tag: null,
    commit: null,
    ...overrides,
  };
}

beforeEach(() => {
  patchFeedbackEntry.mockReset();
  listFeedbackRuns.mockReset();
});

describe("reconcileFromRuns (via reconcileStaleEntries)", () => {
  test("advances to dispatched when a successful run has a preview URL", async () => {
    listFeedbackRuns.mockResolvedValue([
      makeRun({ status: "success", previewUrl: "https://preview.example.com", runId: "run-ok" }),
    ]);

    await reconcileStaleEntries([makeEntry()]);

    expect(patchFeedbackEntry).toHaveBeenCalledWith("fb-1", {
      status: "dispatched",
      previewUrl: "https://preview.example.com",
      testPath: "/feedback",
      dispatchRunId: "run-ok",
    });
  });

  test("reverts to approved (not dispatched) when the build failed with no preview", async () => {
    listFeedbackRuns.mockResolvedValue([makeRun({ status: "failed", previewUrl: null, runId: "run-fail" })]);

    await reconcileStaleEntries([makeEntry()]);

    expect(patchFeedbackEntry).toHaveBeenCalledWith("fb-1", {
      status: "approved",
      dispatchRunId: "run-fail",
    });
  });

  test("leaves a still-running entry untouched", async () => {
    listFeedbackRuns.mockResolvedValue([makeRun({ status: "running" })]);

    await reconcileStaleEntries([makeEntry()]);

    expect(patchFeedbackEntry).not.toHaveBeenCalled();
  });

  test("heals a dispatched entry that has no preview URL by backfilling from its successful run", async () => {
    // Stranded by a console restart: advanced to `dispatched` but the preview URL
    // write-back never landed. The successful run is the authoritative source.
    listFeedbackRuns.mockResolvedValue([
      makeRun({ status: "success", previewUrl: "https://preview.example.com", runId: "run-ok" }),
    ]);

    await reconcileStaleEntries([makeEntry({ status: "dispatched", previewUrl: undefined })]);

    expect(patchFeedbackEntry).toHaveBeenCalledWith("fb-1", {
      status: "dispatched",
      previewUrl: "https://preview.example.com",
      testPath: "/feedback",
      dispatchRunId: "run-ok",
    });
  });

  test("does NOT re-reconcile a dispatched entry that already has a preview URL", async () => {
    await reconcileStaleEntries([
      makeEntry({ status: "dispatched", previewUrl: "https://existing.example.com" }),
    ]);

    expect(listFeedbackRuns).not.toHaveBeenCalled();
    expect(patchFeedbackEntry).not.toHaveBeenCalled();
  });
});
