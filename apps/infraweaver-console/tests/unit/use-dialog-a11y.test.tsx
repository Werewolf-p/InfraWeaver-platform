import React, { useRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { useDialogA11y } from "@/hooks/use-dialog-a11y";

interface HarnessProps {
  open: boolean;
  onClose: () => void;
  closeOnEscape?: boolean;
}

function Harness({ open, onClose, closeOnEscape }: HarnessProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogA11y({ open, onClose, ref, closeOnEscape });
  return (
    <div>
      <button data-testid="opener">Opener</button>
      {open && (
        <div ref={ref} role="dialog" data-testid="dialog">
          <button data-testid="first">First</button>
          <button data-testid="last">Last</button>
        </div>
      )}
    </div>
  );
}

describe("useDialogA11y", () => {
  it("calls onClose when Escape is pressed", () => {
    // Arrange
    const onClose = jest.fn();
    render(<Harness open onClose={onClose} />);

    // Act
    fireEvent.keyDown(document, { key: "Escape" });

    // Assert
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on Escape when closeOnEscape is false", () => {
    // Arrange
    const onClose = jest.fn();
    render(<Harness open onClose={onClose} closeOnEscape={false} />);

    // Act
    fireEvent.keyDown(document, { key: "Escape" });

    // Assert
    expect(onClose).not.toHaveBeenCalled();
  });

  it("locks body scroll while open and restores it on close", () => {
    // Arrange
    document.body.style.overflow = "auto";
    const { rerender } = render(<Harness open onClose={jest.fn()} />);

    // Assert (locked)
    expect(document.body.style.overflow).toBe("hidden");

    // Act (close)
    rerender(<Harness open={false} onClose={jest.fn()} />);

    // Assert (restored)
    expect(document.body.style.overflow).toBe("auto");
  });

  it("moves focus into the dialog on open", () => {
    // Arrange / Act
    render(<Harness open onClose={jest.fn()} />);

    // Assert
    expect(screen.getByTestId("first")).toHaveFocus();
  });

  it("wraps focus from the last focusable back to the first on Tab (trap)", () => {
    // Arrange
    render(<Harness open onClose={jest.fn()} />);
    screen.getByTestId("last").focus();

    // Act
    fireEvent.keyDown(document, { key: "Tab" });

    // Assert
    expect(screen.getByTestId("first")).toHaveFocus();
  });

  it("wraps focus from the first focusable to the last on Shift+Tab (trap)", () => {
    // Arrange
    render(<Harness open onClose={jest.fn()} />);
    screen.getByTestId("first").focus();

    // Act
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

    // Assert
    expect(screen.getByTestId("last")).toHaveFocus();
  });

  it("restores focus to the opener when the dialog closes", () => {
    // Arrange
    const { rerender } = render(<Harness open={false} onClose={jest.fn()} />);
    const opener = screen.getByTestId("opener");
    opener.focus();
    expect(opener).toHaveFocus();

    // Act (open then close)
    rerender(<Harness open onClose={jest.fn()} />);
    rerender(<Harness open={false} onClose={jest.fn()} />);

    // Assert
    expect(opener).toHaveFocus();
  });
});
