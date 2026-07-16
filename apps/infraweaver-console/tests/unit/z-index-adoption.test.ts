import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// Guards Subject 6 ADOPTION: the z-index token scale must remain the single
// source of truth. No component may reintroduce an ad-hoc `z-[NNN]` arbitrary
// value or an untokenised `z-50` overlay tie — every stacking layer flows
// through the `--z-*` `@utility` classes (z-overlay/z-modal/z-popover/…).

const SRC = join(__dirname, "..", "..", "src");
const GLOBALS_CSS = join(SRC, "app", "globals.css");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("z-index token adoption", () => {
  const files = walk(SRC);

  it("defines the full z-index token scale in globals.css", () => {
    const css = readFileSync(GLOBALS_CSS, "utf8");
    for (const token of [
      "--z-nav", "--z-drawer-backdrop", "--z-drawer",
      "--z-overlay", "--z-modal", "--z-popover", "--z-toast", "--z-tooltip", "--z-max",
    ]) {
      expect(css).toContain(token);
    }
    // Ergonomic utilities exist for the layers components consume.
    for (const util of ["@utility z-overlay", "@utility z-modal", "@utility z-popover"]) {
      expect(css).toContain(util);
    }
  });

  it("has no remaining arbitrary z-[NNN] utilities in any component", () => {
    const offenders = files.filter((f) => /\bz-\[/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.replace(SRC, "src"))).toEqual([]);
  });

  it("has no untokenised z-50 stacking ties", () => {
    const offenders = files.filter((f) => /\bz-50\b/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.replace(SRC, "src"))).toEqual([]);
  });

  it("routes the shared modal/sheet primitives through overlay+modal tokens", () => {
    const primitives = {
      "components/ui/responsive-sheet.tsx": ["z-overlay", "z-modal"],
      "components/ui/bottom-sheet.tsx": ["z-overlay", "z-modal"],
      "components/ui/confirm-dialog.tsx": ["z-overlay", "z-modal"],
    };
    for (const [rel, classes] of Object.entries(primitives)) {
      const text = readFileSync(join(SRC, rel), "utf8");
      for (const cls of classes) expect(text).toContain(cls);
    }
  });

  it("adopts useDialogA11y in the hand-rolled framer overlays", () => {
    for (const rel of ["components/ui/responsive-sheet.tsx", "components/ui/bottom-sheet.tsx"]) {
      expect(readFileSync(join(SRC, rel), "utf8")).toContain("useDialogA11y");
    }
  });

  it("dropped the dead mobile-nav component and its barrel export", () => {
    const barrel = readFileSync(join(SRC, "components", "ui", "index.ts"), "utf8");
    expect(barrel).not.toContain("mobile-nav");
    expect(files.some((f) => f.endsWith(join("ui", "mobile-nav.tsx")))).toBe(false);
  });
});
