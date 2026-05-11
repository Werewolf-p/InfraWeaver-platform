import React from "react";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "@/components/ui/status-badge";

describe("StatusBadge", () => {
  it("renders healthy status", () => {
    render(<StatusBadge status="healthy" />);
    expect(screen.getByText(/healthy/i)).toBeInTheDocument();
  });

  it("renders degraded status", () => {
    render(<StatusBadge status="degraded" />);
    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
  });
});
