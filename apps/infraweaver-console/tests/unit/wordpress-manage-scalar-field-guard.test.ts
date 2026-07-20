import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonArray, fieldStr, fieldNum, activePluginSlugs } from "@/addons/wordpress-manager/lib/manage/wp-probe";

/**
 * Regression guard for the capability-gate 409 bug (fixed 2026-07-20).
 *
 * wp-cli's SINGULAR `--field=<x> --format=json` prints a *scalar* JSON array —
 * `["akismet","woocommerce"]`, bare strings, not objects. Reading such a row with
 * an object accessor (`fieldStr(row,"name")`) yields `null` for every row and
 * silently blanks the result. When that result is the active-plugin set, every
 * plugin-gated Manage panel then 409s. The fix routes the one such command through
 * the scalar-aware `activePluginSlugs`.
 *
 * This test stops the footgun from creeping back in two ways:
 *   1. A source lint: the ONLY singular-`--field=…--format=json` command allowed in
 *      the Manage probe layer is the sanctioned active-plugins read, and it must be
 *      parsed by `activePluginSlugs`. Any new singular-field JSON command fails here
 *      until its author uses a scalar-aware parser and extends the allow-list.
 *   2. Behavioural proof that the object accessors DO blank on a scalar row, so the
 *      "why" is pinned down and can't be argued away.
 *
 * The correct object-shaped read uses the PLURAL flag (`--fields=name,status`),
 * which prints `[{name,status}, …]`; that is explicitly not matched here.
 */

const MANAGE_DIR = join(__dirname, "../../src/addons/wordpress-manager/lib/manage");

/** Matches a singular `--field=<name>` but NOT the plural `--fields=` (which is object-shaped). */
const SINGULAR_FIELD_RE = /(?<![a-z])--field=([A-Za-z0-9_]+)/;
/** The single sanctioned scalar-array command in the Manage layer. */
const SANCTIONED_RE = /plugin list --status=active --field=name --format=json/;

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every source line that issues a singular-field JSON read, with its file for reporting. */
function scalarFieldJsonLines(): Array<{ file: string; line: string }> {
  const hits: Array<{ file: string; line: string }> = [];
  for (const file of walkTsFiles(MANAGE_DIR)) {
    if (file.endsWith("wp-probe.ts")) continue; // helper file: only doc-comment mentions, no live command
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      if (SINGULAR_FIELD_RE.test(raw) && raw.includes("--format=json")) {
        hits.push({ file, line: raw.trim() });
      }
    }
  }
  return hits;
}

describe("Manage probe scalar-field lint", () => {
  test("every singular `--field=…--format=json` read is the sanctioned active-plugins command", () => {
    const offenders = scalarFieldJsonLines().filter(({ line }) => !SANCTIONED_RE.test(line));
    // A non-empty list means someone added a scalar-array wp-cli read. Route its
    // output through a scalar-aware parser (see `activePluginSlugs`) — NEVER through
    // `parseJsonArray` + `fieldStr`/`fieldNum` — then add it to SANCTIONED_RE.
    expect(offenders).toEqual([]);
  });

  test("the walker actually sees the known scalar reads (guard can't pass by scanning nothing)", () => {
    const lines = scalarFieldJsonLines();
    // Known live sites at the time of writing: performance, backups, audience, audit,
    // forms, email, panel-data. If the glob silently breaks, this trips.
    expect(lines.length).toBeGreaterThanOrEqual(7);
    expect(lines.every(({ line }) => SANCTIONED_RE.test(line))).toBe(true);
  });

  test("every file issuing the sanctioned scalar command parses it with activePluginSlugs", () => {
    for (const file of walkTsFiles(MANAGE_DIR)) {
      if (file.endsWith("wp-probe.ts")) continue;
      const src = readFileSync(file, "utf8");
      if (SANCTIONED_RE.test(src)) {
        expect(src.includes("activePluginSlugs")).toBe(true);
      }
    }
  });
});

describe("object accessors blank on a scalar row (the footgun itself)", () => {
  test("parseJsonArray of a scalar `--field=name --format=json` array yields bare strings", () => {
    const rows = parseJsonArray('["akismet","woocommerce"]');
    expect(rows).toEqual(["akismet", "woocommerce"]);
    expect(typeof rows[0]).toBe("string");
  });

  test("fieldStr/fieldNum return null on a scalar (string) row — the silent blank we forbid", () => {
    const scalarRow = "akismet" as unknown as Record<string, unknown>;
    expect(fieldStr(scalarRow, "name")).toBeNull();
    expect(fieldNum(scalarRow, "count")).toBeNull();
  });

  test("the scalar-aware reader survives where the object accessor blanks", () => {
    const stdout = '["akismet","woocommerce"]';
    // Object accessor: total loss.
    const viaAccessor = parseJsonArray(stdout).map((r) => fieldStr(r as Record<string, unknown>, "name")).filter(Boolean);
    expect(viaAccessor).toEqual([]);
    // Scalar-aware: intact.
    expect(activePluginSlugs(stdout).size).toBe(2);
  });
});
