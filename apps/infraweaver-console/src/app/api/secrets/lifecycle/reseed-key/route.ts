import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit-log";
import { readKv, writeKv } from "@/lib/openbao/kv";
import { readCatalogSecrets } from "@/lib/secrets/catalog-coverage";
import { isRemediationWriteEnabled, REMEDIATION_WRITE_FLAG } from "@/lib/secrets/remediation-guard";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { parseBody, withRoute } from "@/lib/route-utils";
import { safeError } from "@/lib/utils";

/**
 * POST /api/secrets/lifecycle/reseed-key — HIGH-RISK, GATED.
 *
 * Seeds ONE declared-but-missing catalog key into OpenBao. Guardrails:
 *  - SECRET_REMEDIATION_WRITE_ENABLED (501 when off), cluster:admin, 3/min, audited.
 *  - {app,path,key} validated against the app's catalog.yaml: the path must match
 *    `secrets.path` and the key must be a DECLARED key — arbitrary KV writes are
 *    rejected (prevents seeding outside the catalog contract).
 *  - Read-modify-write: an already-present key is never clobbered (matches the
 *    seeder's atomic idempotent contract). Generated values are never echoed.
 */
const DEFAULT_PASSWORD_BYTES = 18; // → 24-char base64url, matching the seeder default

const ReseedBody = z.object({
  app: z.string().min(1).max(63),
  path: z.string().min(1).max(255),
  key: z.string().min(1).max(253),
});

function generateSecretValue(spec: { type?: string; value?: string } | undefined): string | null {
  const type = spec?.type ?? "password";
  if (type === "static") return spec?.value ?? null; // static keys must declare their value
  if (type === "password") return randomBytes(DEFAULT_PASSWORD_BYTES).toString("base64url");
  return null; // htpasswd and other generated types are out of scope for UI reseed
}

export const POST = withRoute("cluster:admin", async (req, session) => {
  const actor = session.user?.email ?? "unknown";

  if (!isRemediationWriteEnabled()) {
    return NextResponse.json(
      { ok: false, error: `Remediation writes are disabled. Set ${REMEDIATION_WRITE_FLAG}=true to enable.` },
      { status: 501 },
    );
  }
  if (!checkRateLimit(rateLimitKey("secret-reseed-key", req), 3, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const body = await parseBody(req, ReseedBody);
  if (body instanceof NextResponse) return body;
  const { app, path, key } = body;

  // Validate against the catalog contract — never seed an undeclared path/key.
  const secrets = await readCatalogSecrets(app);
  if (!secrets || secrets.path !== path) {
    return NextResponse.json({ ok: false, error: "Path is not declared by this catalog app" }, { status: 400 });
  }
  const keySpec = secrets.keys?.[key];
  if (!keySpec) {
    return NextResponse.json({ ok: false, error: "Key is not declared in the app's catalog.yaml" }, { status: 400 });
  }

  const value = generateSecretValue(keySpec);
  if (value === null) {
    return NextResponse.json({ ok: false, error: `Key type '${keySpec.type ?? "?"}' cannot be reseeded from the console` }, { status: 400 });
  }

  try {
    const existing = (await readKv(path)) as Record<string, unknown> | null;
    if (existing && typeof existing[key] === "string" && existing[key] !== "") {
      // Already seeded — never clobber a live credential.
      return NextResponse.json({ ok: false, error: "Key already has a value — refusing to overwrite" }, { status: 409 });
    }
    // Read-modify-write: preserve every other key at the path.
    await writeKv(path, { ...(existing ?? {}), [key]: value });
  } catch (err) {
    await auditLog("secret:reseed-key", actor, `reseed ${path}/${key} failed: ${safeError(err)}`, {
      result: "failure",
      resource: path,
      req,
    });
    return NextResponse.json({ ok: false, error: "Reseed failed" }, { status: 502 });
  }

  // Value never echoed — audit records only the identity of what was seeded.
  await auditLog("secret:reseed-key", actor, `reseeded catalog key ${app}:${path}/${key} (type ${keySpec.type ?? "password"})`, {
    resource: path,
    req,
  });
  return NextResponse.json({ ok: true });
});
