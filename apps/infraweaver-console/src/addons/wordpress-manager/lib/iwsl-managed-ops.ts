import "server-only";
import { randomUUID } from "node:crypto";
import {
  createSignedCommand,
  runScheduledRotation,
  verifySignedResponse,
  wpKeyFingerprint,
  type CommandChannel,
  type RotationOutcome,
  type RotationReply,
  type SignedCommand,
  type SignedResponse,
  type SiteLinkState,
} from "@/lib/iwsl";
import { requestSafeExternalUrl } from "@/lib/outbound-url";
import { AddonHttpError } from "./errors";
import { execInWpPod } from "./k8s-exec";
import { findWpPodName } from "./provision";
import { buildConnectorPackage } from "./connector-package";
import { loadOrCreateIwKeys } from "./iwsl-keys";
import { listExternalSites, mutateExternalSites, type ExternalSiteRecord } from "./iwsl-link-store";
import { confirmIdentity, evaluateIdentity, isIdentitySuspended } from "./iwsl-identity";
import { unlinkManagedSite } from "./iwsl-managed";
import { PLAIN_PERMALINKS_HINT, isPlainPermalinkSymptom } from "./iwsl-rest-hint";
import {
  connectorSelftestCliScript,
  connectorStatusCliScript,
  extractCommandJson,
  installConnectorScript,
  signedCommandScript,
} from "./iwsl-managed-commands";
import {
  callRpc,
  type CommandReply,
  type DispatchOptions,
  type RpcMethod,
  type RpcTransport,
} from "./rpc/registry";

export type { CommandReply } from "./rpc/registry";

/**
 * Signed command dispatch for §5.1 managed links — the console side of §6 over
 * the k8s-exec transport. Same wire objects the REST /command endpoint would
 * carry; the plugin's verifier stays the enforcement point. Every response is
 * verified against the pinned WP-PK before its result is trusted, and a
 * response that fails verification quarantines the link (§12.5): inside the
 * cluster that means the site's own key material no longer matches what we
 * pinned, which is exactly the tamper signal quarantine exists for.
 */

const COMMAND_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 120_000;

/** §6 signed-command REST endpoint the Connector exposes (external §5 transport). */
const COMMAND_PATH = "/wp-json/infraweaver/v1/command";
/**
 * Outbound command body cap for the HTTP transport — matches the plugin's own
 * IWSL_MAX_BODY_BYTES (§12 anti-DoS). We refuse to send a body the plugin would
 * 413 anyway, and bound the response read to the same size (a health.check
 * signed response is ~24 KB — SLH-DSA sig dominates — so this is generous).
 */
const MAX_CMD_BODY_BYTES = 64 * 1024;

/**
 * How a signed command reaches the site and comes back. Returns the plugin's
 * response `body` (either a signed response object or an unsigned `{ok,reason}`
 * rejection) — identical shape across transports so verification stays shared.
 */
type CommandDelivery = (signedJson: string) => Promise<unknown>;

/**
 * Managed (§5.1) transport: k8s exec into the site pod, signed wire object over
 * stdin. handle_command prints `{status, body}`; we return `body`.
 */
