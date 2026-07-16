import { deriveCategory, deriveSeverity, deriveTarget } from "@/lib/audit/derive";

describe("deriveCategory", () => {
  it("maps an rbac action to the rbac category", () => {
    // Arrange
    const action = "rbac:assign:denied";

    // Act
    const category = deriveCategory(action);

    // Assert
    expect(category).toBe("rbac");
  });

  it("maps a user offboard to the user category", () => {
    expect(deriveCategory("user:offboard")).toBe("user");
  });

  it("prefers the secret category when an app action reveals a credential", () => {
    // Arrange — jellyfin (app) + credential (secret): security concern wins.
    const action = "jellyfin:credential:reveal";

    // Act
    const category = deriveCategory(action);

    // Assert
    expect(category).toBe("secret");
  });

  it("maps an auth action to the auth category", () => {
    expect(deriveCategory("auth:failed")).toBe("auth");
  });

  it("falls back to other for an unrecognized action", () => {
    expect(deriveCategory("wibble:frobnicate")).toBe("other");
  });
});

describe("deriveSeverity", () => {
  it("escalates destructive verbs to critical even on success", () => {
    // Arrange / Act
    const severity = deriveSeverity("user:offboard", "success");

    // Assert
    expect(severity).toBe("critical");
  });

  it("treats a credential reveal as critical", () => {
    expect(deriveSeverity("nextcloud:credential:reveal", "success")).toBe("critical");
  });

  it("ranks a denied assignment as warning", () => {
    expect(deriveSeverity("rbac:assign:denied", "success")).toBe("warning");
  });

  it("ranks a failed result as warning", () => {
    expect(deriveSeverity("auth:failed", "failure")).toBe("warning");
  });

  it("ranks a routine mutation as notice", () => {
    expect(deriveSeverity("rbac:assign", "success")).toBe("notice");
  });

  it("ranks an unremarkable success as info", () => {
    expect(deriveSeverity("profile:view", "success")).toBe("info");
  });
});

describe("deriveTarget", () => {
  it("prefers an explicit resource", () => {
    expect(deriveTarget("wordpress/blog", "changed something")).toBe("wordpress/blog");
  });

  it("extracts a key:value target from the detail when resource is absent", () => {
    // Arrange
    const detail = "offboarded username: koen@example.com from all apps";

    // Act
    const target = deriveTarget(undefined, detail);

    // Assert
    expect(target).toBe("koen@example.com");
  });

  it("returns undefined when nothing target-like is present", () => {
    expect(deriveTarget(undefined, "no structured target here")).toBeUndefined();
  });
});
