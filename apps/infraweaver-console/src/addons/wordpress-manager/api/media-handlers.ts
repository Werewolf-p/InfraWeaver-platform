import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { checkRateLimit } from "@/lib/rate-limit";
import { checkSameOrigin } from "@/lib/api-helpers";
import { AddonHttpError } from "../lib/errors";
import { WpPodExecError } from "../lib/k8s-exec";
import { isValidSiteId } from "../lib/naming";
import {
  getWordpressAccessContext,
  hasWordpressPermission,
  type WordpressPermission,
} from "../lib/wordpress-rbac";
import {
  MEDIA_READ_VERBS,
  MEDIA_WRITE_VERBS,
  mediaDeleteParamsSchema,
  mediaEditParamsSchema,
  mediaFolderParamsSchema,
  mediaGetParamsSchema,
  mediaListParamsSchema,
  mediaOffloadParamsSchema,
  mediaOptimizeParamsSchema,
  mediaProtectParamsSchema,
  mediaRestoreParamsSchema,
  mediaUpdateMetaParamsSchema,
  mediaUsageParamsSchema,
  type MediaReadVerb,
  type MediaWriteVerb,
} from "../lib/manage/media";
import {
  deleteMediaAsset,
  editMediaImage,
  getMediaAsset,
  getMediaUsage,
  listMedia,
  mediaFolderOp,
  mediaStatus,
  mediaTree,
  offloadMedia,
  optimizeMedia,
  protectMedia,
  restoreMedia,
  updateMediaMeta,
} from "../lib/iwsl-managed-ops";

/**
 * Dedicated signed-channel API for the fused Media Explorer. Reads (GET:
 * list/tree/status) require `wordpress:read`; writes (POST: optimize/offload/
 * restore/folder) require `wordpress:write`, a same-origin check (CSRF), and
 * leave an audit line. NO unsigned/public endpoint — every verb delegates to a
 * signed `media.*` op that the plugin's verifier enforces (the signed-channel
 * invariant). Same authorize / rate-limit / guard shape as `iwsl-handlers.ts`.
 */

const RATE_WINDOW_MS = 60_000;

function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

function fail(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

async function authorize(
  permission: WordpressPermission,
  site: string,
): Promise<{ ok: true; username: string } | { ok: false; error: NextResponse }> {
  const session = await auth();
  if (!session) return { ok: false, error: fail("Unauthorized", 401) };
  const ctx = await getWordpressAccessContext(session);
  const namespaceWide = hasWordpressPermission(ctx.groups, ctx.username, ctx.roleAssignments, permission, "");
  const scoped = hasWordpressPermission(ctx.groups, ctx.username, ctx.roleAssignments, permission, site);
  if (!namespaceWide && !scoped) return { ok: false, error: fail("Forbidden", 403) };
  return { ok: true, username: ctx.username };
}

function rateLimited(action: string, user: string, max: number): NextResponse | null {
  if (!checkRateLimit(`wordpress:media-${action}:${user || "anon"}`, max, RATE_WINDOW_MS)) {
    return fail("Too many requests — slow down and try again shortly", 429);
  }
  return null;
}

/** Map any thrown error to a stable JSON response (mirrors iwsl-handlers `guard`). */
async function guard(action: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await action();
  } catch (err) {
    console.error("[wordpress:media] handler error:", err instanceof Error ? err.message : err);
    if (err instanceof AddonHttpError) return fail(err.message, err.status);
    if (err instanceof WpPodExecError) {
      return fail("The site's WordPress didn't respond — its pod or database may be briefly unavailable. Retry in a moment.", 502);
    }
    return fail("Media operation failed — check the server logs for details", 500);
  }
}

/** Per-verb rate ceilings. Bulk verbs run as many bounded signed batches, so they are generous. */
const READ_RATE: Record<MediaReadVerb, number> = { list: 120, tree: 60, status: 120, get: 120, usage: 60 };
const WRITE_RATE: Record<MediaWriteVerb, number> = {
  optimize: 240,
  offload: 240,
  restore: 240,
  folder: 60,
  updateMeta: 120,
  edit: 60,
  protect: 120,
  delete: 30,
};

function isReadVerb(v: string): v is MediaReadVerb {
  return (MEDIA_READ_VERBS as readonly string[]).includes(v);
}

function isWriteVerb(v: string): v is MediaWriteVerb {
  return (MEDIA_WRITE_VERBS as readonly string[]).includes(v);
}

