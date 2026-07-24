import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { postSignedOp, useSignedOp } from "@/addons/wordpress-manager/lib/manage/use-signed-op";

const toastSuccess = jest.fn();
const toastError = jest.fn();
jest.mock("@/lib/notify", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    warning: jest.fn(),
  },
}));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("postSignedOp", () => {
  afterEach(() => jest.restoreAllMocks());

  test("POSTs { action, ...extra } to the site's signed /iwsl/ops route", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await postSignedOp("hi2", "flush-cache", { scope: "all" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/wordpress/sites/hi2/iwsl/ops",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({ action: "flush-cache", scope: "all" });
  });

  test("throws the server error message on a non-ok response", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "nope" }) }) as unknown as typeof fetch;
    await expect(postSignedOp("hi2", "rotate")).rejects.toThrow("nope");
  });
});

describe("useSignedOp", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  test("runs the op, toasts success, and clears error", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }) as unknown as typeof fetch;
    const { result } = renderHook(() => useSignedOp("hi2"), { wrapper: wrapper() });

    await act(async () => {
      await result.current.run("health", undefined, { successMessage: "Checked" });
    });

    expect(toastSuccess).toHaveBeenCalledWith("Checked");
    expect(result.current.error).toBeNull();
  });

  test("surfaces a failure via error state + error toast", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "boom" }) }) as unknown as typeof fetch;
    const { result } = renderHook(() => useSignedOp("hi2"), { wrapper: wrapper() });

    await act(async () => {
      await expect(result.current.run("rotate")).rejects.toThrow("boom");
    });

    await waitFor(() => expect(result.current.error).toBe("boom"));
    expect(toastError).toHaveBeenCalledWith("boom");
  });
});