function execDelivery(pod: string): CommandDelivery {
  return async (signedJson) => {
    const { stdout } = await execInWpPod(pod, signedCommandScript(), {
      stdin: signedJson,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    let parsed: { status?: unknown; body?: unknown };
    try {
      parsed = JSON.parse(extractCommandJson(stdout)) as { status?: unknown; body?: unknown };
    } catch {
      throw new AddonHttpError("Connector returned an unreadable response — is the plugin installed?", 502);
    }
    return parsed.body;
  };
}

/**
 * External (§5) transport: SSRF-safe HTTPS POST to the plugin's /command REST
 * endpoint. The REST callback returns the plugin `body` directly (HTTP status
 * mirrors the plugin), so the parsed HTTP body IS the `body`. The §2 invariant
 * holds — the site still never dials IW; this is IW initiating, the plugin only
 * answering inside the same exchange.
 */
function httpDelivery(url: string, pinnedSpki?: string[]): CommandDelivery {
  return async (signedJson) => {
    if (Buffer.byteLength(signedJson, "utf8") > MAX_CMD_BODY_BYTES) {
      throw new AddonHttpError("Signed command exceeds the 64 KB channel cap", 413);
    }
    const res = await requestSafeExternalUrl(`${url}${COMMAND_PATH}`, {
      method: "POST",
      body: signedJson,
      headers: { "Content-Type": "application/json" },
      maxResponseBytes: MAX_CMD_BODY_BYTES,
      timeoutMs: COMMAND_TIMEOUT_MS,
      // Cert-pin the site (defense-in-depth): a hijacked-DNS/mis-issued-CA
      // endpoint fails the TLS handshake here, before the signed command is sent.
      pinnedSpki,
    }).catch(() => null);
    if (!res) throw new AddonHttpError("Could not reach the site's signed command endpoint", 502);
    const text = res.body.toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      if (isPlainPermalinkSymptom(res.status, text)) {
        throw new AddonHttpError(PLAIN_PERMALINKS_HINT, 502);
      }
      throw new AddonHttpError("Connector returned an unreadable response — is the plugin installed?", 502);
    }
  };
}

/** Raw record (incl. pinned wpPk) for a managed link — internal only. */
async function getManagedRecord(site: string): Promise<ExternalSiteRecord | null> {
  const sites = await listExternalSites();
  return sites.find((s) => s.managed && s.siteName === site) ?? null;
}

async function requireManagedRecord(site: string): Promise<ExternalSiteRecord> {
  const record = await getManagedRecord(site);
  if (!record) throw new AddonHttpError("This site has no connector link — enable the connector first", 404);
  return record;
}

/** Raw record for an EXTERNAL (§5, non-managed) link by site id — internal only. */
async function requireExternalRecord(siteId: string): Promise<ExternalSiteRecord> {
  const sites = await listExternalSites();
  const record = sites.find((s) => s.siteId === siteId && !s.managed);
  if (!record) throw new AddonHttpError("External site not found", 404);
  return record;
}

function requireCommandable(record: ExternalSiteRecord): void {
  if (record.state === "quarantined") {
    throw new AddonHttpError("Link is quarantined — release it before sending commands", 409);
  }
  if (record.state !== "active" || !record.fingerprintConfirmed || !record.wpPk) {
    throw new AddonHttpError("Link is not active yet — enrollment has not completed", 409);
  }
}

/**
 * Clone/identity-crisis safe mode (§5, §12.5). Gates the STATE-CHANGING ops
 * (key rotation, plugin update) when the link self-reported a canonical URL
 * that differs from what it was bound to — the site may be a clone or a
 * mid-migration install. Read-only diagnostics (health.check, debug.status) and
 * the destructive escape hatches (quarantine, deactivate/kill) are deliberately
 * NOT gated: the operator needs those to investigate and to shut a clone down.
 * This is a defense-in-depth policy gate — the signature/pinned-key checks are
 * the real trust boundary — so a snapshot read is sufficient.
 */
function requireIdentityConfirmed(record: ExternalSiteRecord): void {
  if (isIdentitySuspended(record)) {
    throw new AddonHttpError(
      "This link is in identity safe mode — the site reported a changed canonical URL. Re-confirm its identity (or quarantine it) before changing state.",
      409,
    );
  }
}

/**
 * Fold a signature-verified self-reported canonical URL into a link's identity
 * fields. Mutates `target` in place inside a mutateExternalSites callback: a
 * mismatch flips safe mode, the first report binds the identity, and an
 * unparseable/absent report is a no-op (a Connector too old to self-report never
 * trips it). A fresh mismatch is logged so a clone/migration leaves an audit line.
 */
function applyIdentityObservation(target: ExternalSiteRecord, observedRaw: unknown, atIso: string): void {
  const decision = evaluateIdentity(target, observedRaw, atIso);
  if (decision.kind === "no-signal") return;
  const wasSuspended = target.identitySuspended === true;
  target.canonicalUrl = decision.next.canonicalUrl;
  target.identitySuspended = decision.next.identitySuspended;
  target.identityAlert = decision.next.identityAlert;
  if (decision.kind === "mismatch" && !wasSuspended) {
    console.warn(
      `[wordpress:iwsl] identity crisis for ${target.siteId}: self-reported ${decision.next.identityAlert?.observedUrl} != bound ${decision.next.identityAlert?.boundUrl} — safe mode engaged`,
    );
  }
}

async function requireRunningPod(site: string): Promise<string> {
  const pod = await findWpPodName(site);
  if (!pod) throw new AddonHttpError("The site's WordPress pod is not running yet", 503);
  return pod;
}

/** Allocate the next monotonic command seq for this link (§6.3). */
async function allocateSeq(siteId: string): Promise<number> {
  return mutateExternalSites((sites) => {
    const target = sites.find((s) => s.siteId === siteId);
    if (!target) throw new AddonHttpError("Connector link vanished mid-command", 409);
    target.lastSeq = (target.lastSeq ?? 0) + 1;
    return target.lastSeq;
  });
}

async function recordResponseTamper(siteId: string, reason: string, now: number): Promise<void> {
  await mutateExternalSites((sites) => {
    const target = sites.find((s) => s.siteId === siteId);
    if (!target) return;
    target.rejections += 1;
    target.state = "quarantined";
    target.lastVerify = { at: new Date(now).toISOString(), ok: false, reason };
  });
}

/**
 * Sign, deliver over the given transport, and verify one command. The verifier
 * (pinned WP-PK check + §12.5 quarantine on tamper) is identical regardless of
 * transport, so a MITM on the external HTTP channel is caught exactly as an
 * in-cluster tamper would be. Throws AddonHttpError for operator-actionable
 * failures; a plugin-side unsigned rejection comes back as
 * `{ ok:false, rejectedReason }` so callers can surface the §12.5 reason.
 */
async function dispatchSignedCommand(
  record: ExternalSiteRecord,
  deliver: CommandDelivery,
  channel: CommandChannel,
  method: string,
  params: Record<string, unknown>,
  opts: DispatchOptions = {},
): Promise<CommandReply> {
  const { keys, kid: currentIwKid } = await loadOrCreateIwKeys();
  const seq = await allocateSeq(record.siteId);
  const started = Date.now();
  const signed: SignedCommand = createSignedCommand(
    {
      siteId: record.siteId,
      method,
      params,
      seq,
      kid: record.iwKid > 0 ? record.iwKid : currentIwKid,
      ts: started,
      // §6.4 channel/audience binding: bind the command to the transport it is
      // sent over (and, on HTTPS, the pinned SPKI) so a captured valid command
      // is non-redirectable to another channel or endpoint.
      channel,
      spki: channel === "https" ? record.pinnedSpki : undefined,
    },
    keys,
  );

  const body = await deliver(JSON.stringify(signed));
  const roundtripMs = Date.now() - started;

  if (!body || typeof body !== "object") {
    throw new AddonHttpError("Connector returned an unreadable response — is the plugin installed?", 502);
  }

  // Unsigned rejection from the plugin's verifier ({ok:false, reason}).
  if (!("envelope" in body)) {
    const reason = String((body as { reason?: unknown }).reason ?? "unknown");
    return { ok: false, kid: 0, result: {}, roundtripMs, rejectedReason: reason };
  }

  const signedResponse = body as unknown as SignedResponse;
  const expectation = { siteId: record.siteId, commandNonce: signed.envelope.nonce };
  const candidates = [record.wpPk, opts.altWpPk].filter((pk): pk is string => typeof pk === "string" && pk.length > 0);
  let lastReason = "no-pinned-key";
  let verifiedOk = false;
  for (const pk of candidates) {
    const verdict = verifySignedResponse(signedResponse, pk, expectation);
    if (verdict.ok) {
      verifiedOk = true;
      break;
    }
    lastReason = verdict.reason;
  }
  const envelopeKid = Number(signedResponse.envelope.kid);
  if (verifiedOk && !Number.isInteger(envelopeKid)) {
    verifiedOk = false;
    lastReason = "schema-fail";
  }
  if (verifiedOk && envelopeKid < record.epochFloor) {
    verifiedOk = false;
    lastReason = "kid-retired";
  }
  if (!verifiedOk) {
    // Authentic-looking transport, bad signature: treat as tamper and cut the
    // signing path until an operator investigates (§12.5).
    await recordResponseTamper(record.siteId, lastReason, Date.now());
    throw new AddonHttpError(
      `Response signature check failed (${lastReason}) — the link has been quarantined`,
      502,
    );
  }

  return {
    ok: signedResponse.envelope.ok === true,
    kid: envelopeKid,
    result: (signedResponse.envelope.result ?? {}) as Record<string, unknown>,
    roundtripMs,
  };
}

/**
 * Bind a link record and a delivery (exec or HTTPS) onto `dispatchSignedCommand`
 * to get the transport `callRpc` funnels the six methods through. The registry
 * layer sits on top of this — same signed bytes, one typed entry point.
 */
function rpcTransport(
  record: ExternalSiteRecord,
  deliver: CommandDelivery,
  channel: CommandChannel,
): RpcTransport {
  return (method: RpcMethod, params: Record<string, unknown>, opts?: DispatchOptions) =>
    dispatchSignedCommand(record, deliver, channel, method, params, opts);
}

// ── Debugging ────────────────────────────────────────────────────────────────

export interface ConnectorHealth {
  ok: boolean;
  roundtripMs: number;
  result: Record<string, unknown>;
  rejectedReason?: string;
}

/**
 * Persist a verified health.check outcome on the link (§12.5). The version is
 * trusted only because dispatchSignedCommand already verified the response
 * signature (a bad signature quarantines and throws before we get here), so a
 * MITM can't feed us a lower version to mask an out-of-date connector.
 */
/** A plugin `last_reroll.at` more than this far in the future is rejected (clock skew / clone). */
const REROLL_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Parse the plugin's own signed `last_reroll` (§8) into the record's shape. The
 * plugin reports unix seconds + an ok flag; map ok→outcome. Returns null for any
 * missing/malformed field (the plugin predates the field, or nothing to report).
 */
function parsePluginReroll(raw: unknown): ExternalSiteRecord["lastReroll"] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { at?: unknown; kid?: unknown; ok?: unknown; reason?: unknown };
  if (typeof r.at !== "number" || typeof r.kid !== "number" || typeof r.ok !== "boolean") return null;
  return {
    at: new Date(r.at * 1000).toISOString(),
    outcome: r.ok ? "confirmed" : "aborted",
    kid: r.kid,
    ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
  };
}

