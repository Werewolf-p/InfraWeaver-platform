import "server-only";
import { randomUUID } from "node:crypto";
import {
  createEnrollmentBundle,
  fromB64u,
  iwKeysFingerprint,
  iwPublicKeys,
  parseEnrollProof,
  serializeBundleFile,
  toB64u,
  verifyEnrollProof,
  wpKeyFingerprint,
} from "@/lib/iwsl";
import { parseSafeExternalUrl, requestSafeExternalUrl } from "@/lib/outbound-url";
import { AddonHttpError } from "./errors";
import { loadOrCreateIwKeys } from "./iwsl-keys";
import { PLAIN_PERMALINKS_HINT, isPlainPermalinkSymptom, looksLikeWordpressHtml } from "./iwsl-rest-hint";
import {
  deleteEnrollSecret,
  getEnrollSecret,
  getExternalSite,
  listExternalSites,
  mutateExternalSites,
  putEnrollSecret,
  type ExternalSiteRecord,
} from "./iwsl-link-store";

/**
 * Console side of IWSL enrollment (§5) — "Add external site", bundle download,
 * verify-pull, fingerprint confirmation. Command dispatch is build phase 4;
 * everything here is reachable without the signer service because the interim
 * key custody (iwsl-keys.ts) signs bundles locally.
 */

const ENROLL_PROOF_PATH = "/wp-json/infraweaver/v1/enroll-proof";
const MAX_PROOF_BYTES = 64 * 1024;
const PROOF_TIMEOUT_MS = 8_000;

export interface ExternalSiteView extends Omit<ExternalSiteRecord, "wpPk"> {
  /** Rendered exactly like the plugin's status output (§5 step 3). */
  wpFingerprint: string | null;
  iwFingerprint: string;
  /** True while a still-valid bundle is outstanding. */
  bundleValid: boolean;
}

function toView(record: ExternalSiteRecord, iwFingerprint: string, now: number): ExternalSiteView {
  const { wpPk, ...rest } = record;
  return {
    ...rest,
    iwFingerprint,
    wpFingerprint: wpPk ? wpKeyFingerprint(wpPk) : null,
    bundleValid: record.state === "pending"
      && typeof record.bundleExpiresAt === "string"
      && Date.parse(record.bundleExpiresAt) > now,
  };
}

export async function listExternalSiteViews(now = Date.now()): Promise<ExternalSiteView[]> {
  const [sites, { keys }] = await Promise.all([listExternalSites(), loadOrCreateIwKeys()]);
  const iwFp = iwKeysFingerprint(iwPublicKeys(keys));
  return sites.map((site) => toView(site, iwFp, now));
}

export interface CreateExternalSiteInput {
  name: string;
  url: string;
}

/** Register a site record (state=pending). The bundle is issued on download. */
export async function createExternalSite(
  input: CreateExternalSiteInput,
  actor: string,
  now = Date.now(),
): Promise<ExternalSiteView> {
  const url = await parseSafeExternalUrl(input.url);
  if (!url) {
    throw new AddonHttpError("Site URL must be a public https origin", 400);
  }
  const origin = url.origin;
  const { keys } = await loadOrCreateIwKeys();
  const iwFp = iwKeysFingerprint(iwPublicKeys(keys));
  const record = await mutateExternalSites((sites) => {
    if (sites.some((s) => s.url === origin)) {
      throw new AddonHttpError("An external site with this URL is already registered", 409);
    }
    const created: ExternalSiteRecord = {
      siteId: randomUUID(),
      name: input.name.trim(),
      url: origin,
      state: "pending",
      fingerprintConfirmed: false,
      createdAt: new Date(now).toISOString(),
      createdBy: actor,
      kid: 0,
      epochFloor: 0,
      iwKid: 0,
      rejections: 0,
    };
    sites.push(created);
    return created;
  });
  return toView(record, iwFp, now);
}

/**
 * §5.1 — register a link record for an IW-provisioned cluster site. Same
 * record shape and state machine as an external site, but the URL comes from
 * the site's own cluster placement labels (not operator input), so the
 * public-origin gate doesn't apply — bundle transport is k8s exec, and the
 * console never dials the URL for a managed link.
 */
