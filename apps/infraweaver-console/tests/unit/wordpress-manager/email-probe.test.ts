import { buildEmailData } from "@/addons/wordpress-manager/lib/manage/probes/email";

describe("buildEmailData", () => {
  test("no detected plugin ⇒ unconfigured, all fields null", () => {
    expect(buildEmailData(null, null)).toEqual({
      plugin: null,
      mailer: null,
      host: null,
      port: null,
      encryption: null,
      auth: null,
      fromEmail: null,
      fromName: null,
      configured: false,
    });
  });

  test("plugin detected but option empty (all-null posture) ⇒ NOT configured", () => {
    const data = buildEmailData("wp-mail-smtp", {
      mailer: null,
      host: null,
      port: null,
      encryption: null,
      auth: null,
      fromEmail: null,
      fromName: null,
    });
    expect(data.plugin).toBe("wp-mail-smtp");
    expect(data.configured).toBe(false);
  });

  test("readable posture ⇒ configured, fields carried through, no secret field exists on the shape", () => {
    const data = buildEmailData("wp-mail-smtp", {
      mailer: "mailgun",
      host: "smtp.mailgun.org",
      port: 587,
      encryption: "tls",
      auth: true,
      fromEmail: "info@example.com",
      fromName: "info",
    });
    expect(data).toEqual({
      plugin: "wp-mail-smtp",
      mailer: "mailgun",
      host: "smtp.mailgun.org",
      port: 587,
      encryption: "tls",
      auth: true,
      fromEmail: "info@example.com",
      fromName: "info",
      configured: true,
    });
    // The posture shape carries no password/user field at all — the probe never
    // plucks them, so a credential can't ride through this assembler.
    expect(Object.keys(data)).not.toEqual(expect.arrayContaining(["pass", "password", "user"]));
  });

  test("a single readable field is enough to count as configured", () => {
    const data = buildEmailData("post-smtp", {
      mailer: "smtp",
      host: null,
      port: null,
      encryption: null,
      auth: null,
      fromEmail: null,
      fromName: null,
    });
    expect(data.configured).toBe(true);
    expect(data.mailer).toBe("smtp");
  });
});