async function persistHealthResult(record: ExternalSiteRecord, reply: CommandReply): Promise<void> {
  const version = typeof reply.result.plugin === "string" ? reply.result.plugin : null;
  // The self-reported canonical URL rode inside the response `dispatchSignedCommand`
  // already signature-verified (a bad signature quarantines and throws before we
  // reach here), so it's as trustworthy as the version above — a MITM can't
  // forge it. §5 clone/identity-crisis detection.
  const observedUrl = reply.result.site_url;
  await mutateExternalSites((sites) => {
    const target = sites.find((s) => s.siteId === record.siteId);
    if (!target) return;
    target.lastHealth = {
      at: new Date().toISOString(),
      ok: reply.ok,
      roundtripMs: reply.roundtripMs,
      ...(reply.rejectedReason ? { reason: reply.rejectedReason } : {}),
    };
    if (version) target.connectorVersion = version;
    // §8: reconcile the reroll outcome from the plugin's own signed report. It's
    // authoritative (signature-verified above); prefer it over a stale local
    // stamp, and always let a terminal outcome replace an in-flight "pending".
    // Reject a future-dated `at` (clock-skewed/clone plugin): it must not mask a
    // fresher local `aborted` nor drive `keyAgeMs` negative to dodge rotation.
    const pluginReroll = parsePluginReroll(reply.result.last_reroll);
    if (pluginReroll && Date.parse(pluginReroll.at) <= Date.now() + REROLL_FUTURE_SKEW_MS) {
      const cur = target.lastReroll;
      if (!cur || cur.outcome === "pending" || Date.parse(pluginReroll.at) >= Date.parse(cur.at)) {
        target.lastReroll = pluginReroll;
      }
    }
    // Identity observation must run ONLY on a signature-verified reply. An
    // unsigned rejection (e.g. stale-ts from clock skew, unknown-method) carries
    // no site_url; feeding that absence to the evaluator would misread it as
    // "stopped reporting" and wrongly trip identitySuspended — which then blocks
    // both auto and manual reroll for the site. A verified reply that genuinely
    // omits site_url still flows through (a real old-connector/broken-home signal).
    if (!reply.rejectedReason) {
      applyIdentityObservation(target, observedUrl, new Date().toISOString());
    }
  });
}

