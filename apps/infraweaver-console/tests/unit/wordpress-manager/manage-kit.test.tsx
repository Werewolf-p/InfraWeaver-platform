import React from "react";
import { render, screen, within } from "@testing-library/react";
import {
  DataTable,
  EmptyState,
  Pill,
  type Column,
} from "@/addons/wordpress-manager/components/demo/manage/kit";

interface Row {
  readonly id: number;
  readonly name: string;
  readonly count: number;
}

const ROWS: readonly Row[] = [
  { id: 1, name: "alice", count: 3 },
  { id: 2, name: "bob", count: 7 },
];

const COLUMNS: Column<Row>[] = [
  { key: "name", header: "Name", render: (r) => r.name },
  { key: "count", header: "Count", align: "right", render: (r) => r.count },
];

describe("DataTable", () => {
  test("renders a row per item across every column", () => {
    render(<DataTable caption="People" columns={COLUMNS} rows={ROWS} getRowKey={(r) => r.id} />);

    // Content renders twice by design — a phone card stack AND the desktop table
    // (CSS shows one per viewport). Scope row assertions to the semantic table.
    const table = within(screen.getByRole("table"));
    expect(table.getByText("alice")).toBeInTheDocument();
    expect(table.getByText("bob")).toBeInTheDocument();
    expect(table.getByText("3")).toBeInTheDocument();
    expect(table.getByText("7")).toBeInTheDocument();
    // Two data rows, no ghost empty row (cards are <li>, never role=row).
    expect(screen.getAllByRole("row")).toHaveLength(ROWS.length + 1); // + header row
  });

  test("exposes an sr-only caption and scope=col on every header", () => {
    const { container } = render(
      <DataTable caption="People roster" columns={COLUMNS} rows={ROWS} getRowKey={(r) => r.id} />,
    );

    const caption = container.querySelector("caption");
    expect(caption).not.toBeNull();
    expect(caption).toHaveTextContent("People roster");
    expect(caption).toHaveClass("sr-only");

    const headers = Array.from(container.querySelectorAll("th"));
    expect(headers).toHaveLength(COLUMNS.length);
    for (const th of headers) {
      expect(th).toHaveAttribute("scope", "col");
    }
  });

  test("right-aligned numeric cells render tabular-nums", () => {
    const { container } = render(
      <DataTable caption="People" columns={COLUMNS} rows={ROWS} getRowKey={(r) => r.id} />,
    );
    const numericCell = within(screen.getByRole("table")).getByText("7").closest("td");
    expect(numericCell).toHaveClass("tabular-nums");
    expect(container).toBeTruthy();
  });

  test("renders the empty node instead of a header shell when there are no rows", () => {
    const { container } = render(
      <DataTable
        caption="People"
        columns={COLUMNS}
        rows={[]}
        getRowKey={(r) => r.id}
        empty={<span>No people yet.</span>}
      />,
    );

    expect(screen.getByText("No people yet.")).toBeInTheDocument();
    // No lonely header/table is rendered in the empty state.
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("th")).toBeNull();
  });

  test("falls back to a muted 'No data' when no empty node is supplied", () => {
    render(<DataTable caption="People" columns={COLUMNS} rows={[]} getRowKey={(r) => r.id} />);
    expect(screen.getByText("No data")).toBeInTheDocument();
  });
});

describe("Pill", () => {
  test("renders its children with tone-paired colour classes", () => {
    render(<Pill tone="good">Active</Pill>);
    const pill = screen.getByText("Active");
    expect(pill).toBeInTheDocument();
    // Colour is paired with text; the emerald tone class is applied.
    expect(pill.className).toContain("text-emerald-600");
  });

  test("renders an optional leading icon", () => {
    const Icon = () => <svg data-testid="pill-icon" />;
    render(
      <Pill tone="info" icon={Icon}>
        Info
      </Pill>,
    );
    expect(screen.getByTestId("pill-icon")).toBeInTheDocument();
    expect(screen.getByText("Info")).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  test("renders the title, body and action", () => {
    render(
      <EmptyState
        title="Nothing here yet."
        body="Add your first item."
        action={<button type="button">Add item</button>}
      />,
    );
    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
    expect(screen.getByText("Add your first item.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add item" })).toBeInTheDocument();
  });
});
