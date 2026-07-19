import "server-only";
import { getCachedFleet } from "./aggregate";

/**
 * Real fleet performance posture — the PHP runtime distribution, the mean
 * Site-Health score, and how many sites are on an end-of-life PHP. Every figure
 * is derived from the already-cached fleet roll-up (`getCachedFleet`), whose rows
 * carry the in-pod wp-cli PHP/health signals. No new pod execs are done here, and
 * nothing is fabricated: a site with an unreadable runtime contributes an
 * "unknown" PHP bucket and a null health, never a made-up default.
 */

/** PHP 8.1 is the oldest version still receiving security fixes; below it = upgrade. */
const PHP_MIN_MAJOR = 8;
const PHP_MIN_MINOR = 1;

/** Bucket key for sites whose PHP version could not be read. */
const UNKNOWN_PHP = "unknown";

/** One PHP-version bucket across the fleet. */
export interface PhpDistributionBucket {
  /** Normalised `major.minor` (e.g. "8.3"), or "unknown" when unreadable. */
  readonly php: string;
  readonly count: number;
  /** True when this version is below the supported floor (PHP < 8.1). */
  readonly upgradeNeeded: boolean;
}

export interface FleetPerformance {
  readonly total: number;
  readonly phpDistribution: readonly PhpDistributionBucket[];
  /** Mean composite Site-Health (0–100) across readable sites, or null when none. */
  readonly healthAverage: number | null;
  /** Count of sites running a PHP below the supported floor (PHP < 8.1). */
  readonly upgradeNeeded: number;
  /** ISO the underlying fleet roll-up was generated. */
  readonly generatedAt: string;
}

/** Normalise a PHP version string to `major.minor`, or "unknown" when absent. */
function phpBucketKey(php: string | null): string {
  if (!php) return UNKNOWN_PHP;
  const match = php.match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : php;
}

/** True only when a KNOWN version is below the supported floor — unknown never counts. */
function needsPhpUpgrade(php: string | null): boolean {
  if (!php) return false;
  const match = php.match(/^(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < PHP_MIN_MAJOR) return true;
  if (major > PHP_MIN_MAJOR) return false;
  return minor < PHP_MIN_MINOR;
}

/** Sort buckets newest version first, with the "unknown" bucket always last. */
function compareBuckets(a: PhpDistributionBucket, b: PhpDistributionBucket): number {
  if (a.php === UNKNOWN_PHP) return 1;
  if (b.php === UNKNOWN_PHP) return -1;
  const [aMajor, aMinor] = a.php.split(".").map((part) => Number(part));
  const [bMajor, bMinor] = b.php.split(".").map((part) => Number(part));
  return bMajor - aMajor || bMinor - aMinor;
}

export async function getFleetPerformance(): Promise<FleetPerformance> {
  const fleet = await getCachedFleet();
  const rows = fleet.value.sites;

  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = phpBucketKey(row.php);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const phpDistribution: PhpDistributionBucket[] = [...counts.entries()]
    .map(([php, count]) => ({ php, count, upgradeNeeded: needsPhpUpgrade(php === UNKNOWN_PHP ? null : php) }))
    .sort(compareBuckets);

  const healthValues = rows.map((row) => row.health).filter((value): value is number => typeof value === "number");
  const healthAverage = healthValues.length
    ? Math.round(healthValues.reduce((sum, value) => sum + value, 0) / healthValues.length)
    : null;

  const upgradeNeeded = rows.filter((row) => needsPhpUpgrade(row.php)).length;

  return {
    total: rows.length,
    phpDistribution,
    healthAverage,
    upgradeNeeded,
    generatedAt: fleet.value.generatedAt,
  };
}
