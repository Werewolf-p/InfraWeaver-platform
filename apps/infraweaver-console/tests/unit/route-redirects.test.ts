import { redirect } from "next/navigation";

// Each folded legacy route keeps a thin `page.tsx` that redirect()s into its new
// hub tab, so old URLs and bookmarks never break. This locks the redirect map.
jest.mock("next/navigation", () => ({
  redirect: jest.fn(),
}));

import UsersRedirect from "@/app/(dashboard)/users/page";
import AccessRedirect from "@/app/(dashboard)/access/page";
import RbacRedirect from "@/app/(dashboard)/rbac/page";
import AppsRedirect from "@/app/(dashboard)/apps/page";
import AppGraphRedirect from "@/app/(dashboard)/app-graph/page";
import GameHubRedirect from "@/app/(dashboard)/game-hub/page";
// NB: /wordpress deliberately renders <WordpressView/> in place instead of
// redirecting to /workloads?tab=wordpress — a redirect hop flashed the hub's
// default Apps tab before ?tab resolved. See wordpress/page.tsx. So it is not a
// member of this redirect map.
import GameServersRedirect from "@/app/(dashboard)/gameservers/page";
import RoutesRedirect from "@/app/(dashboard)/routes/page";
import DnsRedirect from "@/app/(dashboard)/dns/page";

const mockedRedirect = redirect as unknown as jest.Mock;

describe("legacy route → hub redirect map", () => {
  const cases: Array<[string, () => unknown, string]> = [
    ["/users", UsersRedirect, "/identity"],
    ["/access", AccessRedirect, "/identity?tab=pim"],
    ["/rbac", RbacRedirect, "/identity?tab=rbac"],
    ["/apps", AppsRedirect, "/workloads"],
    ["/app-graph", AppGraphRedirect, "/workloads?tab=graph"],
    ["/game-hub", GameHubRedirect, "/workloads?tab=game"],
    ["/gameservers", GameServersRedirect, "/workloads?tab=routing"],
    ["/routes", RoutesRedirect, "/workloads?tab=routing"],
    ["/dns", DnsRedirect, "/workloads?tab=routing"],
  ];

  it.each(cases)("redirects %s to its hub tab", (_legacy, Component, target) => {
    // Arrange
    mockedRedirect.mockClear();
    // Act
    Component();
    // Assert
    expect(mockedRedirect).toHaveBeenCalledWith(target);
  });
});
