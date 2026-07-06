import {
  MAX_MAIN_CONTAINER_INSTALL_MS,
  isInitContainerInstalling,
  isMainContainerInstalling,
  isPodInstalling,
} from "@/lib/pod-install-state";

const NOW = new Date("2026-07-06T12:00:00Z").getTime();

/** A game-labelled pod whose single main container is mid first-boot install. */
function mainInstallPod(overrides: Record<string, unknown> = {}, startedMsAgo = 30_000) {
  return {
    metadata: { labels: { "infraweaver/game": "true" } },
    status: {
      containerStatuses: [
        {
          name: "game",
          ready: false,
          started: false,
          restartCount: 0,
          state: { running: { startedAt: new Date(NOW - startedMsAgo) } },
          ...overrides,
        },
      ],
    },
  } as never;
}

describe("isInitContainerInstalling", () => {
  it("returns true while an init container is running and not ready", () => {
    expect(
      isInitContainerInstalling({
        status: { initContainerStatuses: [{ name: "installer", ready: false, state: { running: { startedAt: new Date() } } }] },
      } as never),
    ).toBe(true);
  });

  it("returns false once the init container has terminated ready", () => {
    expect(
      isInitContainerInstalling({
        status: { initContainerStatuses: [{ name: "installer", ready: true, state: { terminated: { exitCode: 0 } } }] },
      } as never),
    ).toBe(false);
  });
});

describe("isPodInstalling (init container)", () => {
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

  it("returns false for a running game container with no init containers (no game marker)", () => {
    expect(isPodInstalling({ status: { containerStatuses: [{ name: "game", ready: true, state: { running: {} } }] } } as never)).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isPodInstalling(null)).toBe(false);
    expect(isPodInstalling(undefined)).toBe(false);
  });
});

describe("isMainContainerInstalling (no init container)", () => {
  it("returns true for a game pod whose main container is running, not-ready, first boot", () => {
    expect(isMainContainerInstalling(mainInstallPod(), NOW)).toBe(true);
    expect(isPodInstalling(mainInstallPod(), NOW)).toBe(true);
  });

  it("returns false when the pod carries no game marker label", () => {
    const pod = mainInstallPod();
    pod.metadata.labels = {}; // strip the game marker
    expect(isMainContainerInstalling(pod, NOW)).toBe(false);
    expect(isPodInstalling(pod, NOW)).toBe(false);
  });

  it("accepts the infraweaver.io/game marker variant", () => {
    const pod = mainInstallPod();
    pod.metadata.labels = { "infraweaver.io/game": "true" };
    expect(isMainContainerInstalling(pod, NOW)).toBe(true);
  });

  it("returns false once the main container is ready", () => {
    expect(isMainContainerInstalling(mainInstallPod({ ready: true }), NOW)).toBe(false);
  });

  it("returns false once the startup probe has passed (started === true)", () => {
    expect(isMainContainerInstalling(mainInstallPod({ started: true }), NOW)).toBe(false);
  });

  it("returns false for a crash-restarted container (restartCount > 0)", () => {
    expect(isMainContainerInstalling(mainInstallPod({ restartCount: 2 }), NOW)).toBe(false);
  });

  it("returns false when the container has a prior terminated state (not first boot)", () => {
    expect(
      isMainContainerInstalling(mainInstallPod({ lastState: { terminated: { exitCode: 1 } } }), NOW),
    ).toBe(false);
  });

  it("returns false for a container waiting in CrashLoopBackOff (not running)", () => {
    expect(
      isMainContainerInstalling(
        mainInstallPod({ state: { waiting: { reason: "CrashLoopBackOff" } }, restartCount: 5 }),
        NOW,
      ),
    ).toBe(false);
  });

  it("returns false once the install window is exceeded (stuck pod, not installing)", () => {
    const stuck = mainInstallPod({}, MAX_MAIN_CONTAINER_INSTALL_MS + 60_000);
    expect(isMainContainerInstalling(stuck, NOW)).toBe(false);
    expect(isPodInstalling(stuck, NOW)).toBe(false);
  });

  it("still returns true just inside the install window", () => {
    const fresh = mainInstallPod({}, MAX_MAIN_CONTAINER_INSTALL_MS - 60_000);
    expect(isMainContainerInstalling(fresh, NOW)).toBe(true);
  });

  it("returns false when an init container is still running (init-install case owns that state)", () => {
    const pod = mainInstallPod();
    pod.status.initContainerStatuses = [{ name: "installer", ready: false, state: { running: { startedAt: new Date(NOW) } } }];
    expect(isMainContainerInstalling(pod, NOW)).toBe(false);
    // isPodInstalling is still true via the init-container branch.
    expect(isPodInstalling(pod, NOW)).toBe(true);
  });

  it("returns false for null/undefined", () => {
    expect(isMainContainerInstalling(null, NOW)).toBe(false);
    expect(isMainContainerInstalling(undefined, NOW)).toBe(false);
  });
});