function toConnectorHealth(reply: CommandReply): ConnectorHealth {
  return { ok: reply.ok, roundtripMs: reply.roundtripMs, result: reply.result, rejectedReason: reply.rejectedReason };
}

/** Signed health.check over exec (§5.1 managed link); outcome persisted (§12.5). */
export async function connectorHealthCheck(site: string): Promise<ConnectorHealth> {
  const record = await requireManagedRecord(site);
  requireCommandable(record);
  const pod = await requireRunningPod(site);
  const reply = await callRpc(rpcTransport(record, execDelivery(pod), "exec"), "health.check", {});
  await persistHealthResult(record, reply);
  return toConnectorHealth(reply);
}

/**
 * §5 phase-4 — signed health.check to an EXTERNAL site over the public HTTPS
 * command channel. IW initiates the POST; the plugin verifies the dual signature
 * and answers inside the same exchange (§2 invariant intact — the site never
 * dials IW). The response is verified against the pinned WP-PK exactly as the
 * exec path is, so a machine-in-the-middle that tampers with either the command
 * or the reply is caught and quarantines the link. Populates `connectorVersion`
 * for the external-site update-available badge.
 */
export async function externalConnectorHealthCheck(siteId: string): Promise<ConnectorHealth> {
  const record = await requireExternalRecord(siteId);
  requireCommandable(record);
  const reply = await callRpc(
    rpcTransport(record, httpDelivery(record.url, record.pinnedSpki), "https"),
    "health.check",
    {},
  );
  await persistHealthResult(record, reply);
  return toConnectorHealth(reply);
}

