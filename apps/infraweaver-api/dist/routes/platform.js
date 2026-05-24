import { Hono } from "hono";
import { hasPermission } from "../lib/rbac.js";
/**
 * Platform self-update routes.
 *
 * GET  /api/v1/platform/version  — returns current + remote SHA with changelog
 * POST /api/v1/platform/update   — triggers init-VM self-update (cluster:admin)
 *
 * The init VM URL is read from INIT_VM_URL env var (default: http://10.10.0.50:8080).
 * All logic runs on the init VM (scripts/update.sh); this API is a thin proxy.
 */
const INIT_VM_URL = (process.env.INIT_VM_URL ?? "http://10.10.0.50:8080").replace(/\/$/, "");
const route = new Hono();
// ── GET /version ──────────────────────────────────────────────────────────────
route.get("/version", async (c) => {
    try {
        const res = await fetch(`${INIT_VM_URL}/api/platform-version`, {
            signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
            return c.json({ ok: false, error: `Init VM returned ${res.status}` }, 502);
        }
        const data = await res.json();
        return c.json(data);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false, error: `Cannot reach init VM: ${msg}` }, 503);
    }
});
// ── POST /update ──────────────────────────────────────────────────────────────
route.post("/update", async (c) => {
    const user = c.get("user");
    if (!hasPermission(user, "cluster:admin")) {
        return c.json({ ok: false, error: "Forbidden: requires cluster:admin" }, 403);
    }
    try {
        const res = await fetch(`${INIT_VM_URL}/api/self-update`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(300_000),
        });
        const data = await res.json();
        return c.json(data);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false, error: `Cannot reach init VM: ${msg}` }, 503);
    }
});
export { route as platformRoute };
//# sourceMappingURL=platform.js.map