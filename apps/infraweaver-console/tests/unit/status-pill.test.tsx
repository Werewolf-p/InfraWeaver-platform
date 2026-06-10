import React from "react";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "@/components/feedback/status-pill";

describe("StatusPill", () => {
  it("shows 'Ready to test' for a dispatched entry whose staging preview is live", () => {
    render(<StatusPill status="dispatched" previewUrl="https://preview.example.com" />);
    expect(screen.getByText("Ready to test")).toBeInTheDocument();
  });

  it("shows 'Building on staging…' for a dispatched entry whose build hasn't landed", () => {
    render(<StatusPill status="dispatched" />);
    expect(screen.getByText("Building on staging…")).toBeInTheDocument();
    expect(screen.queryByText("Ready to test")).not.toBeInTheDocument();
  });

  it("uses the plain-language label for non-dispatched statuses", () => {
    render(<StatusPill status="new" />);
    expect(screen.getByText("Awaiting review")).toBeInTheDocument();
  });
});