export interface ConnectorDebug {
  /** Raw `wp infraweaver status` output. */
  statusText: string;
  /** Raw `wp infraweaver selftest` output. */
  selftestText: string;
  /** Structured debug.status over the signed channel (null when unavailable). */
  debug: Record<string, unknown> | null;
  /** Why `debug` is null (e.g. plugin predates debug.status, link quarantined). */
  debugUnavailable?: string;
}

/**
 * Deep diagnostics. The CLI probes run for ANY link state — they are exactly
 * what an operator needs when the signed channel is broken — while the signed
 * debug.status runs only on an active confirmed link.
 */
export async function connectorDebug(site: string): Promise<ConnectorDebug> {
  const record = await requireManagedRecord(site);
  const pod = await requireRunningPod(site);
  const [statusOut, selftestOut] = await Promise.all([
    execInWpPod(pod, connectorStatusCliScript()),
    execInWpPod(pod, connectorSelftestCliScript()),
  ]);

  let debug: Record<string, unknown> | null = null;
  let debugUnavailable: string | undefined;
  if (record.state === "active" && record.fingerprintConfirmed && record.wpPk) {
    const reply = await callRpc(rpcTransport(record, execDelivery(pod), "exec"), "debug.status", {});
    if (reply.rejectedReason === "unknown-method") {
      debugUnavailable = "The installed Connector predates debug.status — update the plugin below.";
    } else if (reply.rejectedReason) {
      debugUnavailable = `Command rejected: ${reply.rejectedReason}`;
    } else if (!reply.ok) {
      debugUnavailable = "The plugin reported a failure for debug.status";
    } else {
      debug = reply.result;
    }
  } else {
    debugUnavailable = "Signed diagnostics need an active, fingerprint-confirmed link.";
  }

  // debug.status carries the same signature-verified self-reported canonical URL
  // as health.check, so evaluate it here too — deep diagnostics are a second
  // detector for a clone/migration (§5).
  if (debug && typeof debug.site_url === "string") {
    await mutateExternalSites((sites) => {
      const target = sites.find((s) => s.siteId === record.siteId);
      if (target) applyIdentityObservation(target, debug.site_url, new Date().toISOString());
    });
  }

  return {
    statusText: statusOut.stdout.trim(),
    selftestText: selftestOut.stdout.trim(),
    debug,
    debugUnavailable,
  };
}

// ── Security operations ──────────────────────────────────────────────────────

export interface RotationResult {
  outcome: RotationOutcome;
  kid: number;
  wpFingerprint: string | null;
}

