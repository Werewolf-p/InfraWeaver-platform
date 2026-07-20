import { activePluginSlugs } from "@/addons/wordpress-manager/lib/manage/wp-probe";
import { resolveCapabilities } from "@/addons/wordpress-manager/lib/manage/capabilities";

/**
 * Regression guard for the capability-gate 409 bug: `wp plugin list --field=name
 * --format=json` emits a SCALAR array (`["slug", ...]`), which the old parser read
 * as objects (`fieldStr(row,"name")`) and silently blanked — failing every
 * plugin-gated Manage panel on real sites. `activePluginSlugs` must read the
 * scalar shape.
 */
describe("activePluginSlugs", () => {
  test("parses the real wp-cli scalar array shape", () => {
    // This is exactly what `--field=name --format=json` prints.
    const stdout = '["akismet","wp-mail-smtp","updraftplus"]';
    const slugs = activePluginSlugs(stdout);
    expect(slugs.has("akismet")).toBe(true);
    expect(slugs.has("wp-mail-smtp")).toBe(true);
    expect(slugs.has("updraftplus")).toBe(true);
    expect(slugs.size).toBe(3);
  });

  test("tolerates the object array shape too (format-change resilience)", () => {
    const stdout = '[{"name":"woocommerce"},{"name":"wpforms-lite"}]';
    const slugs = activePluginSlugs(stdout);
    expect(slugs.has("woocommerce")).toBe(true);
    expect(slugs.has("wpforms-lite")).toBe(true);
  });

  test("lowercases slugs and ignores blank/non-string rows", () => {
    const stdout = '["WP-Mail-SMTP","",null,42,{"name":"UpdraftPlus"}]';
    const slugs = activePluginSlugs(stdout);
    expect(slugs.has("wp-mail-smtp")).toBe(true);
    expect(slugs.has("updraftplus")).toBe(true);
    expect(slugs.has("")).toBe(false);
    expect(slugs.size).toBe(2);
  });

  test("survives a leading wp-cli Warning/Success line before the JSON", () => {
    const stdout = 'Warning: Some plugins could not be loaded.\n["post-smtp"]';
    expect(activePluginSlugs(stdout).has("post-smtp")).toBe(true);
  });

  test("empty / unparseable output yields an empty set", () => {
    expect(activePluginSlugs("[]").size).toBe(0);
    expect(activePluginSlugs("").size).toBe(0);
    expect(activePluginSlugs("Success: No plugins installed.").size).toBe(0);
    expect(activePluginSlugs("not json at all").size).toBe(0);
  });
});

describe("scalar-array slugs light the capability gate (409 bug)", () => {
  test("an SMTP plugin from the scalar array satisfies the smtp capability", () => {
    const slugs = activePluginSlugs('["wp-mail-smtp"]');
    const caps = resolveCapabilities({ activePlugins: slugs, connectorActive: false });
    expect(caps.smtp).toBe(true);
  });

  test("a backup plugin from the scalar array satisfies the backups capability", () => {
    const slugs = activePluginSlugs('["updraftplus"]');
    const caps = resolveCapabilities({ activePlugins: slugs, connectorActive: false });
    expect(caps.backups).toBe(true);
  });

  test("a bare site (empty scalar array) grants no plugin capability", () => {
    const caps = resolveCapabilities({ activePlugins: activePluginSlugs("[]"), connectorActive: false });
    expect(caps.smtp).toBe(false);
    expect(caps.backups).toBe(false);
    expect(caps.woocommerce).toBe(false);
  });
});
