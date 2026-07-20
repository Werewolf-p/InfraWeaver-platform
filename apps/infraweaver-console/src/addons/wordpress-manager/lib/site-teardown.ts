import "server-only";
import { AddonHttpError } from "./errors";
import { assertValidSiteId } from "./naming";
import { deleteSite } from "./provision";
import { purgeConnectorEnrollment } from "./iwsl-managed-ops";
import { getManagedLink } from "./iwsl-managed";
import { deleteExternalSite } from "./iwsl-enrollment";
import { runStep, teardownOk, type TeardownStep } from "./teardown-step";

/**
 * §12.6 — full "Delete WordPress site" teardown. Where `deleteSite` scrubs the
 * cluster/DNS/secret resources, this is the ordered orchestrator that ALSO tears
 * down the connector link so a deleted site leaves no orphan:
 *
 *   a. purge the plugin's own `iwsl_*` enrollment state over the SIGNED command
 *      channel FIRST, while the pod is still reachable (best-effort, logged);
 *   b–e. delete the Deployments/Services, PVCs (storage), k8s + OpenBao secrets,
 *      and DNS via `deleteSite`;
 *   f. remove the site's link record from the `infraweaver-iwsl-sites` ConfigMap.
 *
 * Every step is idempotent (already-absent ⇒ `skipped`) and partial-failure
 * tolerant (a thrown delete ⇒ `failed`, the rest still run), so the result is a
 * complete removed/skipped/failed ledger and the whole flow is safe to re-run
 * until nothing is left to remove. The signed purge deliberately runs before the
 * pod is deleted; the link-record removal runs last so a mid-flight failure of
 * b–e can still be retried with the link (and thus the purge) intact.
 */
export interface SiteTeardownResult {
  site: string;
  /** True when no step failed — the site is fully gone. */
  ok: boolean;
  steps: TeardownStep[];
}

export async function teardownSite(site: string): Promise<SiteTeardownResult> {
  assertValidSiteId(site);
  const steps: TeardownStep[] = [];

  // (a) Signed plugin purge — FIRST, so the pod is still up to answer.
  steps.push(
    await runStep("connector-purge", async () => {
      const result = await purgeConnectorEnrollment(site);
      if (result.purged) return { status: "removed", detail: "plugin iwsl_* state scrubbed over the signed channel" };
      if (result.skipped) return { status: "skipped", detail: result.skipped };
      return { status: "failed", detail: "plugin did not acknowledge the signed purge" };
    }),
  );

  // (b–e) Cluster + DNS + secrets. `deleteSite` returns its own per-resource
  // steps and never throws per resource; guard the whole call so a hard failure
  // (e.g. no kubeconfig) still surfaces as one failed step instead of aborting.
  try {
    steps.push(...(await deleteSite(site)));
  } catch (err) {
    steps.push({ step: "cluster-teardown", status: "failed", detail: err instanceof Error ? err.message : String(err) });
  }

  // (f) Remove the console link record from the ConfigMap registry — LAST, so
  // steps b–e stay retryable with the purge target intact if any of them failed.
  steps.push(
    await runStep("link-record", async () => {
      const link = await getManagedLink(site);
      if (!link) return { status: "skipped", detail: "no connector link record" };
      try {
        await deleteExternalSite(link.siteId);
        return { status: "removed", detail: "removed from infraweaver-iwsl-sites ConfigMap" };
      } catch (err) {
        // A concurrent removal (record already gone) is an idempotent success.
        if (err instanceof AddonHttpError && err.status === 404) {
          return { status: "skipped", detail: "link record already gone" };
        }
        throw err;
      }
    }),
  );

  return { site, ok: teardownOk(steps), steps };
}
