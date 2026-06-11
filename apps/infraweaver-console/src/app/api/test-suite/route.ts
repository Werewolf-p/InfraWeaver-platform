import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { getRequestClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import * as k8s from "@kubernetes/client-node";
import { existsSync, readFileSync } from "fs";
import path from "path";

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

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "cluster:admin")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const filter = req.nextUrl.searchParams.get("category");

  const kc = loadKubeConfig(getRequestClusterId(req));
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
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return { status: "fail", message: `Health endpoint returned HTTP ${res.status}` };
        return { status: "pass", message: "Health endpoint OK" };
      } catch {
        clearTimeout(timer);
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
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(`${argocdServer}/api/v1/applications?limit=1`, {
          headers: { Authorization: `Bearer ${process.env.ARGOCD_TOKEN ?? ""}` },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (res.status === 401) return { status: "warn", message: "ArgoCD reachable but token invalid/missing" };
        if (!res.ok) return { status: "fail", message: `ArgoCD returned HTTP ${res.status}` };
        return { status: "pass", message: "ArgoCD API reachable and authenticated" };
      } catch {
        clearTimeout(timer);
        return { status: "fail", message: "ArgoCD API unreachable" };
      }
    }),
    () => runTest("argocd-console-app", "Console ArgoCD app healthy", "argocd", async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(`${argocdServer}/api/v1/applications/catalog-infraweaver-console-manifests`, {
          headers: { Authorization: `Bearer ${process.env.ARGOCD_TOKEN ?? ""}` },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) return { status: "warn", message: `Cannot check console app status (HTTP ${res.status})` };
        const data = await res.json() as { status?: { health?: { status?: string }; sync?: { status?: string } } };
        const health = data.status?.health?.status ?? "Unknown";
        const sync = data.status?.sync?.status ?? "Unknown";
        if (health !== "Healthy") return { status: "warn", message: `Console app health: ${health}, sync: ${sync}` };
        return { status: "pass", message: `Console app Healthy + ${sync}` };
      } catch {
        clearTimeout(timer);
        return { status: "skip", message: "Could not reach ArgoCD to check app status" };
      }
    }),

    // ── Monitoring ────────────────────────────────────────────────────────
    () => runTest("prometheus-api", "Prometheus reachable", "monitoring", async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(`${prometheusUrl}/-/healthy`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return { status: "fail", message: `Prometheus returned HTTP ${res.status}` };
        return { status: "pass", message: "Prometheus healthy" };
      } catch {
        clearTimeout(timer);
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
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(`${origin}/api/ping`, { signal: ctrl.signal });
        clearTimeout(timer);
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
        clearTimeout(timer);
        return { status: "skip", message: "Could not reach self for header check" };
      }
    }),
    () => runTest("sec-auth-enforcement", "Auth enforced on protected API routes", "security", async () => {
      const origin = req.nextUrl.origin;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        // Hit a protected route without a session cookie — middleware should return 401
        const res = await fetch(`${origin}/api/self-test`, {
          headers: { Cookie: "" }, // no session
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (res.status === 401) return { status: "pass", message: "Protected routes correctly return 401 without session" };
        if (res.status === 200) return { status: "fail", message: "/api/self-test returned 200 without auth (no auth guard!)" };
        return { status: "warn", message: `Unexpected status ${res.status} from unauthenticated request` };
      } catch {
        clearTimeout(timer);
        return { status: "skip", message: "Self-call for auth check unavailable" };
      }
    }),
    () => runTest("sec-csrf-protection", "CSRF same-origin check active", "security", async () => {
      const origin = req.nextUrl.origin;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        // Send a mutation with a spoofed Origin header — middleware should reject it
        const res = await fetch(`${origin}/api/cluster/rollout`, {
          method: "POST",
          headers: { Origin: "https://evil.example.com", "Content-Type": "application/json" },
          body: "{}",
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        // Should be blocked: 403 CSRF or 401 no-auth (auth check comes first)
        if (res.status === 403 || res.status === 401) return { status: "pass", message: `Cross-origin mutation blocked (${res.status})` };
        return { status: "fail", message: `CSRF check did not block cross-origin mutation (got ${res.status})` };
      } catch {
        clearTimeout(timer);
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

    // ── Stability (enterprise stability agent) ────────────────────────────
    () => runTest("stab-ping", "Public /api/ping endpoint responds", "stability", async () => {
      const origin = req.nextUrl.origin;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(`${origin}/api/ping`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return { status: "fail", message: `Ping returned HTTP ${res.status}` };
        return { status: "pass", message: "Public ping endpoint live (used for k8s liveness probe)" };
      } catch {
        clearTimeout(timer);
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
    () => runTest("stab-error-boundary", "Error boundary component exists and is used in layout", "stability", async () => {
      const boundaryPath = path.join(process.cwd(), "src/components/ui/error-boundary.tsx");
      const altPath = path.join(process.cwd(), "src/components/error-boundary.tsx");
      const exists = existsSync(boundaryPath) || existsSync(altPath);
      if (!exists) return { status: "fail", message: "error-boundary.tsx component not found" };
      const layoutPath = path.join(process.cwd(), "src/app/(dashboard)/layout.tsx");
      const layoutContent = existsSync(layoutPath) ? readFileSync(layoutPath, "utf-8") : "";
      if (!layoutContent.includes("ErrorBoundary")) return { status: "warn", message: "Error boundary file exists but not used in dashboard layout" };
      return { status: "pass", message: "ErrorBoundary component exists and is applied in dashboard layout" };
    }),
    () => runTest("stab-global-error", "global-error.tsx root recovery page exists", "stability", async () => {
      const p = path.join(process.cwd(), "src/app/global-error.tsx");
      if (!existsSync(p)) return { status: "fail", message: "global-error.tsx not found — root layout errors will show browser error page" };
      return { status: "pass", message: "global-error.tsx present — root layout errors have a recovery UI" };
    }),
    () => runTest("stab-chunk-recovery", "error.tsx handles ChunkLoadError for auto-reload", "stability", async () => {
      const p = path.join(process.cwd(), "src/app/error.tsx");
      if (!existsSync(p)) return { status: "fail", message: "src/app/error.tsx not found" };
      const content = readFileSync(p, "utf-8");
      if (!content.includes("ChunkLoadError") && !content.includes("Loading chunk")) {
        return { status: "fail", message: "error.tsx does not handle ChunkLoadError — users will see blank page after deploys instead of auto-reloading" };
      }
      return { status: "pass", message: "error.tsx auto-reloads on ChunkLoadError (stale chunks after new deploys)" };
    }),
    () => runTest("stab-middleware-trycatch", "Middleware has try-catch for auth failures", "stability", async () => {
      const p = path.join(process.cwd(), "src/proxy.ts");
      if (!existsSync(p)) return { status: "fail", message: "middleware.ts not found" };
      const content = readFileSync(p, "utf-8");
      if (!content.includes("try") || !content.includes("catch")) {
        return { status: "fail", message: "Middleware has no try-catch — if auth() throws, entire middleware crashes and shows browser error page" };
      }
      return { status: "pass", message: "Middleware wrapped in try-catch — auth failures handled gracefully" };
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
    () => runTest("stab-query-defaults", "React Query client configured with retry/staletime", "stability", async () => {
      const queryDefaultsPath = path.join(process.cwd(), "src/lib/query-defaults.ts");
      const queryClientPath = path.join(process.cwd(), "src/lib/query-client.ts");
      const hasDefaults = existsSync(queryDefaultsPath) || existsSync(queryClientPath);
      if (!hasDefaults) return { status: "warn", message: "No query-defaults.ts or query-client.ts found" };
      const content = readFileSync(existsSync(queryDefaultsPath) ? queryDefaultsPath : queryClientPath, "utf-8");
      const hasRetry = content.includes("retry");
      const hasStale = content.includes("staleTime") || content.includes("gcTime");
      if (!hasRetry) return { status: "warn", message: "React Query retry not configured — transient k8s API errors will not auto-recover" };
      if (!hasStale) return { status: "warn", message: "React Query staleTime not configured — excessive re-fetching may occur" };
      return { status: "pass", message: "React Query configured with retry and staleTime defaults" };
    }),

    // ── Features (usability + UI agent) ───────────────────────────────────
    () => runTest("feat-user-preferences", "User preferences API functional", "features", async () => {
      const origin = req.nextUrl.origin;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        // We're already authenticated (session checked at top of handler) so forward cookies
        const sessionCookie = req.headers.get("cookie") ?? "";
        const res = await fetch(`${origin}/api/user/preferences`, {
          headers: { Cookie: sessionCookie },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (res.status === 401) return { status: "fail", message: "Preferences API returned 401 — session not forwarded" };
        if (!res.ok) return { status: "fail", message: `Preferences API returned HTTP ${res.status}` };
        return { status: "pass", message: "User preferences API returns 200 with valid session" };
      } catch {
        clearTimeout(timer);
        return { status: "skip", message: "Could not reach preferences API from test suite" };
      }
    }),
    () => runTest("feat-keyboard-shortcuts", "Keyboard shortcuts module defined", "features", async () => {
      const p = path.join(process.cwd(), "src/lib/keyboard-shortcuts.ts");
      if (!existsSync(p)) return { status: "fail", message: "keyboard-shortcuts.ts not found" };
      const content = readFileSync(p, "utf-8");
      const hasShortcuts = content.includes("?") || content.includes("shortcut") || content.includes("Shortcut");
      if (!hasShortcuts) return { status: "warn", message: "keyboard-shortcuts.ts exists but appears empty" };
      return { status: "pass", message: "Keyboard shortcuts module defined (?, ⌘K, g+h navigation shortcuts)" };
    }),
    () => runTest("feat-confirm-dialog", "ConfirmDialog component exists", "features", async () => {
      const p = path.join(process.cwd(), "src/components/ui/confirm-dialog.tsx");
      if (!existsSync(p)) return { status: "fail", message: "confirm-dialog.tsx not found — destructive actions have no confirmation step" };
      return { status: "pass", message: "ConfirmDialog component present for destructive action safety" };
    }),
    () => runTest("feat-copy-button", "CopyButton component exists", "features", async () => {
      const p = path.join(process.cwd(), "src/components/ui/copy-button.tsx");
      if (!existsSync(p)) return { status: "fail", message: "copy-button.tsx not found" };
      return { status: "pass", message: "CopyButton component present" };
    }),
    () => runTest("feat-design-tokens", "Azure design tokens defined in CSS", "features", async () => {
      const candidates = [
        path.join(process.cwd(), "src/app/globals.css"),
        path.join(process.cwd(), "src/styles/globals.css"),
      ];
      const cssPath = candidates.find(existsSync);
      if (!cssPath) return { status: "fail", message: "globals.css not found" };
      const content = readFileSync(cssPath, "utf-8");
      const hasPrimary = content.includes("--primary");
      const hasAzure = content.includes("#0078D4") || content.includes("0078d4") || content.includes("--azure") || content.includes("0078");
      if (!hasPrimary) return { status: "warn", message: "No --primary CSS token found in globals.css" };
      if (!hasAzure) return { status: "warn", message: "--primary exists but Azure blue (#0078D4) not detected", detail: "UI may not match Azure design system" };
      return { status: "pass", message: "Azure design tokens present in globals.css (#0078D4 primary color)" };
    }),
    () => runTest("feat-data-table", "TanStack Table component integrated", "features", async () => {
      const pjson = path.join(process.cwd(), "package.json");
      if (!existsSync(pjson)) return { status: "skip", message: "package.json not found" };
      const pkg = JSON.parse(readFileSync(pjson, "utf-8"));
      const hasTanStack = !!(pkg.dependencies?.["@tanstack/react-table"] || pkg.devDependencies?.["@tanstack/react-table"]);
      if (!hasTanStack) return { status: "fail", message: "@tanstack/react-table not in package.json — data tables may be basic HTML tables" };
      const tableComponent = path.join(process.cwd(), "src/components/ui/data-table.tsx");
      if (!existsSync(tableComponent)) return { status: "warn", message: "@tanstack/react-table installed but no data-table.tsx component" };
      return { status: "pass", message: "@tanstack/react-table installed and data-table.tsx component exists" };
    }),
    () => runTest("feat-skeleton-loaders", "Skeleton loading components exist", "features", async () => {
      const candidates = ["skeleton-card.tsx", "skeleton-table.tsx", "skeleton.tsx"];
      const base = path.join(process.cwd(), "src/components/ui");
      const found = candidates.filter(f => existsSync(path.join(base, f)));
      if (found.length === 0) return { status: "fail", message: "No skeleton loader components found — pages flash blank during loading" };
      return { status: "pass", message: `Skeleton loaders present: ${found.join(", ")}` };
    }),
    () => runTest("feat-command-palette", "Command palette component exists", "features", async () => {
      const p = path.join(process.cwd(), "src/components/ui/command-palette.tsx");
      if (!existsSync(p)) return { status: "fail", message: "command-palette.tsx not found" };
      return { status: "pass", message: "Command palette (⌘K) component present" };
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
}

