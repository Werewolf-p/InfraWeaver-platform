import {
  connectorDelivering,
  emailConfigSetParamsSchema,
  emailSettingsSchema,
  emailTestParamsSchema,
  mergeEmailData,
  SECURE_MODES,
  type EmailConnectorConfig,
  type EmailPluginPosture,
  type EmailSettings,
} from "@/addons/wordpress-manager/lib/manage/email";
import {
  applyPreset,
  detectPreset,
  EMAIL_PRESETS,
  findPreset,
  fromIdentityWarning,
  OFFICE365_PRESET,
} from "@/addons/wordpress-manager/lib/manage/email-presets";

const VALID_SETTINGS: EmailSettings = {
  host: "smtp.office365.com",
  port: 587,
  auth: true,
  username: "postmaster@example.com",
  from_email: "postmaster@example.com",
  from_name: "Example",
  secure: "tls",
  allow_option_password: true,
};

describe("emailSettingsSchema (wire parity with $email_config_set_params)", () => {
  test("accepts the exact eight fields with correct types", () => {
    // Act
    const parsed = emailSettingsSchema.safeParse(VALID_SETTINGS);
    // Assert
    expect(parsed.success).toBe(true);
  });

  test("rejects an unknown settings key (strays refused)", () => {
    const parsed = emailSettingsSchema.safeParse({ ...VALID_SETTINGS, password: "hunter2" });
    expect(parsed.success).toBe(false);
  });

  test("rejects a missing field", () => {
    const { host: _drop, ...missing } = VALID_SETTINGS;
    expect(emailSettingsSchema.safeParse(missing).success).toBe(false);
  });

  test("rejects CRLF in header-bearing fields (injection defence)", () => {
    for (const field of ["host", "username", "from_email", "from_name"] as const) {
      const bad = { ...VALID_SETTINGS, [field]: "x\r\ninjected: header" };
      expect(emailSettingsSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("rejects an out-of-range port", () => {
    expect(emailSettingsSchema.safeParse({ ...VALID_SETTINGS, port: 0 }).success).toBe(false);
    expect(emailSettingsSchema.safeParse({ ...VALID_SETTINGS, port: 70000 }).success).toBe(false);
  });

  test("only the three engine secure modes are accepted", () => {
    for (const mode of SECURE_MODES) {
      expect(emailSettingsSchema.safeParse({ ...VALID_SETTINGS, secure: mode }).success).toBe(true);
    }
    expect(emailSettingsSchema.safeParse({ ...VALID_SETTINGS, secure: "starttls" }).success).toBe(false);
  });
});

describe("emailConfigSetParamsSchema (write-only secret shape)", () => {
  test("accepts { settings } with an optional write-only password", () => {
    expect(emailConfigSetParamsSchema.safeParse({ settings: VALID_SETTINGS }).success).toBe(true);
    expect(
      emailConfigSetParamsSchema.safeParse({ settings: VALID_SETTINGS, password: "s3cret" }).success,
    ).toBe(true);
    expect(
      emailConfigSetParamsSchema.safeParse({ settings: VALID_SETTINGS, clear_password: true }).success,
    ).toBe(true);
  });

  test("rejects an unknown top-level key", () => {
    const parsed = emailConfigSetParamsSchema.safeParse({ settings: VALID_SETTINGS, foo: 1 });
    expect(parsed.success).toBe(false);
  });

  test("rejects a CRLF-bearing password (header injection)", () => {
    const parsed = emailConfigSetParamsSchema.safeParse({
      settings: VALID_SETTINGS,
      password: "a\r\nb",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("emailTestParamsSchema", () => {
  test("accepts a single recipient", () => {
    expect(emailTestParamsSchema.safeParse({ to: "ops@example.com" }).success).toBe(true);
  });
  test("rejects empty / blank / CRLF / extra keys", () => {
    expect(emailTestParamsSchema.safeParse({ to: "" }).success).toBe(false);
    expect(emailTestParamsSchema.safeParse({ to: "   " }).success).toBe(false);
    expect(emailTestParamsSchema.safeParse({ to: "a\r\nb" }).success).toBe(false);
    expect(emailTestParamsSchema.safeParse({ to: "a@b.c", cc: "x" }).success).toBe(false);
  });
});

describe("connectorDelivering", () => {
  const base: EmailConnectorConfig = {
    gate: { unlocked: true },
    locked: false,
    switch_on: true,
    configured: true,
  };
  test("true only when unlocked + switched on + configured", () => {
    expect(connectorDelivering(base)).toBe(true);
    expect(connectorDelivering({ ...base, switch_on: false })).toBe(false);
    expect(connectorDelivering({ ...base, configured: false })).toBe(false);
    expect(connectorDelivering({ ...base, locked: true })).toBe(false);
    expect(connectorDelivering(null)).toBe(false);
  });
});

describe("mergeEmailData", () => {
  const plugin: EmailPluginPosture = {
    plugin: "wp-mail-smtp",
    mailer: "smtp",
    host: "smtp.example.com",
    port: 587,
    encryption: "tls",
    auth: true,
    fromEmail: "a@b.c",
    fromName: "A",
    configured: true,
  };
  const delivering: EmailConnectorConfig = {
    gate: { unlocked: true },
    locked: false,
    switch_on: true,
    configured: true,
    settings: VALID_SETTINGS,
  };

  test("connector present ⇒ source=connector (even when a plugin is also active)", () => {
    const data = mergeEmailData({ connector: delivering, plugin, log: null });
    expect(data.source).toBe("connector");
    expect(data.connectorAvailable).toBe(true);
  });

  test("locked connector still leads (renderable upgrade state)", () => {
    const locked: EmailConnectorConfig = { gate: { unlocked: false, tier: "basic" }, locked: true };
    const data = mergeEmailData({ connector: locked, plugin: null, log: null });
    expect(data.source).toBe("connector");
  });

  test("no connector, active plugin ⇒ source=plugin (fallback)", () => {
    const data = mergeEmailData({ connector: null, plugin, log: null });
    expect(data.source).toBe("plugin");
    expect(data.connectorAvailable).toBe(false);
  });

  test("nothing ⇒ source=none", () => {
    const data = mergeEmailData({ connector: null, plugin: null, log: null });
    expect(data.source).toBe("none");
  });

  test("conflict only when connector is delivering AND a plugin is active", () => {
    expect(mergeEmailData({ connector: delivering, plugin, log: null }).conflict).toBe(true);
    expect(mergeEmailData({ connector: delivering, plugin: null, log: null }).conflict).toBe(false);
    const notDelivering = { ...delivering, switch_on: false };
    expect(mergeEmailData({ connector: notDelivering, plugin, log: null }).conflict).toBe(false);
  });
});

describe("email presets", () => {
  test("O365 preset pins host/port/tls/auth and requires From = mailbox", () => {
    expect(OFFICE365_PRESET.host).toBe("smtp.office365.com");
    expect(OFFICE365_PRESET.port).toBe(587);
    expect(OFFICE365_PRESET.secure).toBe("tls");
    expect(OFFICE365_PRESET.fromMustMatchAuth).toBe(true);
    expect(OFFICE365_PRESET.spfInclude).toBe("spf.protection.outlook.com");
  });

  test("applyPreset returns a NEW object and pins only non-null fields", () => {
    const base: EmailSettings = { ...VALID_SETTINGS, host: "old", port: 25, secure: "" };
    const next = applyPreset(OFFICE365_PRESET, base);
    expect(next).not.toBe(base);
    expect(base.host).toBe("old"); // immutability
    expect(next.host).toBe("smtp.office365.com");
    expect(next.port).toBe(587);
    expect(next.secure).toBe("tls");
    // custom leaves host/port/secure untouched
    const custom = applyPreset(findPreset("custom")!, base);
    expect(custom.host).toBe("old");
    expect(custom.port).toBe(25);
  });

  test("detectPreset maps stored host back to its provider", () => {
    expect(detectPreset({ host: "smtp.office365.com" })).toBe("office365");
    expect(detectPreset({ host: "smtp.gmail.com" })).toBe("google");
    expect(detectPreset({ host: "mail.acme.internal" })).toBe("custom");
  });

  test("fromIdentityWarning fires only for strict providers with a mismatched From", () => {
    expect(fromIdentityWarning(OFFICE365_PRESET, { from_email: "other@x.com", username: "me@x.com" })).not.toBeNull();
    expect(fromIdentityWarning(OFFICE365_PRESET, { from_email: "me@x.com", username: "me@x.com" })).toBeNull();
    expect(fromIdentityWarning(OFFICE365_PRESET, { from_email: "", username: "me@x.com" })).toBeNull();
    expect(fromIdentityWarning(findPreset("custom")!, { from_email: "other@x.com", username: "me@x.com" })).toBeNull();
  });

  test("EMAIL_PRESETS covers the three provider options", () => {
    expect(EMAIL_PRESETS.map((p) => p.id)).toEqual(["office365", "google", "custom"]);
  });
});
