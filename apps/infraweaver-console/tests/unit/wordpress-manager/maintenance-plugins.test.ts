import {
  updateAllPluginsCommand,
  parsePluginUpdateResult,
} from "@/addons/wordpress-manager/lib/plugins";
import {
  MAINTENANCE_OPTION,
  MAINTENANCE_MU_PLUGIN_PATH,
  maintenancePluginContents,
  installMaintenancePluginCommand,
  setMaintenanceCommand,
  maintenanceStatusCommand,
  parseMaintenanceStatus,
} from "@/addons/wordpress-manager/lib/maintenance";

describe("bulk plugin updates", () => {
  test("updateAllPluginsCommand requests machine-readable JSON", () => {
    expect(updateAllPluginsCommand()).toBe("wp --allow-root plugin update --all --format=json");
  });

  test("parses wp-cli JSON into per-plugin results with camelCase versions", () => {
    const stdout = JSON.stringify([
      { name: "wordfence", old_version: "7.11.0", new_version: "7.11.5", status: "Updated" },
      { name: "wordpress-seo", old_version: "22.0", new_version: "22.1", status: "Updated" },
    ]);

    expect(parsePluginUpdateResult(stdout)).toEqual([
      { slug: "wordfence", oldVersion: "7.11.0", newVersion: "7.11.5", status: "Updated" },
      { slug: "wordpress-seo", oldVersion: "22.0", newVersion: "22.1", status: "Updated" },
    ]);
  });

  test("tolerates wp-cli log noise around the JSON payload", () => {
    const stdout = 'Enabling Maintenance mode...\n[{"name":"wordfence","old_version":"1.0","new_version":"1.1","status":"Updated"}]\nDisabling Maintenance mode...';
    const result = parsePluginUpdateResult(stdout);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ slug: "wordfence", status: "Updated" });
  });

  test("returns an empty list when nothing was updated (no JSON emitted)", () => {
    expect(parsePluginUpdateResult("Success: No plugins updated.")).toEqual([]);
    expect(parsePluginUpdateResult("")).toEqual([]);
    expect(parsePluginUpdateResult("[not-json]")).toEqual([]);
  });

  test("null fields degrade to null rather than throwing", () => {
    const stdout = JSON.stringify([{ name: "x", old_version: "", new_version: null, status: "Error" }]);
    expect(parsePluginUpdateResult(stdout)).toEqual([
      { slug: "x", oldVersion: null, newVersion: null, status: "Error" },
    ]);
  });
});

describe("maintenance mode", () => {
  test("status command reads the InfraWeaver option quietly", () => {
    expect(maintenanceStatusCommand()).toBe(`wp --allow-root option get ${MAINTENANCE_OPTION} 2>/dev/null`);
  });

  test("parses only an explicit truthy value as enabled", () => {
    expect(parseMaintenanceStatus("1\n")).toEqual({ enabled: true });
    expect(parseMaintenanceStatus("true")).toEqual({ enabled: true });
    expect(parseMaintenanceStatus("")).toEqual({ enabled: false });
    expect(parseMaintenanceStatus("0")).toEqual({ enabled: false });
    expect(parseMaintenanceStatus("Error: option not found")).toEqual({ enabled: false });
  });

  test("enable updates the autoloaded option; disable deletes it", () => {
    expect(setMaintenanceCommand(true)).toBe(`wp --allow-root option update ${MAINTENANCE_OPTION} 1 --autoload=yes`);
    expect(setMaintenanceCommand(false)).toBe(`wp --allow-root option delete ${MAINTENANCE_OPTION}`);
  });

  test("install command creates mu-plugins dir and writes the file from stdin", () => {
    const cmd = installMaintenancePluginCommand();
    expect(cmd).toContain("mkdir -p wp-content/mu-plugins");
    expect(cmd).toContain(`cat > ${MAINTENANCE_MU_PLUGIN_PATH}`);
  });

  test("mu-plugin gates the front end on the option and lets admins/wp-cli through", () => {
    const php = maintenancePluginContents();
    expect(php.startsWith("<?php")).toBe(true);
    expect(php).toContain(`get_option( '${MAINTENANCE_OPTION}' )`);
    expect(php).toContain("template_redirect");
    expect(php).toContain("current_user_can( 'manage_options' )");
    expect(php).toContain("WP_CLI");
    expect(php).toContain("'response' => 503");
  });
});
