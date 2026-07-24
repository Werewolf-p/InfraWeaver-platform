import React, { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SelectableDataTable } from "@/addons/wordpress-manager/components/manage/kit/select-table";
import type { Column } from "@/addons/wordpress-manager/components/demo/manage/kit/data-table";

interface Row {
  readonly id: string;
  readonly name: string;
}

const ROWS: readonly Row[] = [
  { id: "a", name: "Alice" },
  { id: "b", name: "Bob" },
  { id: "c", name: "Carol" },
];

const COLUMNS: Column<Row>[] = [{ key: "name", header: "Name", render: (r) => r.name }];

function Harness({ initial = new Set<string>() }: { initial?: Set<string> }) {
  const [sel, setSel] = useState<ReadonlySet<string>>(initial);
  return (
    <div>
      <span data-testid="count">{sel.size}</span>
      <SelectableDataTable
        caption="People"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(r) => r.id}
        selection={sel}
        onSelectionChange={setSel}
      />
    </div>
  );
}

/** Checkboxes scoped to the semantic desktop table (mobile cards omit the select column). */
function tableBoxes(): HTMLInputElement[] {
  return within(screen.getByRole("table")).getAllByRole("checkbox") as HTMLInputElement[];
}

const count = () => screen.getByTestId("count").textContent;

describe("SelectableDataTable", () => {
  test("renders a header checkbox plus one checkbox per row", () => {
    render(<Harness />);
    // header + 3 rows
    expect(tableBoxes()).toHaveLength(ROWS.length + 1);
  });

  test("clicking a row checkbox selects just that row", () => {
    render(<Harness />);
    const [, rowA] = tableBoxes();
    fireEvent.click(rowA);
    expect(count()).toBe("1");
  });

  test("the header checkbox selects all, then clears", () => {
    render(<Harness />);
    const [header] = tableBoxes();
    fireEvent.click(header);
    expect(count()).toBe(String(ROWS.length));
    fireEvent.click(tableBoxes()[0]);
    expect(count()).toBe("0");
  });

  test("the header checkbox is indeterminate for a partial selection", () => {
    render(<Harness initial={new Set(["a"])} />);
    const [header] = tableBoxes();
    expect(header.indeterminate).toBe(true);
    expect(header.checked).toBe(false);
  });

  test("shift-click selects the inclusive range between anchor and target", () => {
    render(<Harness />);
    const [, rowA, , rowC] = tableBoxes();
    fireEvent.click(rowA); // anchor = a
    fireEvent.click(rowC, { shiftKey: true }); // range a..c
    expect(count()).toBe("3");
  });
});
