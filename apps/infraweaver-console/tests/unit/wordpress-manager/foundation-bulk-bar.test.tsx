import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BulkActionBar, type BulkActionMeta } from "@/addons/wordpress-manager/components/manage/kit/bulk-bar";

// framer-motion ships ESM ts-jest doesn't transform — swap for plain DOM.
jest.mock("framer-motion", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- factory can't see the outer React import
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
    useReducedMotion: () => false,
  };
});

jest.mock("@/lib/notify", () => ({
  toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
}));

const ACTIONS: BulkActionMeta[] = [{ id: "make-lossless", label: "Make lossless" }];

describe("BulkActionBar", () => {
  test("is hidden when nothing is selected", () => {
    render(<BulkActionBar count={0} ids={[]} actions={ACTIONS} runItem={jest.fn()} onClear={jest.fn()} />);
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  test("shows the count and offered actions when a selection exists", () => {
    render(
      <BulkActionBar count={3} ids={["a", "b", "c"]} actions={ACTIONS} runItem={jest.fn()} onClear={jest.fn()} />,
    );
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make lossless" })).toBeInTheDocument();
  });

  test("Clear calls onClear", () => {
    const onClear = jest.fn();
    render(<BulkActionBar count={2} ids={["a", "b"]} actions={ACTIONS} runItem={jest.fn()} onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  test("running a non-confirm action fans out per-item and completes with a summary", async () => {
    const runItem = jest.fn().mockResolvedValue({ ok: true });
    const onComplete = jest.fn();
    render(
      <BulkActionBar
        count={3}
        ids={["a", "b", "c"]}
        actions={ACTIONS}
        runItem={runItem}
        onClear={jest.fn()}
        onComplete={onComplete}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Make lossless" }));

    await waitFor(() => expect(screen.getByText(/Done — all 3 succeeded/)).toBeInTheDocument());
    expect(runItem).toHaveBeenCalledTimes(3);
    expect(runItem).toHaveBeenCalledWith("make-lossless", "a");
    expect(onComplete).toHaveBeenCalledWith("make-lossless");
  });
});