export async function createManagedSiteRecord(
  input: { siteName: string; url: string },
  actor: string,
  now = Date.now(),
): Promise<ExternalSiteView> {
  const { keys } = await loadOrCreateIwKeys();
  const iwFp = iwKeysFingerprint(iwPublicKeys(keys));
  const record = await mutateExternalSites((sites) => {
    if (sites.some((s) => s.managed && s.siteName === input.siteName)) {
      throw new AddonHttpError("This site already has a connector link — unlink it first", 409);
    }
    if (sites.some((s) => s.url === input.url)) {
      throw new AddonHttpError("A site with this URL is already registered", 409);
    }
    const created: ExternalSiteRecord = {
      siteId: randomUUID(),
      name: input.siteName,
      url: input.url,
      state: "pending",
      fingerprintConfirmed: false,
      createdAt: new Date(now).toISOString(),
      createdBy: actor,
      kid: 0,
      epochFloor: 0,
      iwKid: 0,
      rejections: 0,
      managed: true,
      siteName: input.siteName,
    };
    sites.push(created);
    return created;
  });
  return toView(record, iwFp, now);
}

export interface IssuedBundle {
  filename: string;
  content: string;
  expiresTs: number;
}

/**
 * Mint the downloadable `.iwenroll` bundle (§5 step 1). Each download issues a
 * fresh enroll_secret and invalidates the previous one — the secret is
 * single-use with a 15-minute TTL, so "re-download" IS re-issue.
 */
export async function issueBundle(siteId: string, now = Date.now()): Promise<IssuedBundle> {
  const site = await getExternalSite(siteId);
  if (!site) throw new AddonHttpError("External site not found", 404);
  if (site.state === "active") {
    throw new AddonHttpError("Site is already enrolled — deactivate it before re-enrolling", 409);
  }
  const { keys, kid } = await loadOrCreateIwKeys();
  const { signed, enrollSecret } = createEnrollmentBundle(
    { siteId: site.siteId, callbackOrigin: site.url, now, iwKid: kid },
    keys,
  );
  await putEnrollSecret(site.siteId, toB64u(enrollSecret));
  await mutateExternalSites((sites) => {
    const target = sites.find((s) => s.siteId === siteId);
    if (!target) throw new AddonHttpError("External site not found", 404);
    target.bundleIssuedAt = new Date(now).toISOString();
    target.bundleExpiresAt = new Date(signed.bundle.expires_ts).toISOString();
    target.iwKid = kid;
  });
  return {
    filename: `infraweaver-enroll-${site.siteId}.iwenroll`,
    content: serializeBundleFile(signed),
    expiresTs: signed.bundle.expires_ts,
  };
}

export type VerifyOutcome =
  | { ok: true; site: ExternalSiteView }
  | { ok: false; reason: string; site: ExternalSiteView | null };

/**
 * §5 step 3 — the verify-pull. IW initiates: fetch the passive enroll-proof
 * from the site (or accept a pasted proof for NAT'd sites), check the
 * HMAC-SHA-384 possession binding, pin WP-PK, burn the enroll secret. The site
 * goes ACTIVE but stays command-blocked until the operator confirms the
 * fingerprint comparison (mandatory-manual for external sites, §5.1).
 */
