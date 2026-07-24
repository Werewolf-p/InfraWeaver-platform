<?php
/**
 * Bounded, read-only aggregator behind the signed `sitehealth.snapshot` method —
 * the single round-trip that powers the console's whole Site Health surface. It
 * composes the three feature engines (maintenance, redirects, broken-link scan)
 * plus the pure suggestion engine into ONE small payload, so the console makes one
 * signed read instead of N-per-feature chatter.
 *
 * TRUST / TIERING. Every sub-section respects its own switch: the aggregator reads
 * each engine's entitlement gate and, when a flag is locked, emits a `locked`
 * marker with no data rather than leaking a lower tier's state (the console renders
 * an upsell card). The wp-cli checklist that powers Free sites is a SEPARATE console
 * probe — this class only adds the connector-backed sub-sections.
 *
 * BOUNDS (so a 500-rule / 100-entry site still yields a small reply):
 *  - redirects.top   ≤ TOP_REDIRECTS   (ranked by hits)
 *  - notfound.top    ≤ TOP_NOTFOUND    (ranked by count, ring-log ∪ statistics)
 *  - suggestions     ≤ TOP_NOTFOUND    (one per dead path)
 *  - broken_images   ≤ TOP_BROKEN_IMAGES (from the last persisted scan)
 *
 * PURITY. Engines, the published-paths provider and the statistics-404 provider are
 * all injected, so the harness drives the aggregator with real engines over an
 * in-memory store and asserts the exact shape and bounds with no WordPress present.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Site_Health {

	/** Cap on redirect rules carried in the snapshot (ranked by hits). */
	const TOP_REDIRECTS = 10;
	/** Cap on 404 rows carried in the snapshot (ranked by count). */
	const TOP_NOTFOUND = 20;
	/** Cap on broken images carried in the snapshot (feeds the Media explorer). */
	const TOP_BROKEN_IMAGES = 20;

	/** @var IWSL_Entitlements the per-flag gate (also drives the switches block). */
	private $entitlements;

	/** @var IWSL_Maintenance_Mode */
	private $maintenance;

	/** @var IWSL_Redirects */
	private $redirects;

	/** @var IWSL_Broken_Link_Scan */
	private $links;

	/** @var callable():string[] live published paths (redirect-suggestion targets). */
	private $published_provider;

	/** @var callable():array<int,array> extra 404 rows from statistics (EVENT_404). */
	private $notfound_provider;

	/**
	 * @param IWSL_Entitlements     $entitlements       Per-flag gate.
	 * @param IWSL_Maintenance_Mode $maintenance        Maintenance engine.
	 * @param IWSL_Redirects        $redirects          Redirect engine.
	 * @param IWSL_Broken_Link_Scan $links              Broken-link scanner.
	 * @param callable|null         $published_provider ():string[] live paths; default WP-backed.
	 * @param callable|null         $notfound_provider  ():array extra 404 rows; default empty.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		IWSL_Maintenance_Mode $maintenance,
		IWSL_Redirects $redirects,
		IWSL_Broken_Link_Scan $links,
		?callable $published_provider = null,
		?callable $notfound_provider = null
	) {
		$this->entitlements       = $entitlements;
		$this->maintenance        = $maintenance;
		$this->redirects          = $redirects;
		$this->links              = $links;
		$this->published_provider = null !== $published_provider ? $published_provider : self::default_published_provider();
		$this->notfound_provider  = null !== $notfound_provider ? $notfound_provider : self::default_notfound_provider();
	}

	/**
	 * The one bounded aggregate read. Shape:
	 * {
	 *   switches: { maintenance_mode:bool, redirect_manager:bool, broken_link_scan:bool, statistics:bool },
	 *   maintenance: { locked:bool, enabled?, headline?, message?, retry_after?, until?, allow_ips?, saved_at? },
	 *   links: { locked:bool, last_scan_summary: array|null },
	 *   redirects: { locked:bool, count:int, log_enabled:bool, auto_slug:bool, top:[{id,source,target,type,match,hits,external}…10] },
	 *   notfound: { locked:bool, top:[{path,count,last_seen,source}…20] },
	 *   suggestions: [{path,target,confidence}…20],
	 *   broken_images: [{post_id,url,attachment_id,status}…20],
	 * }
	 */
	public function snapshot(): array {
		$switches = array(
			'maintenance_mode' => $this->is_unlocked( 'maintenance_mode' ),
			'redirect_manager' => $this->is_unlocked( 'redirect_manager' ),
			'broken_link_scan' => $this->is_unlocked( 'broken_link_scan' ),
			'statistics'       => $this->is_unlocked( 'statistics' ),
		);

		$links_view = $this->links_view( $switches['broken_link_scan'] );
		$notfound   = $this->notfound_view( $switches['redirect_manager'], $switches['statistics'] );

		$suggestions = $switches['redirect_manager']
			? IWSL_Redirect_Suggestions::suggest( self::paths_of( $notfound['top'] ), $this->published_paths() )
			: array();

		return array(
			'switches'      => $switches,
			'maintenance'   => $this->maintenance_view( $switches['maintenance_mode'] ),
			'links'         => $links_view,
			'redirects'     => $this->redirects_view( $switches['redirect_manager'] ),
			'notfound'      => $notfound,
			'suggestions'   => $suggestions,
			'broken_images' => $this->broken_images_view( $links_view ),
		);
	}

	/** Whether a feature flag currently evaluates unlocked (linked + fresh + granted). */
	private function is_unlocked( string $flag ): bool {
		$gate = $this->entitlements->evaluate( $flag );
		return ! empty( $gate['unlocked'] );
	}

	// ── sub-section views (each respects its own switch) ────────────────────────

	/** Maintenance state, or a locked marker. */
	private function maintenance_view( bool $unlocked ): array {
		if ( ! $unlocked ) {
			return array( 'locked' => true );
		}
		$s = $this->maintenance->settings();
		return array(
			'locked'      => false,
			'enabled'     => ! empty( $s['enabled'] ),
			'headline'    => isset( $s['headline'] ) ? (string) $s['headline'] : '',
			'message'     => isset( $s['message'] ) ? (string) $s['message'] : '',
			'retry_after' => ! empty( $s['retry_after'] ),
			'until'       => isset( $s['until'] ) ? (int) $s['until'] : 0,
			'allow_ips'   => isset( $s['allow_ips'] ) && is_array( $s['allow_ips'] ) ? array_values( $s['allow_ips'] ) : array(),
			'saved_at'    => isset( $s['saved_at'] ) ? (int) $s['saved_at'] : 0,
		);
	}

	/** The last persisted scan summary, or a locked marker. */
	private function links_view( bool $unlocked ): array {
		if ( ! $unlocked ) {
			return array( 'locked' => true, 'last_scan_summary' => null );
		}
		$last = $this->links->last_scan();
		return array(
			'locked'            => false,
			'last_scan_summary' => is_array( $last ) ? $last : null,
		);
	}

	/** Redirect table meta + the top rules by hits, or a locked marker. */
	private function redirects_view( bool $unlocked ): array {
		if ( ! $unlocked ) {
			return array( 'locked' => true, 'count' => 0, 'log_enabled' => false, 'auto_slug' => false, 'top' => array() );
		}
		$rules = $this->redirects->rules();
		return array(
			'locked'      => false,
			'count'       => count( $rules ),
			'log_enabled' => $this->redirects->is_404_logging_enabled(),
			'auto_slug'   => $this->redirects->is_auto_redirect_enabled(),
			'top'         => self::top_rules( $rules ),
		);
	}

	/**
	 * The deduped 404 feed: the redirect ring log (Pro) unioned with statistics
	 * EVENT_404 aggregates (Ultimate), ranked by count, top TOP_NOTFOUND. Locked
	 * only when NEITHER source is entitled.
	 */
	private function notfound_view( bool $redirects_on, bool $stats_on ): array {
		if ( ! $redirects_on && ! $stats_on ) {
			return array( 'locked' => true, 'top' => array() );
		}
		$rows = array();
		if ( $redirects_on ) {
			foreach ( $this->redirects->log_entries() as $entry ) {
				$rows[] = self::notfound_row( $entry, 'redirect_log' );
			}
		}
		if ( $stats_on ) {
			foreach ( $this->statistics_notfound() as $entry ) {
				$rows[] = self::notfound_row( $entry, 'statistics' );
			}
		}
		return array( 'locked' => false, 'top' => self::merge_notfound( $rows ) );
	}

	/** Broken images from the last scan, bounded — the Media explorer's "broken" feed. */
	private function broken_images_view( array $links_view ): array {
		$last = isset( $links_view['last_scan_summary'] ) ? $links_view['last_scan_summary'] : null;
		if ( ! is_array( $last ) || empty( $last['broken_images'] ) || ! is_array( $last['broken_images'] ) ) {
			return array();
		}
		$out = array();
		foreach ( $last['broken_images'] as $img ) {
			if ( ! is_array( $img ) || ! isset( $img['url'] ) ) {
				continue;
			}
			$out[] = array(
				'post_id'       => isset( $img['post_id'] ) ? (int) $img['post_id'] : 0,
				'url'           => (string) $img['url'],
				'attachment_id' => isset( $img['attachment_id'] ) && null !== $img['attachment_id'] ? (int) $img['attachment_id'] : null,
				'status'        => isset( $img['status'] ) ? ( is_int( $img['status'] ) ? $img['status'] : (string) $img['status'] ) : '',
			);
			if ( count( $out ) >= self::TOP_BROKEN_IMAGES ) {
				break;
			}
		}
		return $out;
	}

	// ── projections / merges (pure, static) ─────────────────────────────────────

	/**
	 * Project + rank stored rules to the bounded snapshot shape, highest-hits first.
	 *
	 * @param array<int,array> $rules
	 * @return array<int,array{id:string,source:string,target:string,type:int,match:string,hits:int,external:bool}>
	 */
	private static function top_rules( array $rules ): array {
		usort(
			$rules,
			static function ( array $a, array $b ): int {
				return ( isset( $b['hits'] ) ? (int) $b['hits'] : 0 ) <=> ( isset( $a['hits'] ) ? (int) $a['hits'] : 0 );
			}
		);
		$out = array();
		foreach ( $rules as $rule ) {
			$out[] = array(
				'id'       => isset( $rule['id'] ) ? (string) $rule['id'] : '',
				'source'   => isset( $rule['source'] ) ? (string) $rule['source'] : '',
				'target'   => isset( $rule['target'] ) ? (string) $rule['target'] : '',
				'type'     => isset( $rule['type'] ) ? (int) $rule['type'] : 0,
				'match'    => isset( $rule['match'] ) && is_string( $rule['match'] ) ? $rule['match'] : 'exact',
				'hits'     => isset( $rule['hits'] ) ? (int) $rule['hits'] : 0,
				'external' => ! empty( $rule['external'] ),
			);
			if ( count( $out ) >= self::TOP_REDIRECTS ) {
				break;
			}
		}
		return $out;
	}

	/** Normalize one raw 404 entry to a { path, count, last_seen, source } row, or skip. */
	private static function notfound_row( $entry, string $source ): ?array {
		if ( ! is_array( $entry ) || ! isset( $entry['path'] ) || ! is_string( $entry['path'] ) || '' === $entry['path'] ) {
			return null;
		}
		return array(
			'path'      => $entry['path'],
			'count'     => isset( $entry['count'] ) ? (int) $entry['count'] : 0,
			'last_seen' => isset( $entry['last_seen'] ) ? (int) $entry['last_seen'] : 0,
			'source'    => $source,
		);
	}

	/**
	 * Dedupe rows by path (sum counts, keep the newest last_seen, label the source
	 * 'combined' when a path came from both feeds), then rank by count desc and cap
	 * at TOP_NOTFOUND.
	 *
	 * @param array<int,array|null> $rows
	 * @return array<int,array{path:string,count:int,last_seen:int,source:string}>
	 */
	private static function merge_notfound( array $rows ): array {
		$by_path = array();
		foreach ( $rows as $row ) {
			if ( null === $row ) {
				continue;
			}
			$path = $row['path'];
			if ( ! isset( $by_path[ $path ] ) ) {
				$by_path[ $path ] = $row;
				continue;
			}
			$existing              = $by_path[ $path ];
			$existing['count']     = $existing['count'] + $row['count'];
			$existing['last_seen'] = max( $existing['last_seen'], $row['last_seen'] );
			$existing['source']    = $existing['source'] === $row['source'] ? $existing['source'] : 'combined';
			$by_path[ $path ]      = $existing;
		}
		$merged = array_values( $by_path );
		usort(
			$merged,
			static function ( array $a, array $b ): int {
				return $b['count'] <=> $a['count'];
			}
		);
		return array_slice( $merged, 0, self::TOP_NOTFOUND );
	}

	/** The path strings of a notfound top list (input to the suggestion engine). */
	private static function paths_of( array $top ): array {
		$out = array();
		foreach ( $top as $row ) {
			if ( is_array( $row ) && isset( $row['path'] ) && is_string( $row['path'] ) ) {
				$out[] = $row['path'];
			}
		}
		return $out;
	}

	// ── injected inputs (guarded WP-backed defaults) ────────────────────────────

	/** Live published paths for suggestion targets, from the injected provider. @return string[] */
	private function published_paths(): array {
		$paths = ( $this->published_provider )();
		if ( ! is_array( $paths ) ) {
			return array();
		}
		$out = array();
		foreach ( $paths as $p ) {
			if ( is_string( $p ) && '' !== $p ) {
				$out[] = $p;
			}
		}
		return $out;
	}

	/** Extra 404 rows from statistics, from the injected provider. @return array<int,array> */
	private function statistics_notfound(): array {
		$rows = ( $this->notfound_provider )();
		return is_array( $rows ) ? $rows : array();
	}

	/**
	 * Default published-paths provider: the paths of up to MAX_CANDIDATES published
	 * posts/pages. Empty outside WordPress (the harness injects its own).
	 *
	 * @return callable():string[]
	 */
	private static function default_published_provider(): callable {
		return static function (): array {
			if ( ! function_exists( 'get_posts' ) || ! function_exists( 'get_permalink' ) ) {
				return array();
			}
			$ids = get_posts(
				array(
					'post_type'        => array( 'post', 'page' ),
					'post_status'      => 'publish',
					'fields'           => 'ids',
					'posts_per_page'   => IWSL_Redirect_Suggestions::MAX_CANDIDATES,
					'suppress_filters' => true,
				)
			);
			if ( ! is_array( $ids ) ) {
				return array();
			}
			$out = array();
			foreach ( $ids as $id ) {
				$link = get_permalink( (int) $id );
				if ( ! is_string( $link ) || '' === $link ) {
					continue;
				}
				$path = self::path_of( $link );
				if ( null !== $path && '' !== $path ) {
					$out[] = $path;
				}
			}
			return $out;
		};
	}

	/**
	 * Default statistics-404 provider: EMPTY. The redirect ring log is the primary
	 * feed; wiring the (richer, Ultimate-only) EVENT_404 aggregate from
	 * IWSL_Statistics is a documented additive follow-up — the console/plugin can
	 * inject a provider without touching this aggregator.
	 *
	 * @return callable():array
	 */
	private static function default_notfound_provider(): callable {
		return static function (): array {
			return array();
		};
	}

	/** The normalized path component of an absolute or rooted URL, or null. */
	private static function path_of( string $url ): ?string {
		$path = function_exists( 'wp_parse_url' ) ? wp_parse_url( $url, PHP_URL_PATH ) : parse_url( $url, PHP_URL_PATH );
		if ( ! is_string( $path ) || '' === $path ) {
			return null;
		}
		return IWSL_Redirects::normalize_path( $path );
	}
}
