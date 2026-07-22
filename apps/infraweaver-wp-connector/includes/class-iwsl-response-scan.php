<?php
/**
 * Generic engine behind the gated "Response Time Scanner" feature (flag
 * `response_scan`, Pro tier) — an ACTIVE, first-party page-speed probe that
 * complements the FREE, passive Load-Time Audit (IWSL_Perf_Audit).
 *
 * WHY THIS EXISTS (and how it differs from the free audit). IWSL_Perf_Audit times
 * only the SERVER GENERATION portion of a request, in-process, using WordPress's
 * own request timer — it explicitly CANNOT see DNS, TCP, TLS, or the transfer of
 * the HTML down the wire, because those happen off-server. This engine measures the
 * FULL response time of a real HTTP round-trip: it asks the site's OWN public URLs
 * back over the WordPress HTTP API (`wp_remote_get`) and times the wall-clock from
 * just before the request to just after the whole body has been received. That
 * number therefore includes DNS + TCP + TLS + server generation + full HTML
 * transfer — everything a browser would wait through for the document itself
 * (sub-resources like images/CSS/JS are still a browser concern and out of scope).
 *
 * WHY IT IS HONEST. This is NOT a third-party synthetic monitor and does NOT run a
 * headless browser. It is a real HTTP request issued FROM the server the site runs
 * on, looping back to the site's own public address. The admin copy says exactly
 * this so the number is never mistaken for a "browser page-load" score. To be robust
 * to a single slow outlier, each URL is probed N times (default 3) and the MEDIAN is
 * kept — a jitter-resistant central value, not a mean skewed by one GC pause.
 *
 * WHY IT IS SAFE (the plugin's trust model forbids SSRF / exec). The probe is a
 * LOOPBACK ONLY: every target URL's host MUST equal the site host from home_url(),
 * checked by self::same_host() before any request — an admin-entered URL pointing
 * anywhere else, a scheme that isn't http/https, or a URL carrying embedded
 * credentials is refused. The target set is capped at MAX_URLS and every request is
 * bounded by TIMEOUT_S. No exec/shell_exec/proc_open, no arbitrary outbound host:
 * the ONLY host this engine will ever contact is the site's own.
 *
 * SNAPSHOTS. A scan produces a labelled, immutable snapshot { ts, label, runs,
 * per-URL medians, site aggregate } stored under ONE option key via IWSL_Store, kept
 * as a ring buffer of the last MAX_SNAPSHOTS (append-only, oldest dropped). The admin
 * page renders the latest snapshot and a per-URL COMPARISON of the two most recent
 * snapshots (delta ms + % faster/slower, coloured) so the effect of a settings change
 * — e.g. "before lossless" vs "after lossless" — is obvious at a glance.
 *
 * TRUST MODEL. Console-authoritative, mirroring the other Pro engines: the
 * `response_scan` flag is written ONLY by the dual-signed `entitlements.set` runner
 * (§7). The gate is re-checked at THREE layers — the admin page (render_section),
 * the admin-post handler (handle_run, LAYER 2), and run() as STATEMENT 1. Every
 * WordPress call is function_exists-guarded so the pure logic (median, host guard,
 * snapshot bounding, aggregation, comparison) loads and runs under the
 * zero-dependency test harness with an injected store, home URL, clock and fetcher.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Response_Scan {

	/** The entitlement flag this whole feature gates on (Pro tier). */
	const FEATURE = 'response_scan';

	/** IWSL_Store option key holding the whole state (settings + snapshots). */
	const OPTION_KEY = 'response_scan';

	/** admin-post actions + matching nonce actions (wired by this engine's register()). */
	const SCAN_ACTION  = 'iwsl_response_scan_run';
	const SCAN_NONCE   = 'iwsl_response_scan_run';
	const CLEAR_ACTION = 'iwsl_response_scan_clear';
	const CLEAR_NONCE  = 'iwsl_response_scan_clear';

	/** Per-user PRG result transient prefix (append the user id). */
	const RESULT_PREFIX = 'iwsl_response_scan_result_';

	/** Hard cap on URLs probed in one scan — bounds the loopback fan-out. */
	const MAX_URLS = 20;

	/** Runs per URL — the median of these is kept (robust to one-off outliers). */
	const RUNS_DEFAULT = 3;
	const RUNS_MIN     = 1;
	const RUNS_MAX     = 5;

	/** Per-request timeout (seconds) — a bounded, never-hang round-trip. */
	const TIMEOUT_S = 10;

	/** Ring-buffer depth: the last K snapshots are kept, oldest dropped. */
	const MAX_SNAPSHOTS = 10;

	/** Longest stored snapshot label (characters). */
	const LABEL_MAX_LEN = 120;

	/** Longest stored URL-list textarea (characters) — bounds the option. */
	const MAX_URLS_TEXT_LEN = 4000;

	/** WordPress-core default sitemap index, joined onto home for the optional seed. */
	const SITEMAP_PATH = '/wp-sitemap.xml';

	/** How many <loc> entries to lift from the sitemap when that option is on. */
	const SITEMAP_MAX = 5;

	/** Colour thresholds for a single URL's median full response (milliseconds). */
	const FAST_MS = 500;   // at/under → "fast"
	const SLOW_MS = 1500;  // over → "slow"

	/** A per-URL delta smaller than this (ms) is treated as noise ("same"). */
	const DELTA_SIGNIFICANT_MS = 15;

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store settings + snapshots live here under OPTION_KEY. */
	private $store;

	/** @var string The site's own home URL (absolute), '' outside WordPress. */
	private $home_url;

	/** @var string Lowercased home host, '' outside WordPress — the SSRF anchor. */
	private $home_host;

	/** @var callable(string,int):array The HTTP fetcher (default = wp_remote_get). */
	private $fetcher;

	/** @var callable():float High-resolution clock in milliseconds (for timing). */
	private $clock_ms;

	/** @var callable():int Wall clock in unix seconds (for snapshot timestamps). */
	private $time_now;

	/**
	 * @param IWSL_Entitlements $entitlements The gate.
	 * @param IWSL_Store|null   $store        Settings/snapshot store; production injects IWSL_WP_Store.
	 * @param string|null       $home_url     Absolute home URL; defaults to home_url('/'). Injectable.
	 * @param callable|null     $fetcher      HTTP fetcher(string $url,int $timeout_s):array; default wp_remote_get.
	 * @param callable|null     $clock_ms     Monotonic ms clock; default microtime(true)*1000. Injectable for tests.
	 * @param callable|null     $time_now     Unix-seconds clock; default time(). Injectable for tests.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		?IWSL_Store $store = null,
		?string $home_url = null,
		?callable $fetcher = null,
		?callable $clock_ms = null,
		?callable $time_now = null
	) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : new IWSL_WP_Store();
		$this->home_url     = null !== $home_url ? $home_url : self::default_home_url();
		$this->home_host    = self::host_of( $this->home_url );
		$this->fetcher      = null !== $fetcher ? $fetcher : self::default_fetcher();
		$this->clock_ms     = $clock_ms ?? static function (): float {
			return microtime( true ) * 1000.0;
		};
		$this->time_now = $time_now ?? static function (): int {
			return time();
		};
	}

	/**
	 * Wire the two admin-post handlers (the scan run + the clear). Guarded so the
	 * harness can call it harmlessly. This engine self-registers its handlers rather
	 * than relying on IWSL_Admin. Nothing is bound on the front end — the probe is
	 * operator-triggered only, never a passive request hook.
	 */
	public function register(): void {
		if ( ! function_exists( 'add_action' ) ) {
			return;
		}
		add_action( 'admin_post_' . self::SCAN_ACTION, array( $this, 'handle_run' ) );
		add_action( 'admin_post_' . self::CLEAR_ACTION, array( $this, 'handle_clear' ) );
	}

	// ── the scan orchestration (STATEMENT 1 is the authoritative gate) ──────────

	/**
	 * Run one scan and append an immutable snapshot. STATEMENT 1 is the entitlement
	 * gate (LAYER 3) — nothing below runs for a locked site. Targets are built from
	 * the home URL (always first), the admin-entered same-host list, and (optionally)
	 * the first few same-host sitemap locs; every target is host-verified again inside
	 * build_targets, capped at MAX_URLS. Each target is probed `runs` times and the
	 * median kept. The last-used settings are persisted so the form remembers them.
	 *
	 * @param array<string,mixed> $input { label?:string, urls?:string, runs?:int, include_sitemap?:bool }
	 * @return array{ ok:bool, reason?:string, gate?:array, snapshot?:array, targets?:string[] }
	 */
	public function run( array $input ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}
		if ( '' === $this->home_url || '' === $this->home_host ) {
			return array( 'ok' => false, 'reason' => 'no-home-url' );
		}

		$label           = self::sanitize_label( isset( $input['label'] ) ? (string) $input['label'] : '' );
		$runs            = self::sanitize_runs( isset( $input['runs'] ) ? (int) $input['runs'] : self::RUNS_DEFAULT );
		$extra           = isset( $input['urls'] ) ? $input['urls'] : '';
		$include_sitemap = ! empty( $input['include_sitemap'] );

		// Persist the settings so the next form render pre-fills what was used.
		$state             = $this->state();
		$state['settings'] = self::sanitize_settings(
			array(
				'urls'            => is_string( $extra ) ? $extra : '',
				'runs'            => $runs,
				'include_sitemap' => $include_sitemap,
			)
		);

		$sitemap_locs = $include_sitemap ? $this->fetch_sitemap_locs() : array();
		$targets      = self::build_targets( $this->home_url, $extra, $sitemap_locs, $this->home_host, self::MAX_URLS );
		if ( array() === $targets ) {
			return array( 'ok' => false, 'reason' => 'no-targets' );
		}

		$results = array();
		foreach ( $targets as $url ) {
			$results[] = $this->run_url( $url, $runs );
		}

		$snapshot           = self::make_snapshot( ( $this->time_now )(), $label, $runs, $results );
		$state['snapshots'] = self::append_snapshot( $state['snapshots'], $snapshot, self::MAX_SNAPSHOTS );
		$this->store->set( self::OPTION_KEY, $state );

		return array( 'ok' => true, 'snapshot' => $snapshot, 'targets' => $targets );
	}

	/**
	 * Probe one URL `runs` times and fold the timings into a single per-URL row via
	 * the pure aggregate_runs(). Only successful (2xx/3xx) probes feed the median; a
	 * URL that never succeeds is recorded ok=false with the last error.
	 *
	 * @return array The aggregate row (see aggregate_runs()).
	 */
	public function run_url( string $url, int $runs ): array {
		$runs           = self::sanitize_runs( $runs );
		$ms_list        = array();
		$bytes_list     = array();
		$codes          = array();
		$content_length = 0;
		$ok_count       = 0;
		$last_error     = '';

		for ( $i = 0; $i < $runs; $i++ ) {
			$p       = $this->probe_url( $url );
			$codes[] = (int) $p['code'];
			if ( ! empty( $p['ok'] ) ) {
				$ms_list[]      = (float) $p['ms'];
				$bytes_list[]   = (int) $p['bytes'];
				$content_length = (int) $p['content_length'];
				$ok_count++;
			} elseif ( '' !== (string) $p['error'] ) {
				$last_error = (string) $p['error'];
			}
		}

		return self::aggregate_runs( $url, self::path_of( $url ), $runs, $ms_list, $bytes_list, $codes, $content_length, $ok_count, $last_error );
	}

	/**
	 * A single timed HTTP round-trip via the fetcher. The SSRF guard runs FIRST — a
	 * target whose host isn't the home host (or any non-http/https / credentialled
	 * URL) is refused without a request. Wall-clock ms is measured with the injected
	 * high-resolution clock around the (blocking) fetch, so the number is the full
	 * DNS+TCP+TLS+server+transfer time. A 2xx/3xx with no transport error is `ok`.
	 *
	 * @return array{ ok:bool, code:int, ms:float, bytes:int, content_length:int, error:string }
	 */
	public function probe_url( string $url ): array {
		if ( ! self::same_host( $url, $this->home_host ) ) {
			return array( 'ok' => false, 'code' => 0, 'ms' => 0.0, 'bytes' => 0, 'content_length' => 0, 'error' => 'ssrf-blocked' );
		}
		$t0  = (float) ( $this->clock_ms )();
		$res = ( $this->fetcher )( $url, self::TIMEOUT_S );
		$t1  = (float) ( $this->clock_ms )();
		$ms  = max( 0.0, $t1 - $t0 );

		$res  = is_array( $res ) ? $res : array();
		$code = isset( $res['code'] ) ? (int) $res['code'] : 0;
		$err  = isset( $res['error'] ) ? (string) $res['error'] : '';
		$ok   = '' === $err && $code >= 200 && $code < 400;

		return array(
			'ok'             => $ok,
			'code'           => $code,
			'ms'             => $ms,
			'bytes'          => isset( $res['bytes'] ) ? (int) $res['bytes'] : 0,
			'content_length' => isset( $res['content_length'] ) ? (int) $res['content_length'] : 0,
			'error'          => $err,
		);
	}

	/**
	 * Fetch the site's own sitemap (loopback, host-verified) and lift the first few
	 * <loc> entries. Non-fatal: anything but a 2xx/3xx XML body yields no seeds.
	 *
	 * @return string[]
	 */
	private function fetch_sitemap_locs(): array {
		$url = self::join_url( $this->home_url, self::SITEMAP_PATH );
		if ( ! self::same_host( $url, $this->home_host ) ) {
			return array();
		}
		$res  = ( $this->fetcher )( $url, self::TIMEOUT_S );
		$res  = is_array( $res ) ? $res : array();
		$code = isset( $res['code'] ) ? (int) $res['code'] : 0;
		$body = isset( $res['body'] ) ? (string) $res['body'] : '';
		if ( $code < 200 || $code >= 400 || '' === $body ) {
			return array();
		}
		return self::parse_sitemap_locs( $body, self::SITEMAP_MAX );
	}

	// ── pure logic core (no WordPress, no I/O — unit-tested) ────────────────────

	/**
	 * The median of a numeric list — the middle value (or the mean of the two middle
	 * values for an even count). Immutable: sorts a copy. Non-numeric entries are
	 * ignored; an empty list is 0.0. This is the outlier-robust statistic each URL's
	 * many runs collapse to.
	 *
	 * @param array<int,int|float> $values
	 */
	public static function median( array $values ): float {
		$nums = array();
		foreach ( $values as $v ) {
			if ( is_int( $v ) || is_float( $v ) ) {
				$nums[] = (float) $v;
			}
		}
		$n = count( $nums );
		if ( 0 === $n ) {
			return 0.0;
		}
		sort( $nums );
		$mid = intdiv( $n, 2 );
		if ( 0 === $n % 2 ) {
			return ( $nums[ $mid - 1 ] + $nums[ $mid ] ) / 2.0;
		}
		return $nums[ $mid ];
	}

	/**
	 * The SSRF guard: whether $url is an absolute http/https URL whose host EQUALS the
	 * home host. Rejects a foreign host, a non-web scheme, a relative/scheme-less URL
	 * (no host to verify), and any URL carrying embedded credentials (defence against
	 * `http://home.host@evil/` style tricks). This is THE boundary that keeps the
	 * active probe a strict loopback.
	 */
	public static function same_host( string $url, string $home_host ): bool {
		$home_host = strtolower( trim( $home_host ) );
		if ( '' === $home_host ) {
			return false;
		}
		$url = trim( $url );
		if ( '' === $url ) {
			return false;
		}
		$parts = self::parse_url( $url );
		if ( null === $parts ) {
			return false;
		}
		$scheme = isset( $parts['scheme'] ) ? strtolower( (string) $parts['scheme'] ) : '';
		if ( 'http' !== $scheme && 'https' !== $scheme ) {
			return false;
		}
		if ( isset( $parts['user'] ) || isset( $parts['pass'] ) ) {
			return false;
		}
		$host = isset( $parts['host'] ) ? strtolower( (string) $parts['host'] ) : '';
		return '' !== $host && $host === $home_host;
	}

	/**
	 * Sanitize an operator-entered URL list (textarea string or array): split on
	 * newlines, keep only same-host absolute URLs, strip fragments, dedupe, cap at
	 * $max. Immutable.
	 *
	 * @param mixed $raw
	 * @return string[]
	 */
	public static function sanitize_urls( $raw, string $home_host, int $max = self::MAX_URLS ): array {
		$max = max( 1, $max );
		$out = array();
		foreach ( self::to_lines( $raw ) as $line ) {
			$u = trim( $line );
			if ( '' === $u || ! self::same_host( $u, $home_host ) ) {
				continue;
			}
			$u = self::normalize_url( $u );
			if ( ! in_array( $u, $out, true ) ) {
				$out[] = $u;
			}
			if ( count( $out ) >= $max ) {
				break;
			}
		}
		return $out;
	}

	/**
	 * Assemble the final probe target list: the home URL ALWAYS first, then the
	 * admin-entered same-host list, then the sitemap seeds. Every candidate is
	 * re-verified same-host, fragment-stripped, deduped, and the whole set capped at
	 * $max. Immutable and pure — the single source of truth for what gets probed.
	 *
	 * @param mixed    $extra_raw    Operator URL list (string or array).
	 * @param string[] $sitemap_locs Sitemap-derived candidates.
	 * @return string[]
	 */
	public static function build_targets( string $home_url, $extra_raw, array $sitemap_locs, string $home_host, int $max = self::MAX_URLS ): array {
		$max = max( 1, $max );
		$out = array();
		$push = static function ( string $u ) use ( &$out, $home_host, $max ): void {
			if ( count( $out ) >= $max ) {
				return;
			}
			if ( ! self::same_host( $u, $home_host ) ) {
				return;
			}
			$u = self::normalize_url( $u );
			if ( ! in_array( $u, $out, true ) ) {
				$out[] = $u;
			}
		};

		if ( '' !== trim( $home_url ) ) {
			$push( $home_url );
		}
		foreach ( self::sanitize_urls( $extra_raw, $home_host, $max ) as $u ) {
			$push( $u );
		}
		foreach ( $sitemap_locs as $loc ) {
			if ( is_string( $loc ) ) {
				$push( $loc );
			}
		}
		return array_slice( $out, 0, $max );
	}

	/** Clamp a runs-per-URL count into [RUNS_MIN, RUNS_MAX]. */
	public static function sanitize_runs( int $runs ): int {
		if ( $runs < self::RUNS_MIN ) {
			return self::RUNS_MIN;
		}
		if ( $runs > self::RUNS_MAX ) {
			return self::RUNS_MAX;
		}
		return $runs;
	}

	/**
	 * Sanitize a free-text snapshot label: strip control characters, trim, length-cap.
	 * HTML-unsafe characters are preserved here and escaped at render time.
	 */
	public static function sanitize_label( string $raw ): string {
		$label = preg_replace( '/[\x00-\x1F\x7F]+/', ' ', $raw );
		$label = null === $label ? '' : trim( $label );
		if ( function_exists( 'mb_substr' ) ) {
			$label = mb_substr( $label, 0, self::LABEL_MAX_LEN );
		} else {
			$label = substr( $label, 0, self::LABEL_MAX_LEN );
		}
		return $label;
	}

	/**
	 * Fold the many runs for ONE URL into an immutable aggregate row: the median (and
	 * min/max) of the successful timings, the median downloaded byte size, the most
	 * common HTTP status, and the ok/error verdict. Pure — the testable heart of the
	 * per-URL measurement.
	 *
	 * @param array<int,float> $ms_list    Successful round-trip times (ms).
	 * @param array<int,int>   $bytes_list Successful downloaded body sizes (bytes).
	 * @param array<int,int>   $codes      Every run's HTTP status (incl. failures).
	 * @return array
	 */
	public static function aggregate_runs( string $url, string $path, int $runs, array $ms_list, array $bytes_list, array $codes, int $content_length, int $ok_count, string $error ): array {
		$ok = $ok_count > 0;
		return array(
			'url'            => $url,
			'path'           => $path,
			'ok'             => $ok,
			'code'           => self::pick_code( $codes ),
			'runs'           => max( 0, $runs ),
			'ok_runs'        => max( 0, $ok_count ),
			'median_ms'      => $ok ? (int) round( self::median( $ms_list ) ) : 0,
			'min_ms'         => $ok ? (int) round( (float) min( $ms_list ) ) : 0,
			'max_ms'         => $ok ? (int) round( (float) max( $ms_list ) ) : 0,
			'median_bytes'   => $ok ? (int) round( self::median( $bytes_list ) ) : 0,
			'content_length' => max( 0, (int) $content_length ),
			'error'          => $ok ? '' : (string) $error,
		);
	}

	/**
	 * Roll a snapshot's per-URL rows up to a site aggregate: the count, the number
	 * that responded, and the MEDIAN and mean of the per-URL medians (over responding
	 * URLs). Median-of-medians is the site's representative full response time. Pure.
	 *
	 * @param array $results Per-URL aggregate rows.
	 * @return array{ count:int, ok_count:int, median_ms:int, avg_ms:int }
	 */
	public static function aggregate_results( array $results ): array {
		$medians = array();
		$ok      = 0;
		foreach ( $results as $r ) {
			if ( is_array( $r ) && ! empty( $r['ok'] ) ) {
				$medians[] = (float) ( $r['median_ms'] ?? 0 );
				$ok++;
			}
		}
		$has = array() !== $medians;
		return array(
			'count'     => count( $results ),
			'ok_count'  => $ok,
			'median_ms' => $has ? (int) round( self::median( $medians ) ) : 0,
			'avg_ms'    => $has ? (int) round( array_sum( $medians ) / count( $medians ) ) : 0,
		);
	}

	/**
	 * Build an immutable snapshot record from per-URL rows: sanitized label, bounded
	 * runs, the rows, and the site aggregate. Pure.
	 *
	 * @param array $results Per-URL aggregate rows.
	 * @return array
	 */
	public static function make_snapshot( int $ts, string $label, int $runs, array $results ): array {
		$rows = array_values( array_filter( $results, 'is_array' ) );
		return array(
			'ts'           => max( 0, $ts ),
			'label'        => self::sanitize_label( $label ),
			'runs'         => self::sanitize_runs( $runs ),
			'urls_scanned' => count( $rows ),
			'results'      => $rows,
			'aggregate'    => self::aggregate_results( $rows ),
		);
	}

	/**
	 * Append a snapshot to the ring buffer, keeping only the last $max (oldest
	 * dropped). Immutable: returns a fresh, re-indexed list; never mutates the input.
	 *
	 * @param array $snapshots Prior snapshots (oldest → newest).
	 * @param array $snapshot  The new snapshot to append.
	 * @return array New bounded list.
	 */
	public static function append_snapshot( array $snapshots, array $snapshot, int $max = self::MAX_SNAPSHOTS ): array {
		$max   = max( 1, $max );
		$out   = array_values( $snapshots );
		$out[] = $snapshot;
		if ( count( $out ) > $max ) {
			$out = array_slice( $out, count( $out ) - $max );
		}
		return array_values( $out );
	}

	/**
	 * Compare two snapshots URL-by-URL: for every URL in $newer, the delta ms and
	 * percent change against the SAME URL in $older (only when both responded), plus
	 * a direction (faster / slower / same / new). Also compares the site aggregate.
	 * Pure — the brain of the "did my change help?" view.
	 *
	 * @return array{ rows:array, site:array, matched:int }
	 */
	public static function compare_snapshots( array $newer, array $older ): array {
		$older_by_url = array();
		foreach ( self::snapshot_results( $older ) as $r ) {
			if ( isset( $r['url'] ) ) {
				$older_by_url[ (string) $r['url'] ] = $r;
			}
		}

		$rows    = array();
		$matched = 0;
		foreach ( self::snapshot_results( $newer ) as $r ) {
			$url = (string) ( $r['url'] ?? '' );
			$row = array(
				'url'       => $url,
				'path'      => (string) ( $r['path'] ?? '' ),
				'new_ms'    => (int) ( $r['median_ms'] ?? 0 ),
				'old_ms'    => 0,
				'delta_ms'  => 0,
				'pct'       => 0.0,
				'direction' => 'new',
				'matched'   => false,
			);
			if ( isset( $older_by_url[ $url ] ) && ! empty( $r['ok'] ) && ! empty( $older_by_url[ $url ]['ok'] ) ) {
				$old               = (int) ( $older_by_url[ $url ]['median_ms'] ?? 0 );
				$new               = (int) ( $r['median_ms'] ?? 0 );
				$delta             = $new - $old;
				$row['old_ms']     = $old;
				$row['delta_ms']   = $delta;
				$row['pct']        = $old > 0 ? round( ( $delta / $old ) * 100.0, 1 ) : 0.0;
				$row['direction']  = self::classify_delta( $delta );
				$row['matched']    = true;
				$matched++;
			}
			$rows[] = $row;
		}

		return array(
			'rows'    => $rows,
			'site'    => self::compare_aggregates(
				is_array( $newer['aggregate'] ?? null ) ? $newer['aggregate'] : array(),
				is_array( $older['aggregate'] ?? null ) ? $older['aggregate'] : array()
			),
			'matched' => $matched,
		);
	}

	/** Compare two site aggregates (median-of-medians). Pure. */
	public static function compare_aggregates( array $newer, array $older ): array {
		$new   = (int) ( $newer['median_ms'] ?? 0 );
		$old   = (int) ( $older['median_ms'] ?? 0 );
		$delta = $new - $old;
		return array(
			'new_ms'    => $new,
			'old_ms'    => $old,
			'delta_ms'  => $delta,
			'pct'       => $old > 0 ? round( ( $delta / $old ) * 100.0, 1 ) : 0.0,
			'direction' => self::classify_delta( $delta ),
		);
	}

	/** faster (got quicker), slower (got slower), or same (within the noise band). */
	public static function classify_delta( int $delta_ms ): string {
		if ( abs( $delta_ms ) < self::DELTA_SIGNIFICANT_MS ) {
			return 'same';
		}
		return $delta_ms < 0 ? 'faster' : 'slower';
	}

	/** The most frequent HTTP status across runs; ties keep first-seen; 0 if none. */
	public static function pick_code( array $codes ): int {
		$counts = array();
		foreach ( $codes as $c ) {
			$c            = (int) $c;
			$counts[ $c ] = ( $counts[ $c ] ?? 0 ) + 1;
		}
		if ( array() === $counts ) {
			return 0;
		}
		arsort( $counts );
		return (int) array_key_first( $counts );
	}

	/**
	 * Lift the first $max <loc> URLs out of a sitemap XML string. Pure and defensive:
	 * a non-XML or empty body yields no seeds; entities are decoded; duplicates dropped.
	 *
	 * @return string[]
	 */
	public static function parse_sitemap_locs( string $xml, int $max = self::SITEMAP_MAX ): array {
		$max = max( 0, $max );
		if ( 0 === $max || '' === $xml ) {
			return array();
		}
		if ( ! preg_match_all( '#<loc>\s*(.*?)\s*</loc>#is', $xml, $m ) ) {
			return array();
		}
		$out = array();
		foreach ( $m[1] as $loc ) {
			$loc = html_entity_decode( trim( (string) $loc ), ENT_QUOTES | ENT_HTML5 );
			if ( '' === $loc ) {
				continue;
			}
			if ( ! in_array( $loc, $out, true ) ) {
				$out[] = $loc;
			}
			if ( count( $out ) >= $max ) {
				break;
			}
		}
		return $out;
	}

	// ── state helpers ───────────────────────────────────────────────────────────

	/**
	 * Coerce any stored blob into the canonical state shape { settings, snapshots }.
	 * Pure and defensive so a DB-tampered option can never widen behaviour.
	 *
	 * @param mixed $raw
	 */
	public static function normalize_state( $raw ): array {
		$state = is_array( $raw ) ? $raw : array();
		return array(
			'settings'  => self::sanitize_settings( isset( $state['settings'] ) && is_array( $state['settings'] ) ? $state['settings'] : array() ),
			'snapshots' => self::normalize_snapshots( isset( $state['snapshots'] ) && is_array( $state['snapshots'] ) ? $state['snapshots'] : array() ),
		);
	}

	/**
	 * Normalize a raw settings map into the canonical shape. Immutable. The URL list
	 * is kept as a control-stripped, length-bounded textarea string; runs clamped;
	 * the sitemap flag coerced.
	 *
	 * @param array<string,mixed> $input
	 * @return array{ urls:string, runs:int, include_sitemap:bool }
	 */
	public static function sanitize_settings( array $input ): array {
		$urls = $input['urls'] ?? '';
		if ( is_array( $urls ) ) {
			$flat = array();
			foreach ( $urls as $u ) {
				if ( is_scalar( $u ) ) {
					$flat[] = (string) $u;
				}
			}
			$urls = implode( "\n", $flat );
		}
		return array(
			'urls'            => self::clip_textarea( is_string( $urls ) ? $urls : '' ),
			'runs'            => self::sanitize_runs( isset( $input['runs'] ) ? (int) $input['runs'] : self::RUNS_DEFAULT ),
			'include_sitemap' => ! empty( $input['include_sitemap'] ),
		);
	}

	/** Coerce a raw snapshots list, dropping non-array entries and bounding depth. */
	public static function normalize_snapshots( array $raw ): array {
		$out = array();
		foreach ( $raw as $snap ) {
			if ( is_array( $snap ) ) {
				$out[] = $snap;
			}
		}
		if ( count( $out ) > self::MAX_SNAPSHOTS ) {
			$out = array_slice( $out, count( $out ) - self::MAX_SNAPSHOTS );
		}
		return array_values( $out );
	}

	/** The current state from the store, normalized. */
	public function state(): array {
		return self::normalize_state( $this->store->get( self::OPTION_KEY, array() ) );
	}

	/** The persisted settings (URL list + runs + sitemap flag). */
	public function settings(): array {
		return $this->state()['settings'];
	}

	/** The stored snapshots, oldest → newest. */
	public function snapshots(): array {
		return $this->state()['snapshots'];
	}

	/**
	 * Teardown for an uninstall/unlink sweep: delete the ONE option key that holds
	 * BOTH the persisted settings (URL list, runs, sitemap flag) and every stored
	 * snapshot, entirely — so a fresh read falls back to normalize_state()'s
	 * defaults rather than stale data. Idempotent + cheap: deleting an absent key
	 * is a single no-op store call.
	 *
	 * @return array{ ok:bool, deleted:bool }
	 */
	public function purge(): array {
		$had = null !== $this->store->get( self::OPTION_KEY, null );
		$this->store->delete( self::OPTION_KEY );
		return array( 'ok' => true, 'deleted' => $had );
	}

	// ── admin-post handlers (capability + nonce + gate) ─────────────────────────

	/**
	 * admin-post handler for the scan run. LAYER 2 of the gate: capability + nonce,
	 * then re-check the entitlement before doing any work, then run() (whose STATEMENT
	 * 1 is the authoritative LAYER 3 gate). PRG back to the Plus page with a per-user
	 * result transient the render picks up.
	 */
	public function handle_run(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::SCAN_NONCE );

		$redirect = admin_url( 'admin.php?page=infraweaver-plus' );

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_response_scan_locked', '1', $redirect ) );
			exit;
		}

		$input = array(
			'label'           => isset( $_POST['iwsl_rs_label'] ) ? sanitize_text_field( wp_unslash( $_POST['iwsl_rs_label'] ) ) : '',
			'urls'            => isset( $_POST['iwsl_rs_urls'] ) ? sanitize_textarea_field( wp_unslash( $_POST['iwsl_rs_urls'] ) ) : '',
			'runs'            => isset( $_POST['iwsl_rs_runs'] ) ? (int) $_POST['iwsl_rs_runs'] : self::RUNS_DEFAULT,
			'include_sitemap' => isset( $_POST['iwsl_rs_include_sitemap'] ),
		);

		$result = $this->run( $input );

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( self::RESULT_PREFIX . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	/** Clear all stored snapshots (keeps settings). cap + nonce, then PRG. */
	public function handle_clear(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::CLEAR_NONCE );
		$state              = $this->state();
		$state['snapshots'] = array();
		$this->store->set( self::OPTION_KEY, $state );
		wp_safe_redirect( add_query_arg( 'iwsl_response_scan_cleared', '1', admin_url( 'admin.php?page=infraweaver-plus' ) ) );
		exit;
	}

	// ── admin render (presentation only) ────────────────────────────────────────

	/**
	 * Render the Response Time Scanner section. LAYER 1 gate: a locked feature shows
	 * only the quiet locked notice. Unlocked, it renders the run form (label + URL
	 * list + runs), the latest snapshot table, and the two-snapshot comparison.
	 */
	public function render_section(): void {
		if ( ! function_exists( 'esc_html' ) || ! function_exists( 'esc_attr' ) ) {
			return;
		}

		echo '<h2>' . esc_html__( 'Response Time Scanner', 'infraweaver-connector' ) . '</h2>';

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->render_locked_notice( $gate );
			return;
		}

		$this->render_result_notice();

		echo '<p class="description" style="max-width:760px;">'
			. esc_html__( 'Measures the FULL response time of your pages — DNS, connection, TLS, server work and the whole HTML download — by making a real HTTP request from this server back to your own public URLs and timing the round-trip. This is not a third-party browser test and does not load images or scripts; it is the time to receive the page document itself. Each URL is checked a few times and the middle (median) value is kept, so one slow blip does not skew the result.', 'infraweaver-connector' )
			. '</p>';

		$this->render_run_form();

		$snapshots = $this->snapshots();
		$count     = count( $snapshots );
		if ( 0 === $count ) {
			echo '<p style="margin-top:16px;">' . esc_html__( 'No scans yet. Enter a label (e.g. “before lossless images”), then run a scan. Change a setting, run again with a new label, and the two runs will be compared here per URL.', 'infraweaver-connector' ) . '</p>';
			return;
		}

		$latest = $snapshots[ $count - 1 ];
		$this->render_snapshot_table( $latest );

		if ( $count >= 2 ) {
			$this->render_comparison( $latest, $snapshots[ $count - 2 ] );
		} else {
			echo '<p style="margin-top:12px;" class="description">' . esc_html__( 'Run a second scan (after changing a setting) to see a per-URL before/after comparison here.', 'infraweaver-connector' ) . '</p>';
		}

		$this->render_history_controls( $count );
	}

	/** The scan form: label, URL list, runs, sitemap seed, and the Run button. */
	private function render_run_form(): void {
		$settings = $this->settings();
		$action   = function_exists( 'admin_url' ) ? admin_url( 'admin-post.php' ) : '';

		echo '<form method="post" action="' . esc_url( $action ) . '" style="margin-top:12px;max-width:760px;">';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::SCAN_NONCE );
		}
		echo '<input type="hidden" name="action" value="' . esc_attr( self::SCAN_ACTION ) . '">';

		echo '<div class="iwsl-primary">';
		echo '<span class="iwsl-primary__meta">';
		echo '<label for="iwsl-rs-label" style="font-weight:600;">' . esc_html__( 'Snapshot label', 'infraweaver-connector' ) . '</label> ';
		echo '<input type="text" id="iwsl-rs-label" name="iwsl_rs_label" class="regular-text" maxlength="' . esc_attr( (string) self::LABEL_MAX_LEN ) . '" placeholder="' . esc_attr__( 'e.g. before lossless images', 'infraweaver-connector' ) . '">';
		echo iwsl_field_help( 'A short name for this run so you can tell it apart from the next one when comparing.' );
		echo '</span>';
		echo '<button type="submit" class="button button-primary">' . esc_html__( 'Run scan', 'infraweaver-connector' ) . '</button>';
		echo '</div>';

		echo '<details class="iwsl-adv"><summary>' . esc_html__( 'Advanced settings', 'infraweaver-connector' ) . '</summary><div class="iwsl-adv__body">';

		echo '<table class="form-table widefat" role="presentation"><tbody>';

		echo '<tr><th scope="row"><label for="iwsl-rs-urls">' . esc_html__( 'Extra URLs', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'Extra pages on THIS site to time, one full web address per line. Your home page is always included.' ) . '</th><td>';
		echo '<textarea id="iwsl-rs-urls" name="iwsl_rs_urls" class="large-text code" rows="4" placeholder="' . esc_attr( rtrim( (string) $this->home_url, '/' ) . '/shop/&#10;' . rtrim( (string) $this->home_url, '/' ) . '/about/' ) . '">' . esc_textarea( (string) $settings['urls'] ) . '</textarea>';
		echo '<p class="description">' . esc_html(
			sprintf(
				/* translators: 1: max URLs, 2: the site host. */
				__( 'One full URL per line, up to %1$d total. Only URLs on this site (%2$s) are scanned — anything else is ignored, by design (the scan only ever contacts your own site).', 'infraweaver-connector' ),
				(int) self::MAX_URLS,
				(string) $this->home_host
			)
		) . '</p></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-rs-runs">' . esc_html__( 'Runs per URL', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'How many times each page is timed. The middle value is kept, so one slow blip does not skew the result.' ) . '</th><td>';
		echo '<input type="number" id="iwsl-rs-runs" name="iwsl_rs_runs" min="' . esc_attr( (string) self::RUNS_MIN ) . '" max="' . esc_attr( (string) self::RUNS_MAX ) . '" value="' . esc_attr( (string) $settings['runs'] ) . '" class="small-text"> ' . esc_html__( 'times (median kept)', 'infraweaver-connector' );
		echo '</td></tr>';

		echo '<tr><th scope="row">' . esc_html__( 'Sitemap', 'infraweaver-connector' ) . iwsl_field_help( 'Also time the first few pages listed in your site’s sitemap, so you cover more than the home page automatically.' ) . '</th><td>';
		echo '<label><input type="checkbox" name="iwsl_rs_include_sitemap" value="1"' . ( ! empty( $settings['include_sitemap'] ) ? ' checked' : '' ) . '> '
			. esc_html( sprintf( 'Include the first %d pages from the sitemap', (int) self::SITEMAP_MAX ) ) . '</label>';
		echo '</td></tr>';

		echo '</tbody></table>';
		echo '</div></details>';

		echo '</form>';
	}

	/** The latest snapshot's per-URL table. Read-only; escapes everything. */
	private function render_snapshot_table( array $snapshot ): void {
		$agg   = is_array( $snapshot['aggregate'] ?? null ) ? $snapshot['aggregate'] : array();
		$label = (string) ( $snapshot['label'] ?? '' );

		echo '<h3 style="margin-top:20px;">' . esc_html__( 'Latest scan', 'infraweaver-connector' );
		if ( '' !== $label ) {
			echo ' — <span style="font-weight:400;">' . esc_html( $label ) . '</span>';
		}
		echo '</h3>';

		echo '<p class="description">' . esc_html(
			sprintf(
				/* translators: 1: site median ms, 2: responding URL count, 3: total URL count. */
				__( 'Site median full response: %1$d ms across %2$d of %3$d URL(s).', 'infraweaver-connector' ),
				(int) ( $agg['median_ms'] ?? 0 ),
				(int) ( $agg['ok_count'] ?? 0 ),
				(int) ( $agg['count'] ?? 0 )
			)
		) . '</p>';

		$rows = is_array( $snapshot['results'] ?? null ) ? $snapshot['results'] : array();
		echo '<table class="widefat striped" style="max-width:1000px;margin-top:8px;"><thead><tr>';
		echo '<th>' . esc_html__( 'URL', 'infraweaver-connector' ) . '</th>';
		echo '<th>' . esc_html__( 'Status', 'infraweaver-connector' ) . '</th>';
		echo '<th>' . esc_html__( 'Median', 'infraweaver-connector' ) . '</th>';
		echo '<th>' . esc_html__( 'Min', 'infraweaver-connector' ) . '</th>';
		echo '<th>' . esc_html__( 'Max', 'infraweaver-connector' ) . '</th>';
		echo '<th>' . esc_html__( 'Size', 'infraweaver-connector' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $rows as $r ) {
			if ( ! is_array( $r ) ) {
				continue;
			}
			$ok = ! empty( $r['ok'] );
			echo '<tr>';
			echo '<td><code>' . esc_html( (string) ( $r['path'] ?? $r['url'] ?? '' ) ) . '</code></td>';
			if ( $ok ) {
				echo '<td>' . esc_html( (string) (int) ( $r['code'] ?? 0 ) ) . '</td>';
				echo '<td><strong style="color:' . esc_attr( self::ms_color( (int) ( $r['median_ms'] ?? 0 ) ) ) . ';">' . esc_html( sprintf( '%d ms', (int) ( $r['median_ms'] ?? 0 ) ) ) . '</strong></td>';
				echo '<td>' . esc_html( sprintf( '%d ms', (int) ( $r['min_ms'] ?? 0 ) ) ) . '</td>';
				echo '<td>' . esc_html( sprintf( '%d ms', (int) ( $r['max_ms'] ?? 0 ) ) ) . '</td>';
				echo '<td>' . esc_html( self::format_bytes( (int) ( $r['median_bytes'] ?? 0 ) ) ) . '</td>';
			} else {
				$why = '' !== (string) ( $r['error'] ?? '' ) ? (string) $r['error'] : sprintf( 'HTTP %d', (int) ( $r['code'] ?? 0 ) );
				echo '<td colspan="5"><span style="color:#b32d2e;">' . esc_html( sprintf( 'No response (%s)', $why ) ) . '</span></td>';
			}
			echo '</tr>';
		}
		echo '</tbody></table>';
	}

	/** The per-URL before/after comparison of the two most recent snapshots. */
	private function render_comparison( array $newer, array $older ): void {
		$cmp  = self::compare_snapshots( $newer, $older );
		$site = $cmp['site'];

		$new_label = (string) ( $newer['label'] ?? '' );
		$old_label = (string) ( $older['label'] ?? '' );
		$new_label = '' !== $new_label ? $new_label : __( 'latest', 'infraweaver-connector' );
		$old_label = '' !== $old_label ? $old_label : __( 'previous', 'infraweaver-connector' );

		echo '<h3 style="margin-top:20px;">' . esc_html(
			sprintf(
				/* translators: 1: newer label, 2: older label. */
				__( 'Comparison: “%1$s” vs “%2$s”', 'infraweaver-connector' ),
				$new_label,
				$old_label
			)
		) . '</h3>';

		echo '<p class="description">' . esc_html__( 'Green means the page got faster since the previous scan; red means slower. This is the easiest way to see what a settings change actually did.', 'infraweaver-connector' ) . '</p>';

		echo '<p>' . esc_html__( 'Site median:', 'infraweaver-connector' ) . ' '
			. '<strong>' . esc_html( sprintf( '%d ms', (int) $site['old_ms'] ) ) . '</strong> → '
			. '<strong>' . esc_html( sprintf( '%d ms', (int) $site['new_ms'] ) ) . '</strong> '
			. self::delta_badge( (int) $site['delta_ms'], (float) $site['pct'], (string) $site['direction'] )
			. '</p>';

		echo '<table class="widefat striped" style="max-width:1000px;margin-top:8px;"><thead><tr>';
		echo '<th>' . esc_html__( 'URL', 'infraweaver-connector' ) . '</th>';
		echo '<th>' . esc_html( sprintf( '“%s”', $old_label ) ) . '</th>';
		echo '<th>' . esc_html( sprintf( '“%s”', $new_label ) ) . '</th>';
		echo '<th>' . esc_html__( 'Change', 'infraweaver-connector' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $cmp['rows'] as $row ) {
			echo '<tr>';
			echo '<td><code>' . esc_html( (string) ( $row['path'] ?? $row['url'] ) ) . '</code></td>';
			if ( ! empty( $row['matched'] ) ) {
				echo '<td>' . esc_html( sprintf( '%d ms', (int) $row['old_ms'] ) ) . '</td>';
				echo '<td>' . esc_html( sprintf( '%d ms', (int) $row['new_ms'] ) ) . '</td>';
				echo '<td>' . self::delta_badge( (int) $row['delta_ms'], (float) $row['pct'], (string) $row['direction'] ) . '</td>';
			} else {
				echo '<td>—</td>';
				echo '<td>' . esc_html( sprintf( '%d ms', (int) $row['new_ms'] ) ) . '</td>';
				echo '<td><span class="description">' . esc_html__( 'new this scan', 'infraweaver-connector' ) . '</span></td>';
			}
			echo '</tr>';
		}
		echo '</tbody></table>';
	}

	/** The "clear snapshots" control + a small history count. */
	private function render_history_controls( int $count ): void {
		$action = function_exists( 'admin_url' ) ? admin_url( 'admin-post.php' ) : '';
		echo '<p style="margin-top:16px;" class="description">'
			. esc_html( sprintf( 'Keeping the last %d scans (currently %d).', (int) self::MAX_SNAPSHOTS, (int) $count ) )
			. '</p>';
		echo '<form method="post" action="' . esc_url( $action ) . '" style="margin:0;">';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::CLEAR_NONCE );
		}
		echo '<input type="hidden" name="action" value="' . esc_attr( self::CLEAR_ACTION ) . '">';
		echo '<button type="submit" class="button">' . esc_html__( 'Clear all snapshots', 'infraweaver-connector' ) . '</button>'
			. iwsl_field_help( 'Throw away every saved scan and start fresh.' );
		echo '</form>';
	}

	/** A coloured delta badge: e.g. "−120 ms (18.2% faster)". */
	private static function delta_badge( int $delta_ms, float $pct, string $direction ): string {
		$colors = array(
			'faster' => '#46803a',
			'slower' => '#b32d2e',
			'same'   => '#646970',
			'new'    => '#646970',
		);
		$color = $colors[ $direction ] ?? '#646970';
		if ( 'same' === $direction ) {
			$text = 'no change';
		} else {
			$sign = $delta_ms < 0 ? '−' : '+';
			$word = 'faster' === $direction ? 'faster' : 'slower';
			$text = sprintf( '%s%d ms (%s%.1f%% %s)', $sign, abs( $delta_ms ), $pct < 0 ? '−' : '+', abs( $pct ), $word );
		}
		$esc = function_exists( 'esc_html' ) ? esc_html( $text ) : htmlspecialchars( $text, ENT_QUOTES );
		$att = function_exists( 'esc_attr' ) ? esc_attr( $color ) : $color;
		return '<span style="color:' . $att . ';font-weight:600;">' . $esc . '</span>';
	}

	/** Colour for a single median value against the FAST_MS / SLOW_MS thresholds. */
	private static function ms_color( int $ms ): string {
		if ( $ms <= self::FAST_MS ) {
			return '#46803a';
		}
		if ( $ms > self::SLOW_MS ) {
			return '#b32d2e';
		}
		return '#8a6d00';
	}

	/** The locked-state notice, mirroring the other Pro engines. */
	private function render_locked_notice( array $gate ): void {
		$messages = array(
			'not-linked'      => __( 'This site is not linked to the console.', 'infraweaver-connector' ),
			'heartbeat-stale' => __( 'The console has not verified this site recently.', 'infraweaver-connector' ),
			'requires-plus'   => __( 'Response Time Scanner requires a Pro plan.', 'infraweaver-connector' ),
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>'
			. esc_html__( '🔒 Response Time Scanner is locked.', 'infraweaver-connector' )
			. '</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) ( $gate['reasons'] ?? array() ) as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	/** Render (then clear) the current user's PRG result transient. */
	private function render_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			if ( isset( $_GET['iwsl_response_scan_cleared'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
				echo '<div class="notice notice-info inline" style="margin-top:12px;padding:10px;"><p>' . esc_html__( 'Snapshots cleared.', 'infraweaver-connector' ) . '</p></div>';
			}
			return;
		}
		if ( isset( $_GET['iwsl_response_scan_cleared'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-info inline" style="margin-top:12px;padding:10px;"><p>' . esc_html__( 'Snapshots cleared.', 'infraweaver-connector' ) . '</p></div>';
		}
		$key    = self::RESULT_PREFIX . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		if ( ! empty( $result['ok'] ) ) {
			$n = isset( $result['targets'] ) && is_array( $result['targets'] ) ? count( $result['targets'] ) : 0;
			echo '<div class="notice notice-success" style="margin-top:12px;padding:12px;"><p>'
				. esc_html( sprintf( 'Scan complete — %d URL(s) timed. See the results below.', $n ) ) . '</p></div>';
		} else {
			$reasons = array(
				'entitlement-locked' => __( 'the feature is locked', 'infraweaver-connector' ),
				'no-home-url'        => __( 'the site URL could not be determined', 'infraweaver-connector' ),
				'no-targets'         => __( 'no valid same-site URLs were given', 'infraweaver-connector' ),
			);
			$why = (string) ( $result['reason'] ?? 'unknown' );
			$why = $reasons[ $why ] ?? $why;
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p>'
				. esc_html( sprintf( 'Scan did not run: %s.', $why ) ) . '</p></div>';
		}
	}

	// ── small pure formatters + parse helpers ───────────────────────────────────

	/** Human byte size, e.g. "42.1 KB". Render-only. */
	public static function format_bytes( int $bytes ): string {
		$bytes = max( 0, $bytes );
		if ( $bytes < 1024 ) {
			return $bytes . ' B';
		}
		$kb = $bytes / 1024.0;
		if ( $kb < 1024 ) {
			return sprintf( '%.1f KB', $kb );
		}
		return sprintf( '%.1f MB', $kb / 1024.0 );
	}

	/** Strip only the #fragment from a URL (query is significant, kept). */
	public static function normalize_url( string $url ): string {
		$url = trim( $url );
		$h   = strpos( $url, '#' );
		if ( false !== $h ) {
			$url = substr( $url, 0, $h );
		}
		return $url;
	}

	/** The path (+query) of a URL for compact display; the full URL if unparseable. */
	public static function path_of( string $url ): string {
		$parts = self::parse_url( $url );
		if ( null === $parts ) {
			return $url;
		}
		$path = isset( $parts['path'] ) ? (string) $parts['path'] : '/';
		if ( '' === $path ) {
			$path = '/';
		}
		if ( isset( $parts['query'] ) && '' !== (string) $parts['query'] ) {
			$path .= '?' . (string) $parts['query'];
		}
		return $path;
	}

	/** Lowercased host of a URL, '' when unparseable. */
	public static function host_of( string $url ): string {
		$parts = self::parse_url( $url );
		if ( null !== $parts && isset( $parts['host'] ) && is_string( $parts['host'] ) ) {
			return strtolower( $parts['host'] );
		}
		return '';
	}

	/** Snapshot results as a list, defensively. @return array<int,array> */
	private static function snapshot_results( array $snapshot ): array {
		$rows = is_array( $snapshot['results'] ?? null ) ? $snapshot['results'] : array();
		$out  = array();
		foreach ( $rows as $r ) {
			if ( is_array( $r ) ) {
				$out[] = $r;
			}
		}
		return $out;
	}

	/** Split a textarea string or array into a flat list of lines. @param mixed $raw @return string[] */
	private static function to_lines( $raw ): array {
		if ( is_array( $raw ) ) {
			$lines = array();
			foreach ( $raw as $item ) {
				if ( is_scalar( $item ) ) {
					$lines[] = (string) $item;
				}
			}
			return $lines;
		}
		if ( ! is_scalar( $raw ) ) {
			return array();
		}
		$parts = preg_split( '/[\r\n]+/', (string) $raw );
		return is_array( $parts ) ? $parts : array();
	}

	/** Strip control chars (keep tab/newline), length-cap a URL-list textarea string. */
	private static function clip_textarea( string $s ): string {
		$s = preg_replace( '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', '', $s );
		$s = null === $s ? '' : $s;
		if ( strlen( $s ) > self::MAX_URLS_TEXT_LEN ) {
			$s = substr( $s, 0, self::MAX_URLS_TEXT_LEN );
		}
		return $s;
	}

	/** Join a base URL and a path with exactly one slash. */
	private static function join_url( string $base, string $path ): string {
		return rtrim( $base, '/' ) . '/' . ltrim( $path, '/' );
	}

	/** Parse a URL, wp_parse_url when available, else parse_url. @return array|null */
	private static function parse_url( string $url ) {
		$parts = function_exists( 'wp_parse_url' ) ? wp_parse_url( $url ) : parse_url( $url );
		return is_array( $parts ) ? $parts : null;
	}

	// ── defaults (WordPress-derived, guarded for the harness) ───────────────────

	/** The site's home URL from home_url('/'), '' outside WordPress. */
	private static function default_home_url(): string {
		if ( function_exists( 'home_url' ) ) {
			$home = home_url( '/' );
			if ( is_string( $home ) && '' !== $home ) {
				return $home;
			}
		}
		return '';
	}

	/**
	 * The default HTTP fetcher: a blocking wp_remote_get normalized to
	 * { code, body, bytes, content_length, error }. Returns code 0 with an error
	 * outside a WP HTTP context so a run there records "no response" rather than
	 * inventing a number.
	 *
	 * @return callable(string,int):array
	 */
	private static function default_fetcher(): callable {
		return static function ( string $url, int $timeout_s ): array {
			if ( ! function_exists( 'wp_remote_get' ) ) {
				return array( 'code' => 0, 'body' => '', 'bytes' => 0, 'content_length' => 0, 'error' => 'no-http-api' );
			}
			$args     = array(
				'timeout'     => max( 1, (int) $timeout_s ),
				'redirection' => 5,
				'sslverify'   => true,
				'blocking'    => true,
				'headers'     => array( 'Accept' => 'text/html,application/xhtml+xml,*/*' ),
			);
			$response = wp_remote_get( $url, $args );
			if ( function_exists( 'is_wp_error' ) && is_wp_error( $response ) ) {
				$msg = ( is_object( $response ) && method_exists( $response, 'get_error_message' ) ) ? (string) $response->get_error_message() : 'request-failed';
				return array( 'code' => 0, 'body' => '', 'bytes' => 0, 'content_length' => 0, 'error' => '' !== $msg ? $msg : 'request-failed' );
			}
			$code = function_exists( 'wp_remote_retrieve_response_code' ) ? (int) wp_remote_retrieve_response_code( $response ) : 0;
			$body = function_exists( 'wp_remote_retrieve_body' ) ? (string) wp_remote_retrieve_body( $response ) : '';
			$clh  = function_exists( 'wp_remote_retrieve_header' ) ? wp_remote_retrieve_header( $response, 'content-length' ) : '';
			if ( is_array( $clh ) ) {
				$clh = isset( $clh[0] ) ? $clh[0] : '';
			}
			return array(
				'code'           => $code,
				'body'           => $body,
				'bytes'          => strlen( $body ),
				'content_length' => is_numeric( $clh ) ? (int) $clh : 0,
				'error'          => '',
			);
		};
	}
}
