import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { FeatureChip, TierGate } from "@/addons/wordpress-manager/components/manage/kit/tier-gate";
import type { SiteEntitlementsView } from "@/addons/wordpress-manager/lib/manage/use-site-entitlements";
import { useSiteEntitlements } from "@/addons/wordpress-manager/lib/manage/use-site-entitlements";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

jest.mock("@/addons/wordpress-manager/lib/manage/use-site-entitlements", () => ({
  useSiteEntitlements: jest.fn(),
  siteEntitlementsKey: (site: string) => ["wordpress-iwsl-link", site],
}));

const mockEnt = useSiteEntitlements as unknown as jest.Mock;

function view(overrides: Partial<SiteEntitlementsView>): SiteEntitlementsView {
  return {
    tier: "free",
    flags: {},
    switches: {},
    connectorActive: true,
    identitySuspended: false,
    loading: false,
    error: null,
    has: () => false,
    isSwitchedOff: () => false,
    ...overrides,
  };
}

describe("TierGate", () => {
  test("renders the feature when the flag is granted", () => {
    mockEnt.mockReturnValue(view({ has: () => true }));
    render(
      <TierGate site="hi2" flag="image_optimization">
        <div>the real feature</div>
      </TierGate>,
    );
    expect(screen.getByText("the real feature")).toBeInTheDocument();
  });

  test("renders an upsell lock card naming the cheapest granting tier when locked", () => {
    mockEnt.mockReturnValue(view({ has: () => false }));
    render(
      <TierGate site="hi2" flag="image_optimization">
        <div>the real feature</div>
      </TierGate>,
    );
    expect(screen.queryByText("the real feature")).not.toBeInTheDocument();
    expect(screen.getByText("Included in Pro")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /manage plan/i });
    expect(link).toHaveAttribute("href", expect.stringContaining("section=plan"));
  });

  test("renders a switched-off card with an enable affordance when granted but off", () => {
    const onEnable = jest.fn();
    mockEnt.mockReturnValue(view({ has: () => true, isSwitchedOff: () => true }));
    render(
      <TierGate site="hi2" flag="page_cache" onEnable={onEnable}>
        <div>the real feature</div>
      </TierGate>,
    );
    expect(screen.getByText("Turned off on this site")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /enable/i }));
    expect(onEnable).toHaveBeenCalledTimes(1);
  });

  test("renders a skeleton (no feature, no lock) while loading", () => {
    mockEnt.mockReturnValue(view({ loading: true }));
    render(
      <TierGate site="hi2" flag="image_optimization">
        <div>the real feature</div>
      </TierGate>,
    );
    expect(screen.queryByText("the real feature")).not.toBeInTheDocument();
    expect(screen.queryByText("Included in Pro")).not.toBeInTheDocument();
  });
});

describe("FeatureChip", () => {
  test("uses the active tone when active and the inactive tone when not", () => {
    const { rerender } = render(<FeatureChip label="lossless" active />);
    expect(screen.getByText("lossless").className).toContain("text-emerald-600");
    rerender(<FeatureChip label="lossless" active={false} />);
    expect(screen.getByText("lossless").className).toContain("text-zinc-600");
  });
});