/**
 * "Reroll" the site's signing key — one §8 PREPARE → VERIFY → CONFIRM cycle
 * over the exec transport. In-cluster the whole cycle completes in a single
 * call; a lost ack leaves `pendingRotation` persisted and the next run
 * resumes it (idempotent, keyed on rotation_id).
 */
export async function rotateConnectorKey(site: string): Promise<RotationResult> {
  const record = await requireManagedRecord(site);
  requireCommandable(record);
  requireIdentityConfirmed(record);
  const pod = await requireRunningPod(site);

  // A prepared-but-unconfirmed key from a resumed rotation is a legitimate
  // response signer (§8 chain of custody) — track it as it becomes known.
  let altWpPk: string | null = record.pendingRotation?.newWpPk ?? null;
  const transport = async (method: string, params: Record<string, unknown>): Promise<RotationReply | null> => {
    try {
      const reply = await dispatchSignedCommand(record, execDelivery(pod), "exec", method, params, { altWpPk });
      if (reply.rejectedReason) return { ok: false, kid: reply.kid, result: { reason: reply.rejectedReason } };
      if (method === "key.rotate.self" && reply.ok && typeof reply.result.new_wp_pk === "string") {
        altWpPk = reply.result.new_wp_pk;
      }
      return { ok: reply.ok, kid: reply.kid, result: reply.result };
    } catch (err) {
      if (err instanceof AddonHttpError && err.status === 502) throw err; // tamper — already quarantined
      return null; // transport loss — the driver retries / resumes
    }
  };

  const state: SiteLinkState = {
    siteId: record.siteId,
    kid: record.kid,
    epochFloor: record.epochFloor,
    wpPk: record.wpPk as string,
    pendingRotation: record.pendingRotation ?? null,
  };
  const run = await runScheduledRotation(state, transport, { rotationId: randomUUID(), now: Date.now() });

  await mutateExternalSites((sites) => {
    const target = sites.find((s) => s.siteId === record.siteId);
    if (!target) return;
    target.kid = run.state.kid;
    target.epochFloor = run.state.epochFloor;
    target.wpPk = run.state.wpPk;
    target.pendingRotation = run.state.pendingRotation;
    // §8 observability: stamp the reroll outcome so the operator (and the
    // age-based auto-rotation sweep) can see when this key last rolled and
    // whether it took. Reconciled later from the plugin's own signed value.
    target.lastReroll = { at: new Date().toISOString(), outcome: run.outcome, kid: run.state.kid };
  });

  return {
    outcome: run.outcome,
    kid: run.state.kid,
    wpFingerprint: run.state.wpPk ? wpKeyFingerprint(run.state.wpPk) : null,
  };
}

/**
 * Quarantine cuts the signing path immediately without touching the site;
 * release restores it (only for a link that finished enrollment). Releasing
 * also clears the rejection counter — the operator has judged the incident.
 */
export async function setConnectorQuarantine(site: string, quarantined: boolean): Promise<void> {
  const record = await requireManagedRecord(site);
  await mutateExternalSites((sites) => {
    const target = sites.find((s) => s.siteId === record.siteId);
    if (!target) throw new AddonHttpError("Connector link vanished", 409);
    if (quarantined) {
      if (target.state !== "active") throw new AddonHttpError("Only an active link can be quarantined", 409);
      target.state = "quarantined";
      return;
    }
    if (target.state !== "quarantined") throw new AddonHttpError("Link is not quarantined", 409);
    if (!target.wpPk || !target.fingerprintConfirmed) {
      throw new AddonHttpError("Link never finished enrollment — re-enroll instead of releasing", 409);
    }
    target.state = "active";
    target.rejections = 0;
  });
}

/**
 * Operator re-confirm of a link's identity (§5 clone/identity-crisis). Accepts
 * the observed canonical URL that tripped safe mode as the new binding and clears
 * the suspension — the "yes, this site legitimately moved" path. Rejecting a
 * suspected clone is quarantine or the kill switch, NOT this. Works by siteId so
 * it serves both managed and external links. Returns the newly bound URL for the
 * confirmation toast. Idempotent-ish: refuses when there is no pending alert.
 */
