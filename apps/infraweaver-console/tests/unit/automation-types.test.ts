import { describe, expect, it } from "@jest/globals";
import {
  makeEmptyStep,
  normalizeStep,
  validatePipeline,
  type AutomationCatalog,
  type Pipeline,
} from "@/lib/feedback-automation-types";

const CATALOG: AutomationCatalog = {
  agents: ["claude", "copilot"],
  tools: ["Read", "Edit", "Grep", "Glob", "Bash"],
  models: ["", "claude-opus-4-8"],
  mcp: ["context7", "github"],
};

function pipeline(steps: Pipeline["steps"]): Pipeline {
  return { version: 1, steps };
}

describe("makeEmptyStep", () => {
  it("creates an enabled step with a unique default id", () => {
    const step = makeEmptyStep(2);
    expect(step.id).toBe("step-3");
    expect(step.enabled).toBe(true);
    expect(step.agent).toBe("claude");
    expect(step.promptTemplate).toBe("");
  });
});

describe("normalizeStep", () => {
  it("drops tools and mcp servers not present in the catalog", () => {
    const step = normalizeStep(
      { allowedTools: ["Read", "Rm", "Bash"], mcpServers: ["github", "evil"] },
      0,
      CATALOG,
    );
    expect(step.allowedTools).toEqual(["Read", "Bash"]);
    expect(step.mcpServers).toEqual(["github"]);
  });

  it("sanitizes the id and clamps the name", () => {
    const step = normalizeStep({ id: "bad id!@#", name: "x".repeat(80) }, 0);
    expect(step.id).toBe("badid");
    expect(step.name).toHaveLength(60);
  });

  it("treats only explicit false as disabled", () => {
    expect(normalizeStep({}, 0).enabled).toBe(true);
    expect(normalizeStep({ enabled: false }, 0).enabled).toBe(false);
  });
});

describe("validatePipeline", () => {
  it("accepts a valid single-step pipeline", () => {
    expect(validatePipeline(pipeline([{ ...makeEmptyStep(0), promptTemplate: "do it" }]))).toBeNull();
  });

  it("requires at least one enabled step", () => {
    const step = { ...makeEmptyStep(0), enabled: false, promptTemplate: "x" };
    expect(validatePipeline(pipeline([step]))).toBe("Enable at least one step before saving");
  });

  it("requires every enabled step to have a prompt", () => {
    const step = { ...makeEmptyStep(0), promptTemplate: "   " };
    expect(validatePipeline(pipeline([step]))).toBe("Every step needs a prompt");
  });

  it("rejects an empty pipeline", () => {
    expect(validatePipeline(pipeline([]))).toMatch(/between 1 and/);
  });
});
