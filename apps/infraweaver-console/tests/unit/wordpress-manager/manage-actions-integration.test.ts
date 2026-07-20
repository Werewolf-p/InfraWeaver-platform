/** @jest-environment node */
// INTEGRATION coverage for runManageAction — the real runner, end to end, for EVERY
// interactive Manage action. Live click-through against a site needs a cluster (which
// is unreachable in CI/this session), so the in-pod exec, provisioning, mailer, and
// cache layers are mocked; what is exercised for real is the runner itself: guardrail
// reads -> command build -> exec -> post-mutation cache invalidation. The point is to
// PROVE, executably, that each control does real backend work (nothing is a dummy /
// no-op) and that every state change triggers the fresh-read fix so the UI reflects it.
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/addons/wordpress-manager/lib/provision", () => ({
  siteExists: jest.fn(),
  syncSiteWpUsers: jest.fn(),
  setMaintenanceMode: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/k8s-exec", () => ({ execInWpPod: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/overview", () => ({ requireRunningWpPod: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/snapshot-cache", () => ({ invalidateManageCache: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/invalidate", () => ({ invalidateManageReadsAfterMutation: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed-commands", () => ({ CONNECTOR_PLUGIN_SLUG: "infraweaver-connector" }));
jest.mock("@/lib/mailer", () => ({ sendWpPasswordResetEmail: jest.fn(), isMailerConfigured: jest.fn(() => true) }));

import { runManageAction, type ManageAction } from "@/addons/wordpress-manager/lib/manage/actions";
import { siteExists, syncSiteWpUsers, setMaintenanceMode } from "@/addons/wordpress-manager/lib/provision";
import { execInWpPod } from "@/addons/wordpress-manager/lib/k8s-exec";
import { requireRunningWpPod } from "@/addons/wordpress-manager/lib/manage/overview";
import { invalidateManageCache } from "@/addons/wordpress-manager/lib/manage/snapshot-cache";
import { invalidateManageReadsAfterMutation } from "@/addons/wordpress-manager/lib/manage/invalidate";
import { sendWpPasswordResetEmail } from "@/lib/mailer";

const existsMock = siteExists as jest.MockedFunction<typeof siteExists>;
const syncMock = syncSiteWpUsers as jest.MockedFunction<typeof syncSiteWpUsers>;
const maintMock = setMaintenanceMode as jest.MockedFunction<typeof setMaintenanceMode>;
const execMock = execInWpPod as jest.MockedFunction<typeof execInWpPod>;
const podMock = requireRunningWpPod as jest.MockedFunction<typeof requireRunningWpPod>;
const memMock = invalidateManageCache as jest.MockedFunction<typeof invalidateManageCache>;
const durableMock = invalidateManageReadsAfterMutation as jest.MockedFunction<typeof invalidateManageReadsAfterMutation>;
const mailMock = sendWpPasswordResetEmail as jest.MockedFunction<typeof sendWpPasswordResetEmail>;

/** Smart exec mock: answers the runner's guardrail READS so mutations proceed, and
 *  returns the reset-link eval blob; every other command resolves empty. */
function wireExec(): void {
  // execInWpPod is called as (pod, script, opts) — the SCRIPT is the 2nd arg.
  execMock.mockImplementation(async (_pod: unknown, script: string) => {
    if (script.includes("user list --role=administrator")) return { stdout: '[{"ID":1},{"ID":2}]', stderr: "" };
    if (script.includes("theme list --status=active")) return { stdout: '[{"name":"twentytwentyfour"}]', stderr: "" };
    if (script.includes("user get") && script.includes("--field=ID")) return { stdout: "999", stderr: "" };
    if (script.includes("eval")) {
      return {
        stdout: JSON.stringify({
          email: "user@example.com",
          name: "User",
          reset_url: "https://blog.example.com/wp-login.php?action=rp&key=k&login=user",
          site_name: "Blog",
          site_url: "https://blog.example.com/",
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  existsMock.mockResolvedValue(true);
  podMock.mockResolvedValue({ name: "wp-abc", namespace: "wordpress" } as never);
  syncMock.mockResolvedValue({ actions: [], failed: [] } as never);
  maintMock.mockResolvedValue(undefined as never);
  durableMock.mockResolvedValue(undefined);
  wireExec();
});

/** The exec command string that carried out the mutation (the LAST exec call — guardrail
 *  reads run first). Empty when the action didn't touch the exec path. */
function lastExecCommand(): string {
  const calls = execMock.mock.calls;
  return calls.length ? String(calls[calls.length - 1][1]) : "";
}

// Every interactive action, with a substring that must appear in the real command it runs.
// This is the executable "is it actually wired / not a dummy" assertion — the control
// reaches a concrete wp-cli mutation (or the vetted provision/mailer path).
const EXEC_ACTIONS: ReadonlyArray<{ action: ManageAction; contains: string }> = [
  { action: { type: "update-core" }, contains: "core update" },
  { action: { type: "update-all" }, contains: "update" },
  { action: { type: "update-plugin", slug: "akismet" }, contains: "plugin update akismet" },
  { action: { type: "update-theme", slug: "twentytwentyfour" }, contains: "theme update twentytwentyfour" },
  { action: { type: "install-plugin", slug: "wordpress-seo" }, contains: "plugin install wordpress-seo" },
  { action: { type: "activate-plugin", slug: "akismet" }, contains: "plugin activate akismet" },
  { action: { type: "deactivate-plugin", slug: "akismet" }, contains: "plugin deactivate akismet" },
  { action: { type: "delete-plugin", slug: "hello" }, contains: "plugin delete hello" },
  { action: { type: "activate-theme", slug: "twentytwentyone" }, contains: "theme activate twentytwentyone" },
  { action: { type: "delete-theme", slug: "twentytwentyone" }, contains: "theme delete twentytwentyone" },
  { action: { type: "optimize-db" }, contains: "db optimize" },
  { action: { type: "purge-transients" }, contains: "transient delete --all" },
  { action: { type: "flush-cache" }, contains: "cache flush" },
  { action: { type: "flush-rewrites" }, contains: "rewrite flush" },
  { action: { type: "add-user", login: "jane", email: "jane@example.com", role: "editor" }, contains: "user create jane" },
  { action: { type: "update-user-email", userId: 3, email: "new@example.com" }, contains: "user update 3 --user_email=new@example.com" },
  { action: { type: "update-user-role", userId: 3, role: "author" }, contains: "user update 3 --role=author" },
  { action: { type: "set-user-password", userId: 3, password: "longenough1" }, contains: "user update 3 --user_pass" },
  { action: { type: "delete-user", userId: 3 }, contains: "user delete 3" },
  { action: { type: "update-site-option", key: "blogname", value: "Hi" }, contains: "option update blogname" },
  { action: { type: "trash-post", postId: 7 }, contains: "post delete 7" },
  { action: { type: "untrash-post", postId: 7 }, contains: "post update 7 --post_status=draft" },
  { action: { type: "delete-post", postId: 7 }, contains: "post delete 7 --force" },
  { action: { type: "moderate-comments", action: "approve", scope: "id", commentId: 9 }, contains: "comment approve 9" },
];

describe("runManageAction — every exec-backed control does real work and refreshes reads", () => {
  test.each(EXEC_ACTIONS.map((c) => [c.action.type, c] as const))(
    "%s runs a concrete command and invalidates durable + in-memory reads",
    async (_type, { action, contains }) => {
      const res = await runManageAction("blog", action);
      expect(res.ok).toBe(true);
      // It reached a real mutation command — proof it is NOT a dummy/no-op.
      expect(lastExecCommand()).toContain(contains);
      // And the fresh-read fix fired, so the panel won't re-paint the stale snapshot.
      expect(durableMock).toHaveBeenCalledWith("blog");
    },
  );
});

describe("runManageAction — non-exec routed controls hit their real backend", () => {
  test("sync-users runs the vetted account reconcile + invalidates reads", async () => {
    const res = await runManageAction("blog", { type: "sync-users" });
    expect(res.ok).toBe(true);
    expect(syncMock).toHaveBeenCalledWith("blog");
    expect(durableMock).toHaveBeenCalledWith("blog");
  });

  test("set-maintenance-mode calls the real provisioning toggle + invalidates reads", async () => {
    const res = await runManageAction("blog", { type: "set-maintenance-mode", enabled: true });
    expect(res.ok).toBe(true);
    expect(maintMock).toHaveBeenCalledWith("blog", true);
    expect(durableMock).toHaveBeenCalledWith("blog");
  });

  test("reset-user-password mints a link in-pod and emails via InfraWeaver SMTP (never the site's own mailer)", async () => {
    const res = await runManageAction("blog", { type: "reset-user-password", userId: 3 });
    expect(res.ok).toBe(true);
    // It runs the reset-key eval, NOT `wp user reset-password` (which would use the site's mail).
    expect(execMock.mock.calls.some(([, s]) => String(s).includes("eval"))).toBe(true);
    expect(execMock.mock.calls.some(([, s]) => String(s).includes("user reset-password"))).toBe(false);
    expect(mailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "user@example.com", resetUrl: expect.stringContaining("action=rp") }),
    );
    expect(memMock).toHaveBeenCalledWith("blog");
  });
});

describe("runManageAction — server-side guardrails still bite (not bypassable from the UI)", () => {
  test("refuses deleting the last administrator", async () => {
    execMock.mockImplementation(async (_pod: unknown, script: string) => {
      if (script.includes("user list --role=administrator")) return { stdout: '[{"ID":3}]', stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await expect(runManageAction("blog", { type: "delete-user", userId: 3 })).rejects.toThrow(/last administrator/i);
    expect(durableMock).not.toHaveBeenCalled();
  });

  test("refuses removing the InfraWeaver Connector plugin", async () => {
    await expect(
      runManageAction("blog", { type: "delete-plugin", slug: "infraweaver-connector" }),
    ).rejects.toThrow(/Connector/i);
  });
});
