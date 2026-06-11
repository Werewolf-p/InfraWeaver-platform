import React from "react";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "@/components/feedback/status-pill";

describe("StatusPill", () => {
  it("shows 'Ready to test' for a dispatched entry whose staging preview is live", () => {
    render(<StatusPill status="dispatched" previewUrl="https://preview.example.com" />);
    expect(screen.getByText("Ready to test")).toBeInTheDocument();
  });

  it("shows 'Ready to test' for a dispatched entry even without a preview URL", () => {
    // A `dispatched` entry is already built AND deployed to the live console, so
    // it always reads "Ready to test" — the previewUrl prop is deprecated/ignored.
    render(<StatusPill status="dispatched" />);
    expect(screen.getByText("Ready to test")).toBeInTheDocument();
    expect(screen.queryByText("Building on staging…")).not.toBeInTheDocument();
  });

  it("uses the plain-language label for non-dispatched statuses", () => {
    render(<StatusPill status="new" />);
    expect(screen.getByText("Awaiting review")).toBeInTheDocument();
  });
});