export async function verifyExternalSite(
  siteId: string,
  pastedProof: string | undefined,
  now = Date.now(),
): Promise<VerifyOutcome> {
  const site = await getExternalSite(siteId);
  if (!site) throw new AddonHttpError("External site not found", 404);
  if (site.state === "active") throw new AddonHttpError("Site is already enrolled", 409);
  const secretB64u = await getEnrollSecret(siteId);
  if (!secretB64u || !site.bundleExpiresAt) {
    throw new AddonHttpError("No outstanding enrollment bundle — download one first", 409);
  }
  const bundleExpiresTs = Date.parse(site.bundleExpiresAt);

  const failed = async (reason: string): Promise<VerifyOutcome> => {
    const { keys } = await loadOrCreateIwKeys();
    const iwFp = iwKeysFingerprint(iwPublicKeys(keys));
    const updated = await mutateExternalSites((sites) => {
      const target = sites.find((s) => s.siteId === siteId);
      if (!target) return null;
      target.rejections += 1;
      target.lastVerify = { at: new Date(now).toISOString(), ok: false, reason };
      return { ...target };
    });
    return { ok: false, reason, site: updated ? toView(updated, iwFp, now) : null };
  };

  // verifyEnrollProof enforces the TTL too; checking here first skips the
  // pointless network pull for a bundle we already know is stale.
  if (now > bundleExpiresTs) return failed("enroll-expired");

  let proofText: string;
  if (pastedProof !== undefined) {
    proofText = pastedProof;
  } else {
    const response = await requestSafeExternalUrl(`${site.url}${ENROLL_PROOF_PATH}`, {
      maxResponseBytes: MAX_PROOF_BYTES,
      timeoutMs: PROOF_TIMEOUT_MS,
    }).catch(() => null);
    if (!response) return failed("proof-unreachable");
    proofText = response.body.toString("utf8");
    if (response.status !== 200) {
      // A site on plain permalinks 3xx-redirects /wp-json to its homepage
      // (or serves the HTML page) — surface the fix, not the raw status.
      if (isPlainPermalinkSymptom(response.status, proofText)) return failed(PLAIN_PERMALINKS_HINT);
      return failed(`proof-endpoint-${response.status}`);
    }
  }

  // The network branch caps via maxResponseBytes, but a pasted proof (also the
  // managed/exec path, whose stdout doesn't go through the API's zod cap) would
  // otherwise reach parseEnrollProof/JSON.parse unbounded. Enforce the same cap.
  if (Buffer.byteLength(proofText, "utf8") > MAX_PROOF_BYTES) return failed("proof-too-large");

  let result: ReturnType<typeof verifyEnrollProof>;
  try {
    result = verifyEnrollProof(
      { siteId: site.siteId, enrollSecret: fromB64u(secretB64u), expiresTs: bundleExpiresTs },
      parseEnrollProof(proofText),
      now,
    );
  } catch {
    // A 200 that is the HTML homepage (plain permalinks) also lands here —
    // the parse blew up on markup, not on a malformed proof.
    if (looksLikeWordpressHtml(proofText)) return failed(PLAIN_PERMALINKS_HINT);
    return failed("schema-fail");
  }
  if (!result.ok) return failed(result.reason);

  // Pin WP-PK, activate, burn the single-use secret (both sides burn: the
  // plugin retires its proof endpoint on first verified command).
  const wpPk = result.wpPk;
  const { keys } = await loadOrCreateIwKeys();
  const iwFp = iwKeysFingerprint(iwPublicKeys(keys));
  const updated = await mutateExternalSites((sites) => {
    const target = sites.find((s) => s.siteId === siteId);
    if (!target) throw new AddonHttpError("External site not found", 404);
    target.state = "active";
    target.wpPk = wpPk;
    target.kid = 1;
    target.epochFloor = 1;
    target.activatedAt = new Date(now).toISOString();
    target.fingerprintConfirmed = false;
    target.lastVerify = { at: new Date(now).toISOString(), ok: true };
    return { ...target };
  });
  await deleteEnrollSecret(siteId);
  return { ok: true, site: toView(updated, iwFp, now) };
}

/** Operator confirmed the §5 step-3 visual fingerprint comparison. */
export async function confirmFingerprint(siteId: string, now = Date.now()): Promise<ExternalSiteView> {
  const { keys } = await loadOrCreateIwKeys();
  const iwFp = iwKeysFingerprint(iwPublicKeys(keys));
  const updated = await mutateExternalSites((sites) => {
    const target = sites.find((s) => s.siteId === siteId);
    if (!target) throw new AddonHttpError("External site not found", 404);
    if (target.state !== "active" || !target.wpPk) {
      throw new AddonHttpError("Site is not enrolled yet — verify it first", 409);
    }
    target.fingerprintConfirmed = true;
    return { ...target };
  });
  return toView(updated, iwFp, now);
}

/** Remove the record and burn any outstanding enroll secret. */
export async function deleteExternalSite(siteId: string): Promise<void> {
  await mutateExternalSites((sites) => {
    const index = sites.findIndex((s) => s.siteId === siteId);
    if (index === -1) throw new AddonHttpError("External site not found", 404);
    sites.splice(index, 1);
  });
  await deleteEnrollSecret(siteId);
}
