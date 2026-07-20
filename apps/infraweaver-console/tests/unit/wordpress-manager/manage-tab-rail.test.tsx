import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { MANAGE_PANELS, type ManagePanelDef } from "@/addons/wordpress-manager/lib/manage/capabilities";
import { ManageTabRail, OPTIONAL_TAB } from "@/addons/wordpress-manager/components/demo/manage/tab-rail";

const panel = (id: string): ManagePanelDef => {
  const found = MANAGE_PANELS.find((p) => p.id === id);
  if (!found) throw new Error(`unknown panel ${id}`);
  return found;
};

// updates + inventory are cluster "maintain"; content is cluster "content" — so
// this spans a group boundary (exercises the divider path too).
const VISIBLE = [panel("updates"), panel("inventory"), panel("content")];

describe("ManageTabRail", () => {
  test("renders a WAI-ARIA tablist with the active tab selected and roving tabindex", () => {
    render(
      <ManageTabRail panels={VISIBLE} activeTab="updates" disabledCount={2} onSelect={jest.fn()} loading={false} />,
    );

    expect(screen.getByRole("tablist", { name: /manage sections/i })).toBeInTheDocument();

    const updates = screen.getByRole("tab", { name: "Updates" });
    expect(updates).toHaveAttribute("aria-selected", "true");
    expect(updates).toHaveAttribute("tabindex", "0");

    const content = screen.getByRole("tab", { name: "Content" });
    expect(content).toHaveAttribute("aria-selected", "false");
    expect(content).toHaveAttribute("tabindex", "-1");
  });

  test("gated panels collapse into a distinct Optional tab that shows the count", () => {
    render(
      <ManageTabRail panels={VISIBLE} activeTab="updates" disabledCount={2} onSelect={jest.fn()} loading={false} />,
    );
    const optional = screen.getByRole("tab", { name: /optional/i });
    expect(optional).toHaveAccessibleName(/2 not installed/i);
    expect(optional).toHaveTextContent("2");
  });

  test("omits the Optional tab when nothing is gated off", () => {
    render(
      <ManageTabRail panels={VISIBLE} activeTab="updates" disabledCount={0} onSelect={jest.fn()} loading={false} />,
    );
    expect(screen.queryByRole("tab", { name: /optional/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(VISIBLE.length);
  });

  test("clicking a tab selects it", () => {
    const onSelect = jest.fn();
    render(
      <ManageTabRail panels={VISIBLE} activeTab="updates" disabledCount={2} onSelect={onSelect} loading={false} />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Content" }));
    expect(onSelect).toHaveBeenCalledWith("content");
  });

  test("ArrowRight moves selection to the next tab, End jumps to Optional", () => {
    const onSelect = jest.fn();
    render(
      <ManageTabRail panels={VISIBLE} activeTab="updates" disabledCount={2} onSelect={onSelect} loading={false} />,
    );
    const updates = screen.getByRole("tab", { name: "Updates" });
    fireEvent.keyDown(updates, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("inventory");
    fireEvent.keyDown(updates, { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith(OPTIONAL_TAB);
  });

  test("shows a skeleton (no tablist) while the overview is loading", () => {
    render(
      <ManageTabRail panels={[]} activeTab="updates" disabledCount={0} onSelect={jest.fn()} loading={true} />,
    );
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });
});