/** GET — a read verb (`?read=list|tree|status`). List params ride a JSON `p` query param. */
export async function mediaReadHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  const verb = new URL(req.url).searchParams.get("read") ?? "list";
  if (!isReadVerb(verb)) return fail("Unknown media read", 400);

  const gate = await authorize("wordpress:read", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited(`read-${verb}`, gate.username, READ_RATE[verb]);
  if (limited) return limited;

  return guard(async () => {
    if (verb === "tree") return json(await mediaTree(site));
    if (verb === "status") return json(await mediaStatus(site));
    const raw = new URL(req.url).searchParams.get("p");
    let params: unknown = {};
    if (raw) {
      try {
        params = JSON.parse(raw);
      } catch {
        return fail(`Malformed media.${verb} parameters`, 400);
      }
    }
    if (verb === "get") {
      const parsed = mediaGetParamsSchema.safeParse(params);
      if (!parsed.success) return fail("Invalid media.get parameters", 400);
      return json(await getMediaAsset(site, parsed.data));
    }
    if (verb === "usage") {
      const parsed = mediaUsageParamsSchema.safeParse(params);
      if (!parsed.success) return fail("Invalid media.usage parameters", 400);
      return json(await getMediaUsage(site, parsed.data));
    }
    const parsed = mediaListParamsSchema.safeParse(params);
    if (!parsed.success) return fail("Invalid media.list parameters", 400);
    return json(await listMedia(site, parsed.data));
  });
}

/** POST — a write verb: `{ verb, params }`. RBAC write + same-origin + audit. */
export async function mediaWriteHandler(req: NextRequest, site: string): Promise<NextResponse> {
  if (!isValidSiteId(site)) return fail("Invalid site name", 400);
  // CSRF: a state-changing media op must come from our own origin (fails closed).
  if (!checkSameOrigin(req)) return fail("Bad origin", 403);

  const body = (await req.json().catch(() => null)) as { verb?: unknown; params?: unknown } | null;
  const verb = typeof body?.verb === "string" ? body.verb : "";
  if (!isWriteVerb(verb)) return fail("Unknown media action", 400);

  const gate = await authorize("wordpress:write", site);
  if (!gate.ok) return gate.error;
  const limited = rateLimited(`write-${verb}`, gate.username, WRITE_RATE[verb]);
  if (limited) return limited;

  return guard(async () => {
    switch (verb) {
      case "optimize": {
        const parsed = mediaOptimizeParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid media.optimize parameters", 400);
        const result = await optimizeMedia(site, parsed.data);
        await auditLog("wordpress:media-optimize", gate.username, `site ${site} optimize ${parsed.data.ids.length} asset(s)`, {
          result: "success",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
      case "offload": {
        const parsed = mediaOffloadParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid media.offload parameters", 400);
        const result = await offloadMedia(site, parsed.data);
        await auditLog("wordpress:media-offload", gate.username, `site ${site} ${parsed.data.op} ${parsed.data.ids.length} asset(s)`, {
          result: "success",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
      case "restore": {
        const parsed = mediaRestoreParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid media.restore parameters", 400);
        const result = await restoreMedia(site, parsed.data);
        await auditLog("wordpress:media-restore", gate.username, `site ${site} restore ${parsed.data.ids.length} asset(s)`, {
          result: "success",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
      case "folder": {
        const parsed = mediaFolderParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid media.folder parameters", 400);
        const result = await mediaFolderOp(site, parsed.data);
        await auditLog("wordpress:media-folder", gate.username, `site ${site} folder ${parsed.data.op}`, {
          result: "success",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
      case "updateMeta": {
        const parsed = mediaUpdateMetaParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid media.updateMeta parameters", 400);
        const result = await updateMediaMeta(site, parsed.data);
        await auditLog("wordpress:media-updateMeta", gate.username, `site ${site} edit meta of asset ${parsed.data.id}`, {
          result: "success",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
      case "edit": {
        const parsed = mediaEditParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid media.edit parameters", 400);
        const result = await editMediaImage(site, parsed.data);
        await auditLog("wordpress:media-edit", gate.username, `site ${site} edit image ${parsed.data.id} (${parsed.data.ops.length} op(s))`, {
          result: "success",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
      case "protect": {
        const parsed = mediaProtectParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid media.protect parameters", 400);
        const result = await protectMedia(site, parsed.data);
        await auditLog("wordpress:media-protect", gate.username, `site ${site} ${parsed.data.protected ? "protect" : "unprotect"} ${parsed.data.ids.length} asset(s)`, {
          result: "success",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
      case "delete": {
        // A REAL attachment delete — the destructive verb. The schema fences it on the
        // literal confirm:true; RBAC write + same-origin + audit as every write.
        const parsed = mediaDeleteParamsSchema.safeParse(body?.params);
        if (!parsed.success) return fail("Invalid media.delete parameters", 400);
        const result = await deleteMediaAsset(site, parsed.data);
        await auditLog("wordpress:media-delete", gate.username, `site ${site} DELETE attachment ${parsed.data.id}`, {
          result: "success",
          resource: `wordpress/${site}`,
        });
        return json(result);
      }
    }
  });
}
