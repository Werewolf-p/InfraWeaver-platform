import { buildEggConfigMap, sanitizeLabelValue, type GameEgg } from "@/lib/game-eggs";

// The Kubernetes label value grammar: (([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?
// Pelican catalog egg IDs are path-derived and can contain '/', '[', ']' which
// the API server rejects. Regression for the 422 seen deploying "tmodloader":
//   ConfigMap "gameserver-tmodloader-egg" rejected — metadata.labels has an
//   invalid value `minecraft[path]`.
const K8S_LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;

function makeEgg(id: string): GameEgg {
  return {
    id,
    name: "Test Egg",
    description: "",
    dockerImage: "ghcr.io/example/image:latest",
    startupCommand: "",
    stopCommand: "^C",
    gamePort: 25565,
    mountPath: "/data",
    environment: [],
    quickCommands: [],
    protocol: "TCP",
  } as GameEgg;
}

describe("sanitizeLabelValue", () => {
  it("strips bracket characters that yield an invalid k8s label value", () => {
    // Arrange
    const raw = "minecraft[path]";

    // Act
    const sanitized = sanitizeLabelValue(raw);

    // Assert
    expect(sanitized).toMatch(K8S_LABEL_VALUE);
    expect(sanitized).not.toContain("[");
    expect(sanitized).not.toContain("]");
  });

  it("replaces path separators and collapses hyphens", () => {
    expect(sanitizeLabelValue("game_eggs/minecraft/java/vanilla")).toMatch(K8S_LABEL_VALUE);
    expect(sanitizeLabelValue("a//b")).toBe("a-b");
  });

  it("truncates to 63 characters", () => {
    const sanitized = sanitizeLabelValue("x".repeat(200));
    expect(sanitized.length).toBe(63);
  });

  it("strips leading/trailing non-alphanumerics", () => {
    expect(sanitizeLabelValue("[minecraft]")).toBe("minecraft");
    expect(sanitizeLabelValue("---")).toBe("unknown");
  });

  it("falls back to 'unknown' when nothing survives", () => {
    expect(sanitizeLabelValue("[]")).toBe("unknown");
  });

  it("leaves already-valid values intact", () => {
    expect(sanitizeLabelValue("tmodloader")).toBe("tmodloader");
  });
});

describe("buildEggConfigMap", () => {
  it("produces a valid game-type label even when egg.id contains brackets", () => {
    // Arrange
    const egg = makeEgg("minecraft[path]");

    // Act
    const cm = buildEggConfigMap("game-hub", "tmodloader", egg) as {
      metadata: {
        name: string;
        labels: Record<string, string>;
        annotations: Record<string, string>;
      };
    };

    // Assert
    expect(cm.metadata.name).toBe("gameserver-tmodloader-egg");
    expect(cm.metadata.labels["infraweaver.io/game-type"]).toMatch(K8S_LABEL_VALUE);
    // The unmodified id is preserved in an annotation (no charset restrictions).
    expect(cm.metadata.annotations["infraweaver.io/egg-id"]).toBe("minecraft[path]");
  });

  it("keeps every metadata.labels value within the k8s grammar", () => {
    const cm = buildEggConfigMap("game-hub", "tmodloader", makeEgg("a/b[c]")) as {
      metadata: { labels: Record<string, string> };
    };
    for (const value of Object.values(cm.metadata.labels)) {
      expect(value).toMatch(K8S_LABEL_VALUE);
    }
  });
});
