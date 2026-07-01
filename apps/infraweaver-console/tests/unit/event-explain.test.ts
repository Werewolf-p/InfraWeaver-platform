import { explainEvent, severityFor, isNoiseEvent } from "@/addons/gamehub/lib/event-explain";

// The deploy wizard's installation console and the server-detail activity tab
// both translate raw Kubernetes events through this module. A normal deploy
// must NOT read as a failure: the unbound-PVC scheduling retry is pure churn
// while storage comes online, and other transient warnings should be
// informational rather than alarming red lines.
describe("isNoiseEvent", () => {
  it("hides the unbound-PVC scheduling retry that floods a normal deploy", () => {
    expect(
      isNoiseEvent("FailedScheduling", "0/3 nodes are available: pod has unbound immediate PersistentVolumeClaims. not found"),
    ).toBe(true);
  });

  it("keeps a genuine scheduling failure that is not about storage", () => {
    expect(isNoiseEvent("FailedScheduling", "0/3 nodes are available: insufficient memory")).toBe(false);
  });

  it("keeps ordinary lifecycle events", () => {
    expect(isNoiseEvent("Pulled", "Container image already present on machine")).toBe(false);
    expect(isNoiseEvent("Started", "Container started")).toBe(false);
  });
});

describe("severityFor", () => {
  it("treats transient scheduling/probe warnings as info, not warning", () => {
    expect(severityFor({ type: "Warning", reason: "FailedScheduling", message: "insufficient memory" })).toBe("info");
    expect(severityFor({ type: "Warning", reason: "Unhealthy", message: "readiness probe failed" })).toBe("info");
  });

  it("keeps real warnings as warnings", () => {
    expect(severityFor({ type: "Warning", reason: "BackOff", message: "Back-off restarting failed container" })).toBe("warning");
    expect(severityFor({ type: "Warning", reason: "Failed", message: "Error: ImagePullBackOff" })).toBe("warning");
  });

  it("treats Normal events as info", () => {
    expect(severityFor({ type: "Normal", reason: "Scheduled", message: "assigned to node" })).toBe("info");
  });
});

describe("explainEvent", () => {
  it("explains the unbound-PVC wait in plain language", () => {
    const text = explainEvent("FailedScheduling", "pod has unbound immediate PersistentVolumeClaims");
    expect(text).toMatch(/storage volume/i);
    expect(text).not.toMatch(/PersistentVolumeClaim/); // no raw k8s jargon
  });

  it("maps known lifecycle reasons to friendly copy", () => {
    expect(explainEvent("Pulling", "")).toMatch(/Downloading/i);
    expect(explainEvent("Scheduled", "")).toMatch(/assigned to a node/i);
    expect(explainEvent("SuccessfulAttachVolume", "")).toMatch(/attached successfully/i);
  });

  it("falls back to the raw message for unknown reasons", () => {
    expect(explainEvent("SomethingNew", "detailed message")).toBe("detailed message");
  });
});
