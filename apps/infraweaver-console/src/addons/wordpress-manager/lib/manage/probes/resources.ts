/**
 * Server Resources panel probe — the site's runtime footprint read from
 * Kubernetes (the pods behind the site) plus a small batch of in-container reads
 * (PHP memory limit, CPU count, container RAM + content-disk usage). No wp-cli
 * bootstrap: the pod facts come from the cluster, the runtime facts from a plain
 * shell batch, so this stays honest about what the container can actually report.
 */
import { listSitePods } from "../../provision";
import type { SitePod } from "../../site-pods";
import { parseKv, toInt, toStr } from "../wp-probe";
import type { PanelProbe, PanelProbeContext } from "./contract";

/** Live runtime facts read from inside the WordPress container. */
export interface ResourcesRuntime {
  /** `php.ini` memory_limit as reported by PHP (e.g. "512M"), or null. */
  readonly phpMemoryLimit: string | null;
  /** Visible CPUs (`nproc`) inside the container, or null. */
  readonly cpuCount: number | null;
  readonly memTotalMb: number | null;
  readonly memUsedMb: number | null;
  readonly diskTotalMb: number | null;
  readonly diskUsedMb: number | null;
}

export interface ResourcesData {
  /** The pods backing this site (WordPress + database), from the cluster. */
  readonly pods: readonly SitePod[];
  readonly runtime: ResourcesRuntime;
}

/** Split a `total/used` probe cell into two integers (megabytes), tolerant of noise. */
function splitPair(value: string | undefined): readonly [number | null, number | null] {
  if (!value) return [null, null];
  const slash = value.indexOf("/");
  if (slash < 0) return [null, null];
  return [toInt(value.slice(0, slash)), toInt(value.slice(slash + 1))];
}

export function parseResources(input: { pods: readonly SitePod[]; scalars: string }): ResourcesData {
  const kv = parseKv(input.scalars);
  const [memTotalMb, memUsedMb] = splitPair(kv.get("MEM"));
  const [diskTotalMb, diskUsedMb] = splitPair(kv.get("DISK"));
  return {
    pods: input.pods,
    runtime: {
      phpMemoryLimit: toStr(kv.get("PHP_MEM_LIMIT")),
      cpuCount: toInt(kv.get("CPU_COUNT")),
      memTotalMb,
      memUsedMb,
      diskTotalMb,
      diskUsedMb,
    },
  };
}

async function fetchResources(ctx: PanelProbeContext): Promise<ResourcesData> {
  // Runtime facts: PHP memory ceiling, CPU count, container RAM and content disk.
  // Each read fails soft (missing `free`/`df` ⇒ empty cell ⇒ null in the parser).
  const runtimeCmd = [
    `echo "PHP_MEM_LIMIT=$(php -r 'echo ini_get("memory_limit");' 2>/dev/null)"`,
    `echo "CPU_COUNT=$(nproc 2>/dev/null)"`,
    `echo "MEM=$(free -m 2>/dev/null | awk 'NR==2{print $2"/"$3}')"`,
    `echo "DISK=$(df -m wp-content 2>/dev/null | awk 'NR==2{print $2"/"$3}')"`,
  ].join("\n");

  const [pods, scalars] = await Promise.all([
    listSitePods(ctx.site).catch(() => [] as SitePod[]),
    ctx.exec(runtimeCmd).then((r) => r.stdout).catch(() => ""),
  ]);

  return parseResources({ pods, scalars });
}

export const resourcesProbe: PanelProbe<ResourcesData> = {
  id: "resources",
  fetch: fetchResources,
};
