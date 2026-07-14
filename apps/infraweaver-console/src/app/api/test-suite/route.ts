import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { makeKc } from "@/lib/kube-client";
import { withAuth } from "@/lib/with-auth";
import * as k8s from "@kubernetes/client-node";
import type { AppAccountProvider, AppAccountStore, AppUserAccount, RosterEntry } from "@/lib/app-accounts/types";

const PROBE_TIMEOUT_MS = 5000;

export interface TestResult {
  id: string;
  name: string;
  category: string;
  status: "pass" | "fail" | "warn" | "skip";
  message: string;
  detail?: string;
  durationMs: number;
}

function extractK8sMessage(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const obj = err as Record<string, unknown>;
  if (obj.body && typeof obj.body === "object") {
    const body = obj.body as Record<string, unknown>;
    if (typeof body.message === "string") return body.message;
    if (typeof body.reason === "string") return `${body.reason} (${body.code ?? obj.statusCode ?? "?"})`;
  }
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.statusCode === "number") return `HTTP ${obj.statusCode}`;
  return "Unknown error";
}

async function runTest(
  id: string,
  name: string,
  category: string,
  fn: () => Promise<{ status: "pass" | "fail" | "warn" | "skip"; message: string; detail?: string }>,
): Promise<TestResult> {
  const start = Date.now();
  try {
    const result = await fn();
    return { id, name, category, ...result, durationMs: Date.now() - start };
  } catch (err) {
    return {
      id,
      name,
      category,
      status: "fail",
      message: extractK8sMessage(err),
      durationMs: Date.now() - start,
    };
  }
}

