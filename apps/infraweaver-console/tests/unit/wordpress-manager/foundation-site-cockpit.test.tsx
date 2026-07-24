import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { SiteCockpit } from "@/addons/wordpress-manager/components/manage/site-cockpit";

const replace = jest.fn();
let searchParams = new URLSearchParams("");

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/wordpress/hi2",
  useSearchParams: () => searchParams,
}));

describe("SiteCockpit", () => {
  beforeEach(() => {
    replace.mockClear();
    searchParams = new URLSearchParams("");
  });

  test("renders the promoted vertical rail as the site's nav", () => {
    render(<SiteCockpit site="hi2" />);
    // The rail is a nav landmark with grouped sections; Overview always leads
    // (a group header AND its section both read "Overview" — assert the active one).
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    const overview = screen.getByRole("button", { name: /^overview$/i, current: "page" });
    expect(overview).toBeInTheDocument();
  });

  test("honours a deep-linked ?section= and marks it current", () => {
    searchParams = new URLSearchParams("section=media");
    render(<SiteCockpit site="hi2" />);
    const mediaBtn = screen.getByRole("button", { name: /^media$/i });
    expect(mediaBtn).toHaveAttribute("aria-current", "page");
    // Default section body names the active section.
    expect(screen.getByText(/"media" surface/)).toBeInTheDocument();
  });

  test("selecting a section syncs it to ?section= via router.replace", () => {
    render(<SiteCockpit site="hi2" />);
    fireEvent.click(screen.getByRole("button", { name: /^backups$/i }));
    expect(replace).toHaveBeenCalledWith("/wordpress/hi2?section=backups", { scroll: false });
  });

  test("renders a domain-supplied section body when provided", () => {
    searchParams = new URLSearchParams("section=media");
    render(<SiteCockpit site="hi2" renderSection={(s) => <div>panel-for-{s}</div>} />);
    expect(screen.getByText("panel-for-media")).toBeInTheDocument();
  });
});
