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

	/**
	 * Known social-network referrer hosts (www-stripped, lower-case). Matched by
	 * subdomain-suffix (host === h OR host ends with ".".h) so link-shim subdomains
	 * (l.facebook.com, out.reddit.com) fold into the parent network. Used only by the
	 * pure channel() classifier — never for a network call.
	 *
	 * @var string[]
	 */
	const SOCIAL_HOSTS = array(
		'facebook.com', 'm.facebook.com', 'l.facebook.com', 'instagram.com',
		'l.instagram.com', 't.co', 'x.com', 'twitter.com', 'linkedin.com', 'lnkd.in',
		'reddit.com', 'out.reddit.com', 'pinterest.com', 'youtube.com',
		'news.ycombinator.com', 'mastodon.social', 'bsky.app', 'threads.net',
	);

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
	 * @param array<int, array>  $rows       Stored rows (any order); each row is normalized here.
	 * @param int                $now        Current unix seconds.
	 * @param int                $range_days KPI window (1 = today, 7, 30).
	 * @param DateTimeZone|null  $tz         Wall-clock zone for the hour×day heatmap (UTC when null).
	 * @return array
	 */
	public static function aggregate( array $rows, int $now, int $range_days, ?DateTimeZone $tz = null ): array {
		$range_days = max( 1, $range_days );
		$rows       = array_map( array( __CLASS__, 'normalize_row' ), $rows );
		$tz         = $tz ?? new DateTimeZone( 'UTC' );

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

		$quality      = self::quality( $cur_views );
		$prev_quality = self::quality( $prev_views );
		$entry_exit   = self::entry_exit( $cur_views );
		$grid         = self::hour_dow( $cur_views, $tz );
		$is_today     = 1 === $range_days;

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
			'daily_quality'  => self::daily_quality( $rows, $today_start ),
			'top_pages'      => self::top_by( $cur_views, 'path' ),
			'top_referrers'  => self::top_by( self::with_field( $cur_all, 'referer_host' ), 'referer_host' ),
			'search_engines' => self::top_by( self::with_field( $cur_all, 'search_engine' ), 'search_engine' ),
			'browsers'       => self::top_by( $cur_views, 'browser' ),
			'os'             => self::top_by( $cur_views, 'os' ),
			'devices'        => self::top_by( $cur_views, 'device' ),
			'countries'      => self::top_by( $cur_views, 'country' ),
			'channels'       => self::channels( $cur_views ),
			'entries'        => $entry_exit['entries'],
			'exits'          => $entry_exit['exits'],
			'searches'       => self::top_searches( $cur_all ),
			'heatmap'        => $grid,
			'heat_summary'   => self::heat_summary( $grid ),
			'quality'        => array(
				'bounce_pct'      => $quality['bounce_pct'],
				'pages_per_visit' => $quality['pages_per_visit'],
				'bounced'         => $quality['bounced'],
				'visits'          => $quality['visits'],
				'prev_bounce_pct' => $prev_quality['bounce_pct'],
				'prev_ppv'        => $prev_quality['pages_per_visit'],
			),
			'hourly'         => $is_today ? self::hourly_series( $rows, $today_start ) : array(),
			'hourly_prev'    => $is_today ? self::hourly_series( $rows, $today_start - self::DAY_SECONDS ) : array(),
			'drill'          => self::drill_payload( $cur_views, $today_start ),
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

	// ── engagement quality (bounce, pages/visit) ───────────────────────────────

	/**
	 * View-row count per visit id (empty ids ignored). The raw material for bounce
	 * (depth === 1) and pages/visit.
	 *
	 * @param array<int, array> $rows
	 * @return array<string, int> visit_id => view count
	 */
	public static function visit_depths( array $rows ): array {
		$depths = array();
		foreach ( $rows as $raw ) {
			$r = self::normalize_row( $raw );
			if ( self::EVENT_VIEW !== $r['event_type'] || '' === $r['visit_id'] ) {
				continue;
			}
			$depths[ $r['visit_id'] ] = ( isset( $depths[ $r['visit_id'] ] ) ? $depths[ $r['visit_id'] ] : 0 ) + 1;
		}
		return $depths;
	}

	/**
	 * Engagement quality over a row set: bounce rate (share of visits with exactly one
	 * view) and pages-per-visit (view rows ÷ distinct visits). Both zero on no visits.
	 *
	 * @param array<int, array> $rows
	 * @return array{ bounce_pct:float, pages_per_visit:float, bounced:int, visits:int }
	 */
	public static function quality( array $rows ): array {
		$depths      = self::visit_depths( $rows );
		$visits      = count( $depths );
		$bounced     = 0;
		$total_views = 0;
		foreach ( $depths as $depth ) {
			$total_views += $depth;
			if ( 1 === $depth ) {
				$bounced++;
			}
		}
		return array(
			'bounce_pct'      => $visits > 0 ? round( ( $bounced / $visits ) * 100, 1 ) : 0.0,
			'pages_per_visit' => $visits > 0 ? round( $total_views / $visits, 2 ) : 0.0,
			'bounced'         => $bounced,
			'visits'          => $visits,
		);
	}

	/**
	 * Per-day bounce rate + pages-per-visit for the SERIES_DAYS window ending today,
	 * oldest → newest, zero-filled — the source for the KPI sparklines.
	 *
	 * @param array<int, array> $rows
	 * @return array<int, array{ day:string, bounce_pct:float, ppv:float }>
	 */
	public static function daily_quality( array $rows, int $today_start ): array {
		$buckets = array();
		for ( $i = self::SERIES_DAYS - 1; $i >= 0; $i-- ) {
			$start             = $today_start - ( $i * self::DAY_SECONDS );
			$buckets[ $start ] = array( 'day' => gmdate( 'Y-m-d', $start ), 'rows' => array() );
		}
		$earliest = $today_start - ( ( self::SERIES_DAYS - 1 ) * self::DAY_SECONDS );
		$latest   = $today_start + self::DAY_SECONDS;
		foreach ( $rows as $raw ) {
			$r = self::normalize_row( $raw );
			if ( self::EVENT_VIEW !== $r['event_type'] ) {
				continue;
			}
			$at = $r['hit_at'];
			if ( $at < $earliest || $at >= $latest ) {
				continue;
			}
			$start = $at - ( $at % self::DAY_SECONDS );
			if ( isset( $buckets[ $start ] ) ) {
				$buckets[ $start ]['rows'][] = $r;
			}
		}
		$out = array();
		foreach ( $buckets as $b ) {
			$q     = self::quality( $b['rows'] );
			$out[] = array(
				'day'        => $b['day'],
				'bounce_pct' => $q['bounce_pct'],
				'ppv'        => $q['pages_per_visit'],
			);
		}
		return $out;
	}

	/**
	 * A 24-slot hourly view/visit series for the single calendar day starting at
	 * $day_start (buckets are hours relative to that midnight). Used for the range=1
	 * "today, by hour" chart and its previous-day compare ghost.
	 *
	 * @param array<int, array> $rows
	 * @return array<int, array{ hour:int, views:int, visits:int }>
	 */
	public static function hourly_series( array $rows, int $day_start ): array {
		$buckets = array();
		for ( $h = 0; $h < 24; $h++ ) {
			$buckets[ $h ] = array( 'hour' => $h, 'views' => 0, 'visits' => array() );
		}
		$end = $day_start + self::DAY_SECONDS;
		foreach ( $rows as $raw ) {
			$r = self::normalize_row( $raw );
			if ( self::EVENT_VIEW !== $r['event_type'] ) {
				continue;
			}
			$at = $r['hit_at'];
			if ( $at < $day_start || $at >= $end ) {
				continue;
			}
			$h = (int) floor( ( $at - $day_start ) / 3600 );
			if ( $h < 0 || $h > 23 ) {
				continue;
			}
			$buckets[ $h ]['views']++;
			if ( '' !== $r['visit_id'] ) {
				$buckets[ $h ]['visits'][ $r['visit_id'] ] = true;
			}
		}
		$out = array();
		foreach ( $buckets as $b ) {
			$out[] = array( 'hour' => (int) $b['hour'], 'views' => (int) $b['views'], 'visits' => count( $b['visits'] ) );
		}
		return $out;
	}

	// ── acquisition channels ───────────────────────────────────────────────────

	/**
	 * Classify one hit's acquisition channel from its (already parsed) referrer host
	 * and search-engine name. Precedence: a search engine → "search"; no referrer host
	 * → "direct"; a known social host (subdomain-suffix) → "social"; else "referral".
	 *
	 * @return string One of direct|search|referral|social.
	 */
	public static function channel( string $referer_host, string $search_engine ): string {
		if ( '' !== trim( $search_engine ) ) {
			return 'search';
		}
		$host = strtolower( trim( $referer_host ) );
		if ( '' === $host ) {
			return 'direct';
		}
		if ( self::is_social_host( $host ) ) {
			return 'social';
		}
		return 'referral';
	}

	/** Whether a host equals or is a subdomain of any SOCIAL_HOSTS entry. */
	public static function is_social_host( string $host ): bool {
		$host = strtolower( $host );
		foreach ( self::SOCIAL_HOSTS as $h ) {
			if ( $host === $h || ( strlen( $host ) > strlen( $h ) && substr( $host, -( strlen( $h ) + 1 ) ) === '.' . $h ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Visits grouped by their ENTRY channel — each visit classified once by its first
	 * (earliest, ties→row order) view row's referrer/search-engine. Sorted desc, zeros
	 * dropped. Labels are Title-cased (Direct/Search/Referral/Social).
	 *
	 * @param array<int, array> $rows
	 * @return array<int, array{ label:string, count:int }>
	 */
	public static function channels( array $rows ): array {
		$first = self::first_view_per_visit( $rows );
		$counts = array( 'Direct' => 0, 'Search' => 0, 'Referral' => 0, 'Social' => 0 );
		foreach ( $first as $r ) {
			$counts[ ucfirst( self::channel( $r['referer_host'], $r['search_engine'] ) ) ]++;
		}
		return self::top_n( array_filter( $counts ), self::TOP_N );
	}

	/** The earliest view row per visit id (ties → first in array order). @return array<string, array> */
	private static function first_view_per_visit( array $rows ): array {
		$first = array();
		foreach ( $rows as $raw ) {
			$r = self::normalize_row( $raw );
			if ( self::EVENT_VIEW !== $r['event_type'] || '' === $r['visit_id'] ) {
				continue;
			}
			$vid = $r['visit_id'];
			if ( ! isset( $first[ $vid ] ) || $r['hit_at'] < $first[ $vid ]['hit_at'] ) {
				$first[ $vid ] = $r;
			}
		}
		return $first;
	}

	/**
	 * Top entry + exit pages: for each visit, the path of its earliest and latest view
	 * row (ties → first in array order); counted and ranked top-N.
	 *
	 * @param array<int, array> $rows
	 * @return array{ entries:array<int, array{label:string,count:int}>, exits:array<int, array{label:string,count:int}> }
	 */
	public static function entry_exit( array $rows ): array {
		$first = array();
		$last  = array();
		foreach ( $rows as $raw ) {
			$r = self::normalize_row( $raw );
			if ( self::EVENT_VIEW !== $r['event_type'] || '' === $r['visit_id'] ) {
				continue;
			}
			$vid = $r['visit_id'];
			if ( ! isset( $first[ $vid ] ) || $r['hit_at'] < $first[ $vid ]['hit_at'] ) {
				$first[ $vid ] = $r;
			}
			if ( ! isset( $last[ $vid ] ) || $r['hit_at'] > $last[ $vid ]['hit_at'] ) {
				$last[ $vid ] = $r;
			}
		}
		return array(
			'entries' => self::top_by( array_values( $first ), 'path' ),
			'exits'   => self::top_by( array_values( $last ), 'path' ),
		);
	}

	/**
	 * A 7×24 (Monday row 0 … Sunday row 6) grid of view counts bucketed into the given
	 * wall-clock zone. Pure: DateTimeZone is injected so the harness can assert UTC.
	 *
	 * @param array<int, array> $rows
	 * @return array<int, array<int, int>>
	 */
	public static function hour_dow( array $rows, DateTimeZone $tz ): array {
		$grid = array();
		for ( $d = 0; $d < 7; $d++ ) {
			$grid[ $d ] = array_fill( 0, 24, 0 );
		}
		foreach ( $rows as $raw ) {
			$r = self::normalize_row( $raw );
			if ( self::EVENT_VIEW !== $r['event_type'] || $r['hit_at'] <= 0 ) {
				continue;
			}
			$dt   = ( new DateTimeImmutable( '@' . $r['hit_at'] ) )->setTimezone( $tz );
			$dow  = (int) $dt->format( 'N' ) - 1; // 1=Mon..7=Sun → 0..6
			$hour = (int) $dt->format( 'G' );     // 0..23
			if ( $dow >= 0 && $dow < 7 && $hour >= 0 && $hour < 24 ) {
				$grid[ $dow ][ $hour ]++;
			}
		}
		return $grid;
	}

	/**
	 * A one-line English summary of a 7×24 heatmap grid: busiest cell + quietest day.
	 * Deterministic (ties → earliest day/hour). Empty grid → an inviting placeholder.
	 *
	 * @param array<int, array<int, int>> $grid
	 */
	public static function heat_summary( array $grid ): string {
		$days = array( 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday' );
		$best_val  = -1;
		$best_d    = 0;
		$best_h    = 0;
		$day_total = array_fill( 0, 7, 0 );
		$total     = 0;
		for ( $d = 0; $d < 7; $d++ ) {
			for ( $h = 0; $h < 24; $h++ ) {
				$v = isset( $grid[ $d ][ $h ] ) ? (int) $grid[ $d ][ $h ] : 0;
				$day_total[ $d ] += $v;
				$total          += $v;
				if ( $v > $best_val ) {
					$best_val = $v;
					$best_d   = $d;
					$best_h   = $h;
				}
			}
		}
		if ( $total <= 0 ) {
			return 'No activity recorded yet.';
		}
		$quiet_d   = 0;
		$quiet_val = PHP_INT_MAX;
		for ( $d = 0; $d < 7; $d++ ) {
			if ( $day_total[ $d ] < $quiet_val ) {
				$quiet_val = $day_total[ $d ];
				$quiet_d   = $d;
			}
		}
		return sprintf(
			'Busiest around %s %02d:00; quietest on %s.',
			$days[ $best_d ],
			$best_h,
			$days[ $quiet_d ]
		);
	}

	/** Top on-site search queries (event_type=search) ranked by event_label. */
	public static function top_searches( array $rows ): array {
		$searches = array();
		foreach ( $rows as $raw ) {
			$r = self::normalize_row( $raw );
			if ( self::EVENT_SEARCH === $r['event_type'] ) {
				$searches[] = $r;
			}
		}
		return self::top_by( $searches, 'event_label' );
	}

	/** Rows whose $field exactly equals $value (normalized). @return array<int, array> */
	public static function filter_rows( array $rows, string $field, string $value ): array {
		$out = array();
		foreach ( $rows as $raw ) {
			$r = self::normalize_row( $raw );
			if ( ( isset( $r[ $field ] ) ? (string) $r[ $field ] : '' ) === $value ) {
				$out[] = $r;
			}
		}
		return $out;
	}

	/**
	 * The bounded per-dimension drill model consumed client-side by the drawer. For the
	 * four drillable dims (page, referrer, country, channel) it yields, per top-N key
	 * (≤TOP_N), one entry: window views/visits/share/bounce, a SERIES_DAYS view series,
	 * and two complementary top-5 pair lists. No key, list, or series is unbounded, so
	 * the emitted JSON island stays ~15 KB.
	 *
	 * @param array<int, array> $rows View rows for the selected window.
	 * @return array<string, array<string, array>>
	 */
	public static function drill_payload( array $rows, int $today_start ): array {
		$views = array();
		foreach ( $rows as $raw ) {
			$r = self::normalize_row( $raw );
			if ( self::EVENT_VIEW === $r['event_type'] ) {
				$views[] = $r;
			}
		}
		$total = count( $views );
		$out   = array(
			'page'     => array(),
			'referrer' => array(),
			'country'  => array(),
			'channel'  => array(),
		);

		foreach ( self::top_by( $views, 'path' ) as $row ) {
			$key                  = $row['label'];
			$out['page'][ $key ]  = self::drill_entry( self::filter_rows( $views, 'path', $key ), $total, $today_start, 'referer_host', 'country' );
		}
		foreach ( self::top_by( self::with_field( $views, 'referer_host' ), 'referer_host' ) as $row ) {
			$key                      = $row['label'];
			$out['referrer'][ $key ]  = self::drill_entry( self::filter_rows( $views, 'referer_host', $key ), $total, $today_start, 'path', 'country' );
		}
		foreach ( self::top_by( $views, 'country' ) as $row ) {
			$key                     = $row['label'];
			$out['country'][ $key ]  = self::drill_entry( self::filter_rows( $views, 'country', $key ), $total, $today_start, 'path', 'device' );
		}

		$by_channel = array( 'direct' => array(), 'search' => array(), 'referral' => array(), 'social' => array() );
		foreach ( $views as $r ) {
			$by_channel[ self::channel( $r['referer_host'], $r['search_engine'] ) ][] = $r;
		}
		$a_field = array( 'direct' => 'path', 'search' => 'search_engine', 'referral' => 'referer_host', 'social' => 'referer_host' );
		$b_field = array( 'direct' => 'country', 'search' => 'path', 'referral' => 'path', 'social' => 'path' );
		foreach ( $by_channel as $cid => $subset ) {
			if ( array() === $subset ) {
				continue;
			}
			$out['channel'][ $cid ] = self::drill_entry( $subset, $total, $today_start, $a_field[ $cid ], $b_field[ $cid ] );
		}
		return $out;
	}

	/** One drill entry: window scalars + a SERIES_DAYS view series + two top-5 pair lists. */
	private static function drill_entry( array $subset, int $total_views, int $today_start, string $a_field, string $b_field ): array {
		$views  = count( $subset );
		$visits = self::distinct_visits( $subset );
		$q      = self::quality( $subset );
		$series = array();
		foreach ( self::daily_series( $subset, $today_start ) as $d ) {
			$series[] = (int) $d['views'];
		}
		return array(
			'views'      => $views,
			'visits'     => $visits,
			'share_pct'  => $total_views > 0 ? round( ( $views / $total_views ) * 100, 1 ) : 0.0,
			'bounce_pct' => $q['bounce_pct'],
			'series'     => $series,
			'a'          => self::pairs( self::top_by( self::with_field( $subset, $a_field ), $a_field ), 5 ),
			'b'          => self::pairs( self::top_by( self::with_field( $subset, $b_field ), $b_field ), 5 ),
		);
	}

	/** Flatten the first $n {label,count} rows into compact [label,count] pairs. */
	private static function pairs( array $rows, int $n ): array {
		$out = array();
		foreach ( array_slice( $rows, 0, max( 0, $n ) ) as $r ) {
			$out[] = array( (string) $r['label'], (int) $r['count'] );
		}
		return $out;
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