export async function confirmSiteIdentity(
  siteId: string,
  expectedAlertAt: string,
): Promise<{ canonicalUrl?: string }> {
  return mutateExternalSites((sites) => {
    const target = sites.find((s) => s.siteId === siteId);
    if (!target) throw new AddonHttpError("Connector link not found", 404);
    if (!isIdentitySuspended(target) || !target.identityAlert) {
      throw new AddonHttpError("This link has no pending identity alert to confirm", 409);
    }
    // Anti-TOCTOU: bind ONLY the exact alert the operator reviewed. The hourly
    // sweep or a concurrent health-check can supersede `identityAlert` between
    // page load and confirm — with a fresh (possibly attacker-chosen) URL — so
    // confirm the alert's `at` token matches what the client displayed and fail
    // closed otherwise, mirroring the anti-key-overwrite re-checks elsewhere.
    if (target.identityAlert.at !== expectedAlertAt) {
      throw new AddonHttpError(
        "The identity alert changed since you reviewed it — re-review before confirming",
        409,
      );
    }
    const next = confirmIdentity(target);
    target.canonicalUrl = next.canonicalUrl;
    target.identitySuspended = next.identitySuspended;
    target.identityAlert = next.identityAlert;
    return { canonicalUrl: target.canonicalUrl };
  });
}

/**
 * §8 kill switch: tell the plugin to wipe its keys and state (signed
 * site.deactivate), then remove the link record and uninstall the plugin.
 * On a quarantined link the signed send is skipped — we no longer trust the
 * channel — and only the IW side is destroyed.
 */
export async function deactivateConnector(site: string): Promise<{ wiped: boolean }> {
  const record = await requireManagedRecord(site);
  let wiped = false;
  if (record.state === "active" && record.fingerprintConfirmed && record.wpPk) {
    try {
      const pod = await requireRunningPod(site);
      const reply = await callRpc(rpcTransport(record, execDelivery(pod), "exec"), "site.deactivate", {});
      wiped = reply.ok;
    } catch (err) {
      console.warn(
        `[wordpress:iwsl] kill-switch send for ${site} failed (continuing with unlink):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  await unlinkManagedSite(site);
  return { wiped };
}

// ── Maintenance ──────────────────────────────────────────────────────────────

/**
 * Upgrade the Connector in place (`plugin install --force`) without touching
 * link state — `iwsl_` options survive, so keys and epochs stay pinned. Ends
 * with a health.check so the caller sees the running version.
 */
export async function updateConnectorPlugin(site: string): Promise<{ version: string | null }> {
  const record = await requireManagedRecord(site);
  // Pushing plugin code into the pod is state-changing — refuse it while the
  // link is in identity safe mode (§5); the remedy for a suspected clone is
  // quarantine/kill, not a reinstall.
  requireIdentityConfirmed(record);
  const pod = await requireRunningPod(site);
  const pkg = await buildConnectorPackage();
  await execInWpPod(pod, installConnectorScript(), {
    stdin: pkg.zip.toString("base64"),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (record.state !== "active" || !record.fingerprintConfirmed || !record.wpPk) {
    return { version: null };
  }
  const reply = await callRpc(rpcTransport(record, execDelivery(pod), "exec"), "health.check", {});
  const version = typeof reply.result.plugin === "string" ? reply.result.plugin : null;
  if (version) {
    // Persist the freshly-installed version (verified round-trip) so the update
    // badge clears the moment the reinstall lands, without waiting for a sweep.
    // This already rides mutateExternalSites' retry-on-409/transient path, but
    // under a fleet update sweep several sites persist in near-lockstep and can
    // still exhaust that retry budget. A lost persist race must NOT fail an
    // update whose plugin install AND signature-verified health.check already
    // succeeded: the plugin is on-disk and running the new version — only the
    // cached badge lags, and the next health sweep reconciles connectorVersion
    // from the plugin's own signed report. So swallow a persist failure with a
    // warning and still return the verified version (fixes the fleet-sweep 409
    // race that marked good installs as failed).
    try {
      await mutateExternalSites((sites) => {
        const target = sites.find((s) => s.siteId === record.siteId);
        if (target) target.connectorVersion = version;
      });
    } catch (err) {
      console.warn(
        `[wordpress:iwsl] connector-version badge persist for ${site} raced (install OK, reconciles on next health sweep):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { version };
}
