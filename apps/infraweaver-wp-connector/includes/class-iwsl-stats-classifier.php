<?php
/**
 * Pure, dependency-free classifiers + aggregation math behind the gated "Site
 * Statistics" feature (flag `statistics`, tier Ultimate). This file is the
 * testable brain of IWSL_Statistics: it holds ONLY static, side-effect-free
 * functions that turn one raw request (a User-Agent string, a referrer, request
 * headers) into a small bounded row of privacy-safe fields, and that fold a set
 * of stored rows into a dashboard model (KPIs, time series, top-N breakdowns).
 *
 * WHY SEPARATE. Every function here is a pure map from inputs to outputs — no
 * $wpdb, no clock beyond an injected `$now`, no global state. That is exactly
 * what lets the zero-dependency harness assert the UA/referrer/country logic and
 * the aggregation math directly, with no WordPress and no database.
 *
 * PRIVACY. Nothing here ever sees, stores, or hashes a raw IP address. Country is
 * derived only from a Cloudflare edge header (already a coarse 2-letter code) or
 * the first Accept-Language region, else "Unknown". The "visit id" is a coarse
 * daily hash bucket of (day + UA + language + per-install salt) — an anonymous
 * approximation of a unique visitor that cannot be reversed to a person, resets
 * every day, and never leaves the site. We ship a small HAND-WRITTEN UA classifier
 * (a bounded allow-list of the common browsers/OSes), never a large UA library.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Stats_Classifier {

	/** Byte ceilings mirroring the stats table's VARCHAR widths (defence in depth). */
	const MAX_PATH_LEN  = 190;
	const MAX_HOST_LEN  = 190;
	const MAX_LABEL_LEN = 190;
	const MAX_SHORT_LEN = 32;

	/** Event-type vocabulary — a closed set so `event_type` can never carry free text. */
	const EVENT_VIEW    = 'view';
	const EVENT_SEARCH  = 'search';
	const EVENT_404     = 'not_found';
	const EVENT_COMMENT = 'comment';

	/** The device buckets. */
	const DEVICE_DESKTOP = 'desktop';
	const DEVICE_MOBILE  = 'mobile';
	const DEVICE_TABLET  = 'tablet';

	/** Sentinel for an undeterminable country. */
	const COUNTRY_UNKNOWN = 'Unknown';

	/** Seconds in a day — the visit-bucket + retention unit. */
	const DAY_SECONDS = 86400;

	/** "Online now" window (seconds) — distinct visits seen this recently. */
	const ONLINE_WINDOW_S = 300;

	/** Rows shown in the recent-events stream. */
	const MAX_RECENT_EVENTS = 25;

	/** Top-N cap for every ranked breakdown/table. */
	const TOP_N = 10;

	/** Days in the dashboard time-series (independent of the KPI range switch). */
	const SERIES_DAYS = 30;

	// ── bot detection (a small, bounded substring denylist) ────────────────────

	/**
	 * Whether a User-Agent looks like a crawler/preview bot. A deliberately SMALL,
	 * hand-maintained substring list (lower-cased) — not a UA database. Anything
	 * matching is excluded from recording so bots never inflate the numbers.
	 *
	 * @return string[]
	 */
	public static function bot_needles(): array {
		return array(
			'bot', 'crawl', 'spider', 'slurp', 'mediapartners', 'bingpreview',
			'facebookexternalhit', 'facebot', 'embedly', 'quora link preview',
			'pinterest', 'feedfetcher', 'feedburner', 'curl/', 'wget/',
			'python-requests', 'go-http-client', 'headlesschrome', 'phantomjs',
			'ahrefs', 'semrush', 'mj12', 'dotbot', 'dataprovider', 'petalbot',
			'yandeximages', 'archive.org_bot', 'uptimerobot', 'monitis',
		);
	}

	/** True when the User-Agent matches the bounded bot denylist (or is empty). */
	public static function is_bot( string $ua ): bool {
		$lc = strtolower( $ua );
		if ( '' === trim( $lc ) ) {
			return true; // an empty UA is a bot/script far more often than a person.
		}
		foreach ( self::bot_needles() as $needle ) {
			if ( false !== strpos( $lc, $needle ) ) {
				return true;
			}
		}
		return false;
	}

	/** Whether the Do-Not-Track signal is set to "1" in the request headers. */
	public static function dnt_set( array $server ): bool {
		$dnt = isset( $server['HTTP_DNT'] ) ? (string) $server['HTTP_DNT'] : '';
		return '1' === trim( $dnt );
	}

	// ── User-Agent classification (bounded, hand-written) ──────────────────────

	/**
	 * Classify a User-Agent into { browser, os, device } using a small ordered
	 * allow-list. Order matters (Edge/Opera before Chrome; Chrome before Safari)
	 * because those UAs are supersets of one another. Unknowns fall to "Other".
	 *
	 * @return array{ browser:string, os:string, device:string }
	 */
	public static function classify_ua( string $ua ): array {
		return array(
			'browser' => self::browser( $ua ),
			'os'      => self::os( $ua ),
			'device'  => self::device( $ua ),
		);
	}

	/** The browser family — ordered so superset UAs are tested last. */
	public static function browser( string $ua ): string {
		$u = $ua;
		if ( self::has( $u, 'Edg' ) ) {
			return 'Edge';
		}
		if ( self::has( $u, 'OPR' ) || self::has( $u, 'Opera' ) ) {
			return 'Opera';
		}
		if ( self::has( $u, 'SamsungBrowser' ) ) {
			return 'Samsung Internet';
		}
		if ( self::has( $u, 'Firefox' ) || self::has( $u, 'FxiOS' ) ) {
			return 'Firefox';
		}
		if ( self::has( $u, 'MSIE' ) || self::has( $u, 'Trident' ) ) {
			return 'Internet Explorer';
		}
		if ( self::has( $u, 'Chrome' ) || self::has( $u, 'CriOS' ) || self::has( $u, 'Chromium' ) ) {
			return 'Chrome';
		}
		if ( self::has( $u, 'Safari' ) ) {
			return 'Safari';
		}
		return 'Other';
	}

	/** The operating-system family. */
	public static function os( string $ua ): string {
		$u = $ua;
		if ( self::has( $u, 'Windows' ) ) {
			return 'Windows';
		}
		if ( self::has( $u, 'iPhone' ) || self::has( $u, 'iPad' ) || self::has( $u, 'iPod' ) ) {
			return 'iOS';
		}
		if ( self::has( $u, 'Android' ) ) {
			return 'Android';
		}
		if ( self::has( $u, 'CrOS' ) ) {
			return 'Chrome OS';
		}
		if ( self::has( $u, 'Mac OS X' ) || self::has( $u, 'Macintosh' ) ) {
			return 'macOS';
		}
		if ( self::has( $u, 'Linux' ) ) {
			return 'Linux';
		}
		return 'Other';
	}

	/** Desktop / mobile / tablet from the UA shape. */
	public static function device( string $ua ): string {
		$u = $ua;
		if ( self::has( $u, 'iPad' ) ) {
			return self::DEVICE_TABLET;
		}
		if ( self::has( $u, 'Tablet' ) || ( self::has( $u, 'Android' ) && ! self::has( $u, 'Mobile' ) ) ) {
			return self::DEVICE_TABLET;
		}
		if ( self::has( $u, 'Mobile' ) || self::has( $u, 'iPhone' ) || self::has( $u, 'iPod' ) ) {
			return self::DEVICE_MOBILE;
		}
		return self::DEVICE_DESKTOP;
	}

	// ── referrer + search-engine parsing ───────────────────────────────────────

	/**
	 * The lowercased host of a referrer URL, bounded, or '' when absent/unparseable
	 * or same-origin (the caller passes '' for its own host). A leading "www." is
	 * stripped so google.com and www.google.com fold together.
	 */
	public static function referer_host( string $referer, string $self_host = '' ): string {
		if ( '' === trim( $referer ) ) {
			return '';
		}
		$parts = function_exists( 'wp_parse_url' ) ? wp_parse_url( $referer ) : parse_url( $referer );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) || ! is_string( $parts['host'] ) ) {
			return '';
		}
		$host = strtolower( $parts['host'] );
		if ( 0 === strpos( $host, 'www.' ) ) {
			$host = substr( $host, 4 );
		}
		if ( '' !== $self_host && $host === strtolower( $self_host ) ) {
			return ''; // internal navigation is not an external referrer.
		}
		return self::cap( $host, self::MAX_HOST_LEN );
	}

	/**
	 * Map a (www-stripped) referrer host to a known search engine's display name,
	 * or '' when it is not a search engine. Matched by substring so regional TLDs
	 * (google.co.uk, google.de) all fold to "Google".
	 */
	public static function search_engine_from_host( string $host ): string {
		$engines = array(
			'google'     => 'Google',
			'bing'       => 'Bing',
			'duckduckgo' => 'DuckDuckGo',
			'yahoo'      => 'Yahoo',
			'yandex'     => 'Yandex',
			'baidu'      => 'Baidu',
			'ecosia'     => 'Ecosia',
			'startpage'  => 'Startpage',
			'qwant'      => 'Qwant',
			'brave'      => 'Brave',
			'ask.'       => 'Ask',
		);
		$h = strtolower( $host );
		foreach ( $engines as $needle => $name ) {
			if ( false !== strpos( $h, $needle ) ) {
				return $name;
			}
		}
		return '';
	}

	// ── country derivation (CF header > Accept-Language region > Unknown) ──────

	/**
	 * Derive a coarse country. Precedence, cheapest and most trustworthy first:
	 *   1. Cloudflare's `CF-IPCOUNTRY` edge header (a validated 2-letter code),
	 *      ignoring its "unknown"/"Tor"/anonymous sentinels (XX, T1, A1, A2).
	 *   2. the region subtag of the first `Accept-Language` entry (en-US → US).
	 *   3. "Unknown".
	 * No IP is ever inspected and no external geo service is ever called.
	 */
	public static function country( ?string $cf_country, ?string $accept_language ): string {
		$cf = null === $cf_country ? '' : strtoupper( trim( $cf_country ) );
		if ( preg_match( '/^[A-Z]{2}$/', $cf ) && ! in_array( $cf, array( 'XX', 'T1', 'A1', 'A2' ), true ) ) {
			return $cf;
		}
		$region = self::accept_language_region( null === $accept_language ? '' : $accept_language );
		if ( '' !== $region ) {
			return $region;
		}
		return self::COUNTRY_UNKNOWN;
	}

	/** The 2-letter region of the first Accept-Language tag (en-US → US), or ''. */
	public static function accept_language_region( string $accept_language ): string {
		if ( '' === trim( $accept_language ) ) {
			return '';
		}
		$first = trim( (string) strtok( $accept_language, ',' ) ); // "en-US;q=0.9" → "en-US;q=0.9"
		$first = trim( (string) strtok( $first, ';' ) );           // → "en-US"
		$bits  = explode( '-', $first );
		if ( count( $bits ) >= 2 && preg_match( '/^[A-Za-z]{2}$/', $bits[1] ) ) {
			return strtoupper( $bits[1] );
		}
		return '';
	}

	// ── visitor bucketing (privacy-safe, no IP) ────────────────────────────────

	/**
	 * A coarse anonymous "visit id": a daily hash bucket of the day + UA + language
	 * + a per-install salt. It approximates one visitor for a single UTC day, resets
	 * daily, and is one-way — it can NEVER be reversed to an IP or a person. Two
	 * different people who share a UA + language + day collide by design; that is the
	 * privacy trade-off (we under-count uniques rather than track anyone).
	 */
	public static function visit_id( int $now_seconds, string $ua, string $accept_language, string $salt ): string {
		$day  = (int) floor( $now_seconds / self::DAY_SECONDS );
		$seed = $day . '|' . $ua . '|' . $accept_language . '|' . $salt;
		return substr( hash( 'sha256', $seed ), 0, 32 );
	}

	// ── request-path extraction ────────────────────────────────────────────────

	/** The bounded path (no query string) of the current request, or '/'. */
	public static function path_from( array $server ): string {
		$uri = isset( $server['REQUEST_URI'] ) ? (string) $server['REQUEST_URI'] : '/';
		$path = function_exists( 'wp_parse_url' ) ? wp_parse_url( $uri, PHP_URL_PATH ) : parse_url( $uri, PHP_URL_PATH );
		if ( ! is_string( $path ) || '' === $path ) {
			$path = '/';
		}
		$path = preg_replace( '/[\x00-\x1F\x7F]/', '', $path );
		return self::cap( null === $path ? '/' : $path, self::MAX_PATH_LEN );
	}

	// ── aggregation (pure fold over stored rows → dashboard model) ─────────────

	/**
	 * Fold a set of stored hit rows into the full dashboard model. Pure: given the
	 * same rows, `$now` and range it always returns the same structure, so the
	 * harness can assert every number. The time-series is always SERIES_DAYS long;
	 * the KPIs + breakdowns use the selected range window, with the immediately
	 * preceding window of equal length for the up/down comparison.
	 *
	 * @param array<int, array> $rows       Stored rows (any order); each row is normalized here.
	 * @param int               $now        Current unix seconds.
	 * @param int               $range_days KPI window (1 = today, 7, 30).
	 * @return array
	 */
	public static function aggregate( array $rows, int $now, int $range_days ): array {
		$range_days = max( 1, $range_days );
		$rows       = array_map( array( __CLASS__, 'normalize_row' ), $rows );

		$today_start  = $now - ( $now % self::DAY_SECONDS );
		$window       = $range_days * self::DAY_SECONDS;
		$cur_start    = $now - $window;
		$prev_start   = $now - ( 2 * $window );

		$cur_views  = array();
		$prev_views = array();
		$cur_all    = array();
		$views_today = 0;
		$events      = 0;
		$online      = array();

		foreach ( $rows as $r ) {
			$at      = $r['hit_at'];
			$is_view = self::EVENT_VIEW === $r['event_type'];

			if ( $at >= $now - self::ONLINE_WINDOW_S && $at <= $now ) {
				$online[ $r['visit_id'] ] = true;
			}
			if ( $at >= $cur_start && $at <= $now ) {
				$cur_all[] = $r;
				if ( $is_view ) {
					$cur_views[] = $r;
					if ( $at >= $today_start ) {
						$views_today++;
					}
				} else {
					$events++;
				}
			} elseif ( $at >= $prev_start && $at < $cur_start && $is_view ) {
				$prev_views[] = $r;
			}
		}

		$cur_view_count  = count( $cur_views );
		$prev_view_count = count( $prev_views );
		$cur_visits      = self::distinct_visits( $cur_views );
		$prev_visits     = self::distinct_visits( $prev_views );

		return array(
			'range_days' => $range_days,
			'generated'  => $now,
			'kpi'        => array(
				'views'             => $cur_view_count,
				'visits'            => $cur_visits,
				'events'            => $events,
				'views_today'       => $views_today,
				'online_now'        => count( $online ),
				'prev_views'        => $prev_view_count,
				'prev_visits'       => $prev_visits,
				'views_delta_pct'   => self::delta_pct( $cur_view_count, $prev_view_count ),
				'visits_delta_pct'  => self::delta_pct( $cur_visits, $prev_visits ),
			),
			'series'         => self::daily_series( $rows, $today_start ),
			'top_pages'      => self::top_by( $cur_views, 'path' ),
			'top_referrers'  => self::top_by( self::with_field( $cur_all, 'referer_host' ), 'referer_host' ),
			'search_engines' => self::top_by( self::with_field( $cur_all, 'search_engine' ), 'search_engine' ),
			'browsers'       => self::top_by( $cur_views, 'browser' ),
			'os'             => self::top_by( $cur_views, 'os' ),
			'devices'        => self::top_by( $cur_views, 'device' ),
			'countries'      => self::top_by( $cur_views, 'country' ),
			'recent_events'  => self::recent_events( $cur_all ),
		);
	}

	/** Count distinct visit ids across a row set. */
	public static function distinct_visits( array $rows ): int {
		$seen = array();
		foreach ( $rows as $r ) {
			$vid = isset( $r['visit_id'] ) ? (string) $r['visit_id'] : '';
			if ( '' !== $vid ) {
				$seen[ $vid ] = true;
			}
		}
		return count( $seen );
	}

	/** Percentage change cur vs prev, or null when there is no prior baseline. */
	public static function delta_pct( int $cur, int $prev ): ?float {
		if ( $prev <= 0 ) {
			return null;
		}
		return round( ( ( $cur - $prev ) / $prev ) * 100, 1 );
	}

	/**
	 * Top-N of a field across rows, ties broken by label ascending for determinism.
	 *
	 * @param array<int, array> $rows
	 * @return array<int, array{ label:string, count:int }>
	 */
	public static function top_by( array $rows, string $field ): array {
		$counts = array();
		foreach ( $rows as $r ) {
			$key = isset( $r[ $field ] ) ? (string) $r[ $field ] : '';
			if ( '' === $key ) {
				continue;
			}
			$counts[ $key ] = ( isset( $counts[ $key ] ) ? $counts[ $key ] : 0 ) + 1;
		}
		return self::top_n( $counts, self::TOP_N );
	}

	/**
	 * Turn a label => count map into a sorted top-N list. Sort is by count desc then
	 * label asc, so the output is stable regardless of insertion order.
	 *
	 * @param array<string, int> $counts
	 * @return array<int, array{ label:string, count:int }>
	 */
	public static function top_n( array $counts, int $n ): array {
		$pairs = array();
		foreach ( $counts as $label => $count ) {
			$pairs[] = array( 'label' => (string) $label, 'count' => (int) $count );
		}
		usort(
			$pairs,
			static function ( array $a, array $b ): int {
				if ( $a['count'] === $b['count'] ) {
					return strcmp( $a['label'], $b['label'] );
				}
				return $b['count'] - $a['count'];
			}
		);
		return array_slice( $pairs, 0, max( 0, $n ) );
	}

	/**
	 * The SERIES_DAYS daily view/visit series, oldest → newest, one entry per day
	 * ending today. Every day is present (zero-filled) so the chart x-axis is dense.
	 *
	 * @param array<int, array> $rows
	 * @return array<int, array{ day:string, views:int, visits:int }>
	 */
	public static function daily_series( array $rows, int $today_start ): array {
		$buckets = array();
		for ( $i = self::SERIES_DAYS - 1; $i >= 0; $i-- ) {
			$start = $today_start - ( $i * self::DAY_SECONDS );
			$buckets[ $start ] = array(
				'day'    => gmdate( 'Y-m-d', $start ),
				'views'  => 0,
				'visits' => array(),
			);
		}
		$earliest = $today_start - ( ( self::SERIES_DAYS - 1 ) * self::DAY_SECONDS );
		$latest   = $today_start + self::DAY_SECONDS;
		foreach ( $rows as $r ) {
			if ( self::EVENT_VIEW !== $r['event_type'] ) {
				continue;
			}
			$at = $r['hit_at'];
			if ( $at < $earliest || $at >= $latest ) {
				continue;
			}
			// The UTC-midnight bucket of this hit. `$today_start` is itself a midnight
			// (a multiple of DAY_SECONDS), so this aligns exactly with the bucket keys.
			$start = $at - ( $at % self::DAY_SECONDS );
			if ( ! isset( $buckets[ $start ] ) ) {
				continue;
			}
			$buckets[ $start ]['views']++;
			if ( '' !== $r['visit_id'] ) {
				$buckets[ $start ]['visits'][ $r['visit_id'] ] = true;
			}
		}
		$out = array();
		foreach ( $buckets as $b ) {
			$out[] = array(
				'day'    => $b['day'],
				'views'  => (int) $b['views'],
				'visits' => count( $b['visits'] ),
			);
		}
		return $out;
	}

	/**
	 * The most recent non-view events, newest first, capped at MAX_RECENT_EVENTS.
	 *
	 * @param array<int, array> $rows
	 * @return array<int, array{ at:int, type:string, label:string, path:string }>
	 */
	public static function recent_events( array $rows ): array {
		$events = array();
		foreach ( $rows as $r ) {
			if ( self::EVENT_VIEW === $r['event_type'] ) {
				continue;
			}
			$events[] = array(
				'at'    => $r['hit_at'],
				'type'  => $r['event_type'],
				'label' => $r['event_label'],
				'path'  => $r['path'],
			);
		}
		usort(
			$events,
			static function ( array $a, array $b ): int {
				return $b['at'] - $a['at'];
			}
		);
		return array_slice( $events, 0, self::MAX_RECENT_EVENTS );
	}

	// ── small helpers ──────────────────────────────────────────────────────────

	/** Rows whose $field is a non-empty string. @return array<int, array> */
	private static function with_field( array $rows, string $field ): array {
		$out = array();
		foreach ( $rows as $r ) {
			if ( isset( $r[ $field ] ) && '' !== (string) $r[ $field ] ) {
				$out[] = $r;
			}
		}
		return $out;
	}

	/**
	 * Coerce one stored row (from the DB or a fixture) into the strict typed shape
	 * the aggregation relies on. Unknown/missing fields default safely.
	 *
	 * @param mixed $row
	 * @return array{ hit_at:int, visit_id:string, path:string, referer_host:string,
	 *                search_engine:string, browser:string, os:string, device:string,
	 *                country:string, event_type:string, event_label:string }
	 */
	public static function normalize_row( $row ): array {
		$row = is_array( $row ) ? $row : array();
		$type = isset( $row['event_type'] ) ? (string) $row['event_type'] : self::EVENT_VIEW;
		if ( ! in_array( $type, array( self::EVENT_VIEW, self::EVENT_SEARCH, self::EVENT_404, self::EVENT_COMMENT ), true ) ) {
			$type = self::EVENT_VIEW;
		}
		return array(
			'hit_at'        => isset( $row['hit_at'] ) ? (int) $row['hit_at'] : 0,
			'visit_id'      => isset( $row['visit_id'] ) ? (string) $row['visit_id'] : '',
			'path'          => isset( $row['path'] ) ? (string) $row['path'] : '',
			'referer_host'  => isset( $row['referer_host'] ) ? (string) $row['referer_host'] : '',
			'search_engine' => isset( $row['search_engine'] ) ? (string) $row['search_engine'] : '',
			'browser'       => isset( $row['browser'] ) ? (string) $row['browser'] : '',
			'os'            => isset( $row['os'] ) ? (string) $row['os'] : '',
			'device'        => isset( $row['device'] ) ? (string) $row['device'] : '',
			'country'       => isset( $row['country'] ) ? (string) $row['country'] : '',
			'event_type'    => $type,
			'event_label'   => isset( $row['event_label'] ) ? (string) $row['event_label'] : '',
		);
	}

	/** Case-sensitive substring presence. */
	private static function has( string $haystack, string $needle ): bool {
		return false !== strpos( $haystack, $needle );
	}

	/** Hard byte cap on a string. */
	public static function cap( string $value, int $max ): string {
		return strlen( $value ) > $max ? substr( $value, 0, $max ) : $value;
	}
}
