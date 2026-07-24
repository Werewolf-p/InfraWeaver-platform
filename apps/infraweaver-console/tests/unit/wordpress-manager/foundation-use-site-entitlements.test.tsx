import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { useSiteEntitlements } from "@/addons/wordpress-manager/lib/manage/use-site-entitlements";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function mockLink(link: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ link }),
  }) as unknown as typeof fetch;
}

describe("useSiteEntitlements", () => {
  afterEach(() => jest.restoreAllMocks());

  test("resolves tier + flags from the link's authoritative tier", async () => {
    mockLink({ tier: "care_pro", state: "active", fingerprintConfirmed: true });
    const { result } = renderHook(() => useSiteEntitlements("hi2"), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tier).toBe("care_pro");
    expect(result.current.has("image_optimization")).toBe(true); // granted at Pro
    expect(result.current.has("white_label")).toBe(false); // Ultimate-only
    expect(result.current.connectorActive).toBe(true);
  });

  test("an unlinked site resolves to Free with no flags and no active connector", async () => {
    mockLink(null);
    const { result } = renderHook(() => useSiteEntitlements("hi2"), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tier).toBe("free");
    expect(result.current.has("image_optimization")).toBe(false);
    expect(result.current.connectorActive).toBe(false);
  });

  test("isSwitchedOff is true only when a granted flag's switch is explicitly false", async () => {
    mockLink({ tier: "care_pro", state: "active", fingerprintConfirmed: true, featureSwitches: { page_cache: false } });
    const { result } = renderHook(() => useSiteEntitlements("hi2"), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isSwitchedOff("page_cache")).toBe(true);
    expect(result.current.isSwitchedOff("image_optimization")).toBe(false); // granted, no switch → on
  });
});
