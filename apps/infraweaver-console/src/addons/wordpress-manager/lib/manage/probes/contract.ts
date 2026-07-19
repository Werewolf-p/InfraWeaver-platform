/**
 * The contract every Manage-panel probe implements. A probe is the secure,
 * read-only data source for one panel: given a running-pod exec handle and the
 * site's resolved capabilities, it returns that panel's typed data by running
 * `wp-cli`/shell batches in the container (or reading the signed Connector link).
 *
 * Isomorphic types only here — no `server-only`, no Node — so panel components
 * can import the data types. The concrete probes (which DO exec) live alongside
 * and are wired by lib/manage/panel-data.ts.
 */
import type { ExternalSiteView } from "../../iwsl-enrollment";
import type { ManageCapabilityId, ManagePanelId } from "../capabilities";

/** Exec signature a probe uses — the addon's secure in-pod command runner. */
export type PodExec = (
  script: string,
  opts?: { stdin?: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Everything a probe needs to gather its panel's data. */
export interface PanelProbeContext {
  readonly site: string;
  /** Name of the site's running WordPress pod. */
  readonly pod: string;
  /** Run a command inside the site's WordPress container (secure exec path). */
  readonly exec: PodExec;
  /** The site's resolved capabilities (same set the tab strip gated on). */
  readonly capabilities: Record<ManageCapabilityId, boolean>;
  /** The managed Connector link view, or null when the site is not enrolled. */
  readonly managed: ExternalSiteView | null;
}

/**
 * A panel's data source. `requiresCapability`, when set, is enforced by the
 * dispatcher BEFORE `fetch` runs — a request for a gated panel on a site that
 * lacks the capability is refused, never answered with empty data.
 */
export interface PanelProbe<T = unknown> {
  readonly id: ManagePanelId;
  readonly requiresCapability?: ManageCapabilityId;
  fetch(ctx: PanelProbeContext): Promise<T>;
}
