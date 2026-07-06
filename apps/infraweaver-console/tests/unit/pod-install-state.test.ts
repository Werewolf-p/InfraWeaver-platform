import { isPodInstalling } from "@/lib/pod-install-state";

describe("isPodInstalling", () => {
  it("returns true while an init container is running and not ready", () => {
    expect(
      isPodInstalling({
        status: { initContainerStatuses: [{ name: "installer", ready: false, state: { running: { startedAt: new Date() } } }] },
      } as never),
    ).toBe(true);
  });

  it("returns false once the init container has terminated ready", () => {
    expect(
      isPodInstalling({
        status: { initContainerStatuses: [{ name: "installer", ready: true, state: { terminated: { exitCode: 0 } } }] },
      } as never),
    ).toBe(false);
  });

  it("returns false for a running game container with no init containers", () => {
    expect(isPodInstalling({ status: { containerStatuses: [{ name: "game", ready: true, state: { running: {} } }] } } as never)).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isPodInstalling(null)).toBe(false);
    expect(isPodInstalling(undefined)).toBe(false);
  });
});
