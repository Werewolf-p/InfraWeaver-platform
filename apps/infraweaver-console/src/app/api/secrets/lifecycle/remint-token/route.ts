import { NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";
import { auditLog } from "@/lib/audit-log";
import { getRequestClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { remintPeriodicToken } from "@/lib/secrets/openbao-token";
import { isRemediationWriteEnabled, REMEDIATION_WRITE_FLAG } from "@/lib/secrets/remediation-guard";
import { withRoute } from "@/lib/route-utils";
import { safeError } from "@/lib/utils";

/**
 * POST /api/secrets/lifecycle/remint-token — HIGH-RISK, GATED.
 *
 * Mints a new periodic OpenBao token and writes it STRAIGHT into the ESO token
 * secret server-side. The token value is NEVER returned to the browser. Gated
 * behind SECRET_REMEDIATION_WRITE_ENABLED (501 when off), cluster:admin, strict
 * rate-limit (3/min), audited. Fail closed.
 */
const TOKEN_SECRET_NAME = process.env.ESO_TOKEN_SECRET_NAME ?? "openbao-token";
const TOKEN_SECRET_NAMESPACE = process.env.ESO_TOKEN_SECRET_NAMESPACE ?? "external-secrets";
const TOKEN_SECRET_KEY = process.env.ESO_TOKEN_SECRET_KEY ?? "token";

export const POST = withRoute("cluster:admin", async (req, session) => {
  const actor = session.user?.email ?? "unknown";

  if (!isRemediationWriteEnabled()) {
    return NextResponse.json(
      { ok: false, error: `Remediation writes are disabled. Set ${REMEDIATION_WRITE_FLAG}=true to enable.` },
      { status: 501 },
    );
  }
  if (!checkRateLimit(rateLimitKey("secret-remint-token", req), 3, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const minted = await remintPeriodicToken();
  if (!minted.ok || !minted.token) {
    await auditLog("secret:remint-token", actor, `re-mint failed: ${minted.error ?? "unknown"}`, {
      result: "failure",
      resource: `${TOKEN_SECRET_NAMESPACE}/${TOKEN_SECRET_NAME}`,
      req,
    });
    return NextResponse.json({ ok: false, error: minted.error ?? "Re-mint failed" }, { status: 502 });
  }

  try {
    const coreApi = loadKubeConfig(getRequestClusterId(req)).makeApiClient(k8s.CoreV1Api);
    // stringData lets the API server base64-encode; merge-patch preserves other keys.
    await coreApi.patchNamespacedSecret(
      { namespace: TOKEN_SECRET_NAMESPACE, name: TOKEN_SECRET_NAME, body: { stringData: { [TOKEN_SECRET_KEY]: minted.token } } },
      k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch),
    );
  } catch (err) {
    await auditLog("secret:remint-token", actor, `minted token but secret write failed: ${safeError(err)}`, {
      result: "failure",
      resource: `${TOKEN_SECRET_NAMESPACE}/${TOKEN_SECRET_NAME}`,
      req,
    });
    return NextResponse.json({ ok: false, error: "Token minted but writing the secret failed" }, { status: 502 });
  }

  // Audit metadata only — never the token value (accessor is a non-secret handle).
  await auditLog(
    "secret:remint-token",
    actor,
    `re-minted ESO token → ${TOKEN_SECRET_NAMESPACE}/${TOKEN_SECRET_NAME} (accessor ${minted.accessor ?? "n/a"}, TTL ${minted.ttlSeconds ?? "unknown"}s)`,
    { resource: `${TOKEN_SECRET_NAMESPACE}/${TOKEN_SECRET_NAME}`, req },
  );
  return NextResponse.json({ ok: true, ttlSeconds: minted.ttlSeconds });
});
