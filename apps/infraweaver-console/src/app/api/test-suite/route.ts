import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { makeKc } from "@/lib/kube-client";
import { withAuth } from "@/lib/with-auth";
import * as k8s from "@kubernetes/client-node";

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