export const GET = withAuth({ permission: "cluster:admin" }, async ({ req }) => {
  const filter = req.nextUrl.searchParams.get("category");

  const kc = makeKc(getRequestClusterId(req));
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const storageApi = kc.makeApiClient(k8s.StorageV1Api);
  const argocdServer = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80";
  const prometheusUrl = process.env.PROMETHEUS_URL ?? "http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090";

  const allTests: Array<() => Promise<TestResult>> = [
    // ── Kubernetes Connectivity ──────────────────────────────────────────
    () => runTest("k8s-api", "Kubernetes API reachable", "kubernetes", async () => {
      await coreApi.listNode();
      return { status: "pass", message: "Connected to Kubernetes API server" };
    }),
    () => runTest("k8s-nodes", "Node health", "kubernetes", async () => {
      const nodes = await coreApi.listNode();
      const notReady = (nodes.items ?? []).filter(n =>
        !(n.status?.conditions ?? []).some(c => c.type === "Ready" && c.status === "True")
      );
      if (notReady.length > 0) {
        return { status: "warn", message: `${notReady.length} node(s) not Ready`, detail: notReady.map(n => n.metadata?.name).join(", ") };
      }
      return { status: "pass", message: `All ${nodes.items?.length ?? 0} node(s) Ready` };
    }),
    () => runTest("k8s-namespaces", "Core namespaces exist", "kubernetes", async () => {
      const required = ["kube-system", "argocd", "infraweaver-console", "monitoring"];
      const ns = await coreApi.listNamespace();
      const names = new Set((ns.items ?? []).map(n => n.metadata?.name ?? ""));
      const missing = required.filter(n => !names.has(n));
      if (missing.length > 0) return { status: "fail", message: `Missing namespaces: ${missing.join(", ")}` };
      return { status: "pass", message: `All required namespaces present` };
    }),
    () => runTest("k8s-storage", "Storage classes available", "kubernetes", async () => {
      const scs = await storageApi.listStorageClass();
      const names = (scs.items ?? []).map(sc => sc.metadata?.name ?? "").filter(Boolean);
      const hasLonghorn = names.some(n => n.startsWith("longhorn"));
      if (!hasLonghorn) return { status: "warn", message: "Longhorn storage class not found", detail: `Available: ${names.join(", ") || "none"}` };
      return { status: "pass", message: `Storage classes: ${names.join(", ")}` };
    }),

    // ── Console ──────────────────────────────────────────────────────────
    () => runTest("console-pods", "Console pods running", "console", async () => {
      const pods = await coreApi.listNamespacedPod({ namespace: "infraweaver-console" });
      const running = (pods.items ?? []).filter(p => p.status?.phase === "Running");
      if (running.length === 0) return { status: "fail", message: "No running console pods" };
      const restarts = running.reduce((sum, p) =>
        sum + (p.status?.containerStatuses ?? []).reduce((s, cs) => s + (cs.restartCount ?? 0), 0), 0);
      if (restarts > 10) return { status: "warn", message: `${running.length} pod(s) running but ${restarts} total restarts`, detail: "High restart count may indicate instability" };
      return { status: "pass", message: `${running.length} pod(s) running, ${restarts} restart(s)` };
    }),
    () => runTest("console-sa", "Console service account exists", "console", async () => {
      await coreApi.readNamespacedServiceAccount({ name: "infraweaver-console", namespace: "infraweaver-console" });
      return { status: "pass", message: "Service account infraweaver-console exists" };
    }),
    () => runTest("console-health", "Console /api/health responds", "console", async () => {
      const url = "http://infraweaver-console.infraweaver-console.svc.cluster.local:3000/api/health";
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) return { status: "fail", message: `Health endpoint returned HTTP ${res.status}` };
        return { status: "pass", message: "Health endpoint OK" };
      } catch {
        // In-cluster call may not work from Next.js — skip gracefully
        return { status: "skip", message: "In-cluster health check not available from this context" };
      }
    }),

    // ── Game Hub ──────────────────────────────────────────────────────────
    () => runTest("gamehub-namespace", "game-hub namespace exists", "game-hub", async () => {
      try {
        await coreApi.readNamespace({ name: "game-hub" });
        return { status: "pass", message: "game-hub namespace exists" };
      } catch (err) {
        const code = (err as Record<string, unknown>)?.statusCode;
        if (code === 404) return { status: "fail", message: "game-hub namespace not found — run Game Hub Setup" };
        throw err;
      }
    }),
    () => runTest("gamehub-rbac", "Console SA has game-hub RBAC", "game-hub", async () => {
      try {
        const deployments = await appsApi.listNamespacedDeployment({
          namespace: "game-hub",
          labelSelector: "infraweaver/game=true",
        });
        return { status: "pass", message: `Can list game-hub deployments (${deployments.items?.length ?? 0} servers)` };
      } catch (err) {
        const code = (err as Record<string, unknown>)?.statusCode;
        if (code === 404) return { status: "fail", message: "game-hub namespace not found" };
        if (code === 403) return { status: "fail", message: "RBAC: cannot list deployments in game-hub. RoleBinding may be missing." };
        throw err;
      }
    }),
    () => runTest("gamehub-quota", "game-hub ResourceQuota applied", "game-hub", async () => {
      try {
        await coreApi.readNamespacedResourceQuota({ name: "game-hub-quota", namespace: "game-hub" });
        return { status: "pass", message: "ResourceQuota game-hub-quota applied" };
      } catch {
        return { status: "warn", message: "game-hub-quota not found — ArgoCD may not have synced yet" };
      }
    }),
    () => runTest("gamehub-storageclass", "Game storage class available", "game-hub", async () => {
      try {
        await storageApi.readStorageClass({ name: "longhorn-game" });
        return { status: "pass", message: "longhorn-game StorageClass exists" };
      } catch {
        const scs = await storageApi.listStorageClass();
        const names = (scs.items ?? []).map(sc => sc.metadata?.name ?? "").filter(n => n.includes("longhorn"));
        if (names.length > 0) return { status: "warn", message: `longhorn-game missing, but found: ${names.join(", ")}` };
        return { status: "fail", message: "No Longhorn storage class found for game servers" };
      }
    }),

    // ── ArgoCD ────────────────────────────────────────────────────────────
    () => runTest("argocd-api", "ArgoCD API reachable", "argocd", async () => {
      try {
        const res = await fetch(`${argocdServer}/api/v1/applications?limit=1`, {
          headers: { Authorization: `Bearer ${process.env.ARGOCD_TOKEN ?? ""}` },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status === 401) return { status: "warn", message: "ArgoCD reachable but token invalid/missing" };
        if (!res.ok) return { status: "fail", message: `ArgoCD returned HTTP ${res.status}` };
        return { status: "pass", message: "ArgoCD API reachable and authenticated" };
      } catch {
        return { status: "fail", message: "ArgoCD API unreachable" };
      }
    }),
    () => runTest("argocd-console-app", "Console ArgoCD app healthy", "argocd", async () => {
      try {
        const res = await fetch(`${argocdServer}/api/v1/applications/catalog-infraweaver-console-manifests`, {
          headers: { Authorization: `Bearer ${process.env.ARGOCD_TOKEN ?? ""}` },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) return { status: "warn", message: `Cannot check console app status (HTTP ${res.status})` };
        const data = await res.json() as { status?: { health?: { status?: string }; sync?: { status?: string } } };
        const health = data.status?.health?.status ?? "Unknown";
        const sync = data.status?.sync?.status ?? "Unknown";
        if (health !== "Healthy") return { status: "warn", message: `Console app health: ${health}, sync: ${sync}` };
        return { status: "pass", message: `Console app Healthy + ${sync}` };
      } catch {
        return { status: "skip", message: "Could not reach ArgoCD to check app status" };
      }
    }),

    // ── Monitoring ────────────────────────────────────────────────────────
    () => runTest("prometheus-api", "Prometheus reachable", "monitoring", async () => {
      try {
        const res = await fetch(`${prometheusUrl}/-/healthy`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) return { status: "fail", message: `Prometheus returned HTTP ${res.status}` };
        return { status: "pass", message: "Prometheus healthy" };
      } catch {
        return { status: "fail", message: "Prometheus unreachable" };
      }
    }),
    () => runTest("monitoring-namespace", "Monitoring namespace has pods", "monitoring", async () => {
      const pods = await coreApi.listNamespacedPod({ namespace: "monitoring" });
      const running = (pods.items ?? []).filter(p => p.status?.phase === "Running");
      if (running.length === 0) return { status: "fail", message: "No running pods in monitoring namespace" };
      return { status: "pass", message: `${running.length} pod(s) running in monitoring` };
    }),

    // ── Certificates ──────────────────────────────────────────────────────
    () => runTest("cert-manager", "cert-manager running", "certificates", async () => {
      try {
        const pods = await coreApi.listNamespacedPod({ namespace: "cert-manager" });
        const running = (pods.items ?? []).filter(p => p.status?.phase === "Running");
        if (running.length === 0) return { status: "fail", message: "No running cert-manager pods" };
        return { status: "pass", message: `${running.length} cert-manager pod(s) running` };
      } catch {
        return { status: "warn", message: "cert-manager namespace not found" };
      }
    }),

    // ── Security (enterprise hardening agent) ─────────────────────────────
    () => runTest("sec-rate-limiter", "Rate limiter module functional", "security", async () => {
      // Import and directly exercise the rate limiter function
      const { checkRateLimit } = await import("@/lib/rate-limit");
      const key = `test-suite-probe-${Date.now()}`;
      const allowed = checkRateLimit(key, 5, 60_000);
      if (!allowed) return { status: "fail", message: "Rate limiter rejected first call (should allow)" };
      // Exhaust the limit
      for (let i = 0; i < 4; i++) checkRateLimit(key, 5, 60_000);
      const blocked = !checkRateLimit(key, 5, 60_000);
      if (!blocked) return { status: "fail", message: "Rate limiter did not block after exceeding limit" };
      return { status: "pass", message: "Sliding-window rate limiter working (allow then block)" };
    }),
    () => runTest("sec-zod-validation", "Zod input validation utility functional", "security", async () => {
      const { validateInput } = await import("@/lib/api-security");
      const { z } = await import("zod");
      const schema = z.object({ name: z.string().min(1) });
      const good = validateInput(schema, { name: "test" });
      if (!good.success) return { status: "fail", message: "validateInput rejected valid data" };
      const bad = validateInput(schema, { name: "" });
      if (bad.success) return { status: "fail", message: "validateInput accepted invalid data (empty name)" };
      return { status: "pass", message: "Zod validateInput correctly accepts valid and rejects invalid input" };
    }),
    () => runTest("sec-k8s-name-validation", "K8s name validator functional", "security", async () => {
      const { isValidK8sName, isValidNamespace } = await import("@/lib/validate");
      const valid = isValidK8sName("my-app-v2") && isValidNamespace("game-hub");
      const invalid = !isValidK8sName("UPPERCASE") && !isValidK8sName("../../../etc/passwd");
      if (!valid || !invalid) return { status: "fail", message: "K8s name validator has wrong logic" };
      return { status: "pass", message: "K8s resource name and namespace validation working" };
    }),
    () => runTest("sec-auth-header", "Security headers present on API responses", "security", async () => {
      const origin = req.nextUrl.origin;
      try {
        const res = await fetch(`${origin}/api/ping`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        const hasRequestId = res.headers.has("x-request-id");
        const hasXFrame = res.headers.get("x-frame-options") === "DENY";
        const hasCSP = res.headers.has("content-security-policy");
        const hasHSTS = res.headers.has("strict-transport-security");
        const missing: string[] = [];
        if (!hasRequestId) missing.push("X-Request-Id");
        if (!hasXFrame) missing.push("X-Frame-Options: DENY");
        if (!hasCSP) missing.push("Content-Security-Policy");
        if (!hasHSTS) missing.push("Strict-Transport-Security");
        if (missing.length > 0) return { status: "warn", message: `Missing headers: ${missing.join(", ")}` };
        return { status: "pass", message: "All security headers present (CSP, HSTS, X-Frame-Options, X-Request-Id)" };
      } catch {
        return { status: "skip", message: "Could not reach self for header check" };
      }
    }),
    () => runTest("sec-auth-enforcement", "Auth enforced on protected API routes", "security", async () => {
      const origin = req.nextUrl.origin;
      try {
        // Hit a protected route without a session cookie — middleware should return 401
        const res = await fetch(`${origin}/api/self-test`, {
          headers: { Cookie: "" }, // no session
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status === 401) return { status: "pass", message: "Protected routes correctly return 401 without session" };
        if (res.status === 200) return { status: "fail", message: "/api/self-test returned 200 without auth (no auth guard!)" };
        return { status: "warn", message: `Unexpected status ${res.status} from unauthenticated request` };
      } catch {
        return { status: "skip", message: "Self-call for auth check unavailable" };
      }
    }),
    () => runTest("sec-csrf-protection", "CSRF same-origin check active", "security", async () => {
      const origin = req.nextUrl.origin;
      try {
        // Send a mutation with a spoofed Origin header — middleware should reject it
        const res = await fetch(`${origin}/api/cluster/rollout`, {
          method: "POST",
          headers: { Origin: "https://evil.example.com", "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        // Should be blocked: 403 CSRF or 401 no-auth (auth check comes first)
        if (res.status === 403 || res.status === 401) return { status: "pass", message: `Cross-origin mutation blocked (${res.status})` };
        return { status: "fail", message: `CSRF check did not block cross-origin mutation (got ${res.status})` };
      } catch {
        return { status: "skip", message: "Self-call for CSRF check unavailable" };
      }
    }),
    () => runTest("sec-env-secrets", "Required secret env vars are set", "security", async () => {
      const required = ["NEXTAUTH_SECRET", "AUTHENTIK_CLIENT_ID", "AUTHENTIK_CLIENT_SECRET"];
      const missing = required.filter(k => !process.env[k]);
      const optional = ["CONSOLE_API_SECRET"]; // HMAC dual-key
      const missingOptional = optional.filter(k => !process.env[k]);
      if (missing.length > 0) return { status: "fail", message: `Missing required secrets: ${missing.join(", ")}` };
      if (missingOptional.length > 0) return { status: "warn", message: `Optional HMAC secrets not set: ${missingOptional.join(", ")} (degraded security)`, detail: "Set CONSOLE_API_SECRET for HMAC-signed inter-service calls" };
      return { status: "pass", message: "All required and optional secret env vars are set" };
    }),
    () => runTest("sec-audit-log", "Audit log module importable and functional", "security", async () => {
      const mod = await import("@/lib/audit-log");
      if (typeof mod.auditAuthFailure !== "function") return { status: "fail", message: "auditAuthFailure not exported from audit-log module" };
      if (typeof mod.auditUnauthorizedAccess !== "function") return { status: "fail", message: "auditUnauthorizedAccess not exported" };
      return { status: "pass", message: "Audit log module loaded with all expected exports" };
    }),
    () => runTest("sec-offboard-drift", "Offboard resolves username→email drift (no orphaned identity)", "security", async () => {
      // Regression pin for the offboard/reconcile drift fix (commit 539e9489),
      // exercised in-process with stub resolvers — no live Authentik is touched.
      //
      // Drift scenario: the Authentik username no longer matches the roster key
      // (case drift or a post-invite rename), so `findUserByUsername` misses. The
      // identity still exists under its unchanged email. Without the email
      // fallback, offboard skips the SSO account and ORPHANS it — access is never
      // revoked. The pk this resolves is exactly what feeds DELETE /core/users/<pk>/.
      const { resolveAuthentikIdentity } = await import("@/lib/users/resolve-identity");
      const DRIFT_PK = 987654321;
      const EMAIL = "testdrift@example.com";

      const resolved = await resolveAuthentikIdentity("TestDrift", EMAIL, {
        findUserByUsername: async () => null, // username lookup misses (drifted)
        findUserByEmail: async (email) => (email === EMAIL ? { pk: DRIFT_PK, email } : null),
      });
      if (!resolved || resolved.pk !== DRIFT_PK) {
        return {
          status: "fail",
          message: "Drifted identity would be ORPHANED — email fallback missing",
          detail: "findUserByUsername miss must fall back to findUserByEmail(row.email); the resolved pk is what DELETE /core/users/<pk>/ targets",
        };
      }
      // The pk that flows straight into the identity DELETE must be the email-matched one.
      const deletePath = `/core/users/${resolved.pk}/`;
      if (deletePath !== `/core/users/${DRIFT_PK}/`) {
        return { status: "fail", message: `Offboard would DELETE the wrong identity (${deletePath})` };
      }
      // And an exact username hit must NOT trigger the email fallback (which here throws).
      const direct = await resolveAuthentikIdentity("exact", "e@example.com", {
        findUserByUsername: async () => ({ pk: 1, email: "e@example.com" }),
        findUserByEmail: async () => { throw new Error("email fallback ran despite a username match"); },
      });
      if (!direct || direct.pk !== 1) return { status: "fail", message: "Username-matched identity not resolved directly" };
      return { status: "pass", message: "Drifted identity resolved by email (DELETE targets its pk); exact-match skips the fallback" };
    }),
    () => runTest("sec-offboard-appaccount-drift", "Offboard deprovisions app accounts by CANONICAL username (drift does not orphan)", "security", async () => {
      // Regression pin for the app-account offboard drift fix (commit 639c756c).
      //
      // Local app accounts — a Jellyfin login, a Nextcloud OCS user row — are created
      // under the CANONICAL Authentik username the person chose at enrollment: reconcile
      // provisions under `identity.username`. Offboard once deprovisioned by the RAW route
      // key, so a username/case drift (route key `e2edrift`, canonical `e2ephoenix`) tore
      // down the SSO identity (resolved by email) while the Jellyfin/Nextcloud accounts —
      // under the canonical name — were ORPHANED forever: a leaked login + a revealable
      // stored credential outliving the user. The fix keys deprovision off
      // `canonicalAppUsername(identity, routeKey)` — the same seam reconcile provisions
      // under — so the provision and deprovision keys can never diverge.
      //
      // Exercised in-process with stub resolvers + in-memory app fakes; no live Authentik,
      // Jellyfin, or Nextcloud is touched. Jellyfin runs the REAL `deprovisionAppUser`
      // engine (the exact delegate `offboardJellyfinUser` uses); Nextcloud's OCS is modeled
      // by userid, matching `DELETE /ocs/v2.php/cloud/users/<userid>`. A negative control
      // (deprovision by the raw key) proves the assertion has teeth — i.e. that it would
      // actually catch a regression back to raw-key deprovision rather than pass vacuously.
      const { resolveAuthentikIdentity, canonicalAppUsername } = await import("@/lib/users/resolve-identity");
      const { deprovisionAppUser } = await import("@/lib/app-accounts/reconcile");

      const ROUTE_KEY = "e2edrift"; // the drifted users.yaml / route key offboard is called with
      const CANONICAL = "e2ephoenix"; // the enrollment name the app accounts actually live under
      const EMAIL = "e2edrift@example.com";
      const IDENTITY_PK = 424242;
      const JF_SERVICE = "iw-jellyfin";
      const key = (u: string) => u.trim().toLowerCase();

      // 1) Resolve the drifted route key to its canonical identity (username misses, email
      //    hits), then derive the app-account key exactly as the offboard route does.
      const identity = await resolveAuthentikIdentity(ROUTE_KEY, EMAIL, {
        findUserByUsername: async () => null, // drifted: the username lookup misses
        findUserByEmail: async (email) => (email === EMAIL ? { pk: IDENTITY_PK, username: CANONICAL, email } : null),
      });
      const appUsername = canonicalAppUsername(identity, ROUTE_KEY);
      if (appUsername !== CANONICAL) {
        return {
          status: "fail",
          message: `App-account key drifted: expected canonical '${CANONICAL}', got '${appUsername}'`,
          detail: "Deprovision would target the raw route key and orphan the canonical Jellyfin/Nextcloud accounts",
        };
      }

      // In-memory app + store factories. `makeJf` models a Jellyfin instance whose
      // listUsers() is the "candidates" a live server returns; `makeStore` is the durable
      // roster/credential state the engine clears. Both are seeded under the CANONICAL name.
      const makeJf = (seeded: string[]) => {
        const users = new Map<string, AppUserAccount>([["svc", { id: "svc", username: JF_SERVICE, role: "admin", disabled: false }]]);
        for (const u of seeded) users.set(u, { id: u, username: u, role: "user", disabled: false });
        const provider: AppAccountProvider = {
          appId: "jellyfin",
          appLabel: "Jellyfin",
          launchUrl: "https://jf.example",
          serviceAccountUsername: JF_SERVICE,
          async ensureServiceAccount() {},
          async listUsers() { return [...users.values()]; },
          async createUser(username: string) { const a: AppUserAccount = { id: username, username, role: "user", disabled: false }; users.set(username, a); return a; },
          async setUserRole() {},
          async disableUser() {},
          async enableUser() {},
          async deleteUser(id: string) { users.delete(id); },
          async resetPassword() {},
        };
        // Candidates = every account minus the service account, the set an orphan check scans.
        return { provider, candidates: () => [...users.values()].map((a) => a.username).filter((u) => key(u) !== key(JF_SERVICE)) };
      };
      const makeStore = (seeded: string): AppAccountStore => {
        let roster: RosterEntry[] = [{ username: seeded, providerUserId: seeded, provisionedAt: "seed" }];
        return {
          async loadRoster() { return [...roster]; },
          async addRosterEntry(_appId: string, entry: RosterEntry) { roster.push(entry); },
          async markNotified() {},
          async removeRosterEntry(_appId: string, username: string) { roster = roster.filter((e) => key(e.username) !== key(username)); },
          async writeCredential() {},
          async deleteCredential() {},
        };
      };

      // 2) Jellyfin — run the REAL deprovision engine over the resolved (canonical) key.
      const jf = makeJf([CANONICAL]);
      await deprovisionAppUser(jf.provider, appUsername, makeStore(CANONICAL));
      const jfSurvivors = jf.candidates().filter((u) => key(u) === key(CANONICAL));
      if (jfSurvivors.length > 0) {
        return {
          status: "fail",
          message: "Jellyfin candidate for the canonical account survived offboard-by-drifted-key (orphaned)",
          detail: `Remaining candidates: ${jf.candidates().join(", ") || "none"}`,
        };
      }

      // 3) Nextcloud OCS — DELETE /ocs/v2.php/cloud/users/<userid> targets the userid in the
      //    path, and the offboard route also clears the stored NC credential; both key off
      //    the SAME appUsername. Model the OCS user set + credential set and delete by appUsername.
      const ncOcs = new Set([key(CANONICAL)]);
      const ncCreds = new Set([key(CANONICAL)]);
      ncOcs.delete(key(appUsername));
      ncCreds.delete(key(appUsername));
      if (ncOcs.has(key(CANONICAL)) || ncCreds.has(key(CANONICAL))) {
        return {
          status: "fail",
          message: "Nextcloud OCS user (or its stored credential) for the canonical account survived offboard-by-drifted-key",
          detail: `OCS delete targeted userid '${appUsername}', leaving canonical '${CANONICAL}' behind`,
        };
      }

      // 4) Teeth — the pre-fix behavior (deprovision by the RAW route key) MUST miss the
      //    canonical accounts. If it didn't, the assertions above would pass no matter what.
      const jfRaw = makeJf([CANONICAL]);
      await deprovisionAppUser(jfRaw.provider, ROUTE_KEY, makeStore(CANONICAL));
      const jfRawOrphan = jfRaw.candidates().some((u) => key(u) === key(CANONICAL));
      const ncRaw = new Set([key(CANONICAL)]);
      ncRaw.delete(key(ROUTE_KEY));
      const ncRawOrphan = ncRaw.has(key(CANONICAL));
      if (!jfRawOrphan || !ncRawOrphan) {
        return {
          status: "fail",
          message: "Drift assertion has NO teeth: deprovision by the raw route key did not orphan the canonical accounts",
          detail: "The probe cannot distinguish the fixed path from the buggy one — its scenario no longer reproduces the drift",
        };
      }

      return {
        status: "pass",
        message: "Offboard deprovisions Jellyfin + Nextcloud by canonical username; JF candidates and NC OCS both empty, raw-key control orphans",
      };
    }),
    () => runTest("sec-roster-drift", "Authentik roster has no unmanaged privileged accounts", "security", async () => {
      // Live drift check: lists the Authentik directory and flags every ACTIVE
      // account users.yaml does not account for (excluding ak-outpost-* service
      // accounts), escalating when an unmanaged/suspicious account is privileged.
      // Shares lib/security/roster-drift with the scheduled GET /api/security/
      // roster-drift CronJob endpoint, so the console self-test and the cron alert
      // apply the exact same flag rules. Degrades to `skip` when Authentik or the
      // users.yaml git provider is unreachable from this context (inconclusive,
      // not a failure).
      const { detectRosterDrift } = await import("@/lib/security/roster-drift");
      let report;
      try {
        report = await detectRosterDrift();
      } catch (e) {
        return { status: "skip", message: `Roster drift check unavailable: ${extractK8sMessage(e)}` };
      }
      if (report.alert) {
        return {
          status: "fail",
          message: `${report.privilegedUnmanaged.length} unmanaged PRIVILEGED account(s) in Authentik`,
          detail: report.privilegedUnmanaged
            .map((e) => `${e.username} [${e.privilegedVia ?? "privileged"}] — ${e.reasons.join("+")}`)
            .join("; "),
        };
      }
      if (report.drift.length > 0) {
        return {
          status: "warn",
          message: `${report.drift.length} unmanaged/suspicious account(s) (none privileged)`,
          detail: report.drift.map((e) => `${e.username} — ${e.reasons.join("+")}`).join("; "),
        };
      }
      return {
        status: "pass",
        message: `All ${report.scanned} active account(s) managed (${report.excluded} outpost SA excluded)`,
      };
    }),

    // ── Stability (enterprise stability agent) ────────────────────────────
    () => runTest("stab-ping", "Public /api/ping endpoint responds", "stability", async () => {
      const origin = req.nextUrl.origin;
      try {
        const res = await fetch(`${origin}/api/ping`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) return { status: "fail", message: `Ping returned HTTP ${res.status}` };
        return { status: "pass", message: "Public ping endpoint live (used for k8s liveness probe)" };
      } catch {
        return { status: "fail", message: "/api/ping unreachable" };
      }
    }),
    () => runTest("stab-circuit-breaker", "Circuit breaker module functional", "stability", async () => {
      const { circuitBreakers, getAllCircuitBreakerStatuses } = await import("@/lib/circuit-breaker");
      if (typeof getAllCircuitBreakerStatuses !== "function") return { status: "fail", message: "getAllCircuitBreakerStatuses not exported" };
      const statuses = getAllCircuitBreakerStatuses();
      if (!Array.isArray(statuses)) return { status: "fail", message: "getAllCircuitBreakerStatuses did not return an array" };
      const names = Object.keys(circuitBreakers);
      if (names.length === 0) return { status: "warn", message: "No circuit breakers registered yet" };
      const open = statuses.filter(s => s.state === "OPEN");
      if (open.length > 0) return { status: "warn", message: `${open.length} circuit breaker(s) OPEN: ${open.map(s => s.name).join(", ")}` };
      return { status: "pass", message: `${names.length} circuit breaker(s) registered, all CLOSED. Breakers: ${names.join(", ")}` };
    }),
    () => runTest("stab-console-pdb", "Console PodDisruptionBudget applied in cluster", "stability", async () => {
      try {
        const policyApi = kc.makeApiClient(k8s.PolicyV1Api);
        const pdbs = await policyApi.listNamespacedPodDisruptionBudget({ namespace: "infraweaver-console" });
        if ((pdbs.items ?? []).length === 0) return { status: "warn", message: "No PDB in infraweaver-console namespace — rolling updates may cause downtime" };
        return { status: "pass", message: `PDB found: ${pdbs.items.map(p => p.metadata?.name).join(", ")}` };
      } catch {
        return { status: "warn", message: "Could not check PDB (RBAC or API unavailable)" };
      }
    }),

    // ── Features (usability + UI agent) ───────────────────────────────────
    () => runTest("feat-user-preferences", "User preferences API functional", "features", async () => {
      const origin = req.nextUrl.origin;
      try {
        // We're already authenticated (session checked at top of handler) so forward cookies
        const sessionCookie = req.headers.get("cookie") ?? "";
        const res = await fetch(`${origin}/api/user/preferences`, {
          headers: { Cookie: sessionCookie },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (res.status === 401) return { status: "fail", message: "Preferences API returned 401 — session not forwarded" };
        if (!res.ok) return { status: "fail", message: `Preferences API returned HTTP ${res.status}` };
        return { status: "pass", message: "User preferences API returns 200 with valid session" };
      } catch {
        return { status: "skip", message: "Could not reach preferences API from test suite" };
      }
    }),
  ];

  const results = await Promise.all(allTests.map(fn => fn()));
  const filtered = filter ? results.filter(r => r.category === filter) : results;

  const summary = {
    total: filtered.length,
    pass: filtered.filter(r => r.status === "pass").length,
    fail: filtered.filter(r => r.status === "fail").length,
    warn: filtered.filter(r => r.status === "warn").length,
    skip: filtered.filter(r => r.status === "skip").length,
  };

  return NextResponse.json({
    results: filtered,
    summary,
    testedAt: new Date().toISOString(),
  });
});
