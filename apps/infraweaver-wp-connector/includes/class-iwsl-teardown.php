<?php
/**
 * Per-feature teardown / footprint purge dispatcher.
 *
 * The connector's tier-gated engines each own a small local footprint (an
 * `iwsl_*` option, sometimes per-post meta, a custom table, a cron event, or a
 * disk drop-in). Disabling a feature — either by the operator flipping its
 * switch, or by the tier revoking it — should leave nothing behind. This class
 * is the framework that makes that true:
 *
 *   - Each engine exposes `public function purge(): array` that removes ONLY its
 *     own artifacts and is cheap + idempotent when there is nothing to remove.
 *   - {@see purge()} maps a FEATURE flag to its engine and dispatches that
 *     purge, wrapped so one engine's failure can never break a wider sweep.
 *   - {@see clean_at_init()} runs (admin-side only) once per request and purges
 *     every tier-gated feature that is currently OFF or un-entitled, so the
 *     plugin self-heals to a clean state at init.
 *   - {@see flush_page_cache()} is the shared hook content engines call on save,
 *     so a front-end-affecting settings change never serves a stale cached page.
 *
 * Everything is static and every WP/$wpdb touch is function_exists/isset-guarded
 * so the whole class runs harmlessly under the zero-WordPress test harness.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Teardown {

	/**
	 * Synthetic flag for the FREE Load-Time Audit. It carries no tier
	 * entitlement and no operator switch, so it is NOT in the switchable
	 * registry — but it DOES expose purge(), so it is purgeable on uninstall /
	 * full sweep. {@see clean_at_init()} deliberately skips it (a free feature is
	 * never "un-entitled").
	 */
	const FLAG_PERF_AUDIT = 'perf_audit';

	/**
	 * Flush the front-end page cache. The shared hook content engines call after
	 * a settings save so a front-end-affecting change (e.g. a cookie-consent
	 * banner) can't be served from a stale cached page.
	 *
	 * Constructs IWSL_Page_Cache exactly as the bootstrap does
	 * (`new IWSL_Page_Cache( iwsl_plugin()->entitlements() )`) and calls
	 * purge_all(). A cheap no-op when there is no cache/drop-in, and — by design —
	 * NEVER fatal: guarded on class_exists + function_exists('iwsl_plugin') so it
	 * short-circuits under the WP-less harness, and wrapped in try/catch so a disk
	 * hiccup can't take down the save it was called from.
	 */
	public static function flush_page_cache(): void {
		if ( ! class_exists( 'IWSL_Page_Cache' ) || ! function_exists( 'iwsl_plugin' ) ) {
			return;
		}
		try {
			$cache = new IWSL_Page_Cache( iwsl_plugin()->entitlements() );
			if ( method_exists( $cache, 'purge_all' ) ) {
				$cache->purge_all();
			}
		} catch ( \Throwable $e ) {
			// Never let a cache flush fatal the request that triggered it.
			unset( $e );
		}
	}

	/**
	 * The full set of FEATURE flags this dispatcher can purge: every tier-gated
	 * switchable engine plus the FREE perf-audit (which exposes purge() but is not
	 * switchable). Mirrors IWSL_Feature_Switches::switchable() / the engines'
	 * FEATURE constants — every flag here resolves in {@see engine_for()}.
	 *
	 * @return string[]
	 */
	public static function flags(): array {
		return array_merge(
			array_keys( IWSL_Feature_Switches::switchable() ),
			array( self::FLAG_PERF_AUDIT )
		);
	}

	/**
	 * Construct the engine instance that owns a FEATURE flag's footprint, using
	 * each engine's REAL constructor signature (most take ($ent, $store); the page
	 * cache / media optimizer / db optimizer take ($ent) only; the FREE perf audit
	 * takes ($store) only). Returns null for an unrecognized flag.
	 *
	 * @return object|null
	 */
	public static function engine_for( string $flag, IWSL_Entitlements $ent, IWSL_WP_Store $store ) {
		switch ( $flag ) {
			// ── ($ent) only — no store parameter ──
			case IWSL_Page_Cache::FEATURE:
				return new IWSL_Page_Cache( $ent );
			case IWSL_Media_Optimizer::FEATURE:
				return new IWSL_Media_Optimizer( $ent );
			case IWSL_DB_Optimizer::FEATURE:
				return new IWSL_DB_Optimizer( $ent );

			// ── ($store) only — the FREE Load-Time Audit ──
			case self::FLAG_PERF_AUDIT:
				return new IWSL_Perf_Audit( $store );

			// ── ($ent, $store) ──
			case IWSL_Speed_Pack::FEATURE:
				return new IWSL_Speed_Pack( $ent, $store );
			case IWSL_Response_Scan::FEATURE:
				return new IWSL_Response_Scan( $ent, $store );
			case IWSL_CDN_Rewrite::FEATURE:
				return new IWSL_CDN_Rewrite( $ent, $store );
			case IWSL_Lazy_Load::FEATURE:
				return new IWSL_Lazy_Load( $ent, $store );
			case IWSL_Media_Protection::FEATURE:
				return new IWSL_Media_Protection( $ent, $store );
			case IWSL_Auto_Convert::FEATURE:
				return new IWSL_Auto_Convert( $ent, $store );
			case IWSL_SVG_Upload::FEATURE:
				return new IWSL_SVG_Upload( $ent, $store );
			case IWSL_SEO_Suite::FEATURE:
				return new IWSL_SEO_Suite( $ent, $store );
			case IWSL_SEO_Audit::FEATURE:
				return new IWSL_SEO_Audit( $ent, $store );
			case IWSL_Duplicate_Post::FEATURE:
				return new IWSL_Duplicate_Post( $ent, $store );
			case IWSL_Broken_Link_Scan::FEATURE:
				return new IWSL_Broken_Link_Scan( $ent, $store );
			case IWSL_Redirects::FEATURE:
				return new IWSL_Redirects( $ent, $store );
			case IWSL_Statistics::FEATURE:
				return new IWSL_Statistics( $ent, $store );
			case IWSL_Activity_Log::FEATURE:
				return new IWSL_Activity_Log( $ent, $store );
			case IWSL_Cookie_Consent::FEATURE:
				return new IWSL_Cookie_Consent( $ent, $store );
			case IWSL_Maintenance_Mode::FEATURE:
				return new IWSL_Maintenance_Mode( $ent, $store );
			case IWSL_White_Label::FEATURE:
				return new IWSL_White_Label( $ent, $store );
			case IWSL_Scheduled_DB_Cleanup::FEATURE:
				return new IWSL_Scheduled_DB_Cleanup( $ent, $store );
			case IWSL_Email_Delivery::FEATURE:
				return new IWSL_Email_Delivery( $ent, $store );

			default:
				return null;
		}
	}

	/**
	 * Purge one feature's footprint. Resolves the engine and calls its purge() if
	 * it exposes one; returns an empty array for an unknown flag or an engine that
	 * has no purge(). Wrapped in try/catch so a single engine's failure (or a
	 * missing WP function under the harness) can never break a sweep.
	 *
	 * @return array<string, mixed>
	 */
	public static function purge( string $flag, IWSL_Entitlements $ent, IWSL_WP_Store $store ): array {
		try {
			$engine = self::engine_for( $flag, $ent, $store );
			if ( null === $engine || ! method_exists( $engine, 'purge' ) ) {
				return array();
			}
			$result = $engine->purge();
			return is_array( $result ) ? $result : array();
		} catch ( \Throwable $e ) {
			return array( 'ok' => false, 'error' => $e->getMessage() );
		}
	}

	/**
	 * Purge every feature's footprint and return a per-flag summary. A convenience
	 * for a full, engine-driven teardown (e.g. an explicit "reset everything"),
	 * kept isolation-safe by the per-flag try/catch in {@see purge()}.
	 *
	 * @return array<string, array<string, mixed>>
	 */
	public static function purge_all( IWSL_Entitlements $ent, IWSL_WP_Store $store ): array {
		$summary = array();
		foreach ( self::flags() as $flag ) {
			$summary[ $flag ] = self::purge( $flag, $ent, $store );
		}
		return $summary;
	}

	/**
	 * Self-heal to a clean state at init: for every tier-gated feature that is NOT
	 * (switched ON and currently entitled), purge its footprint. Each engine purge
	 * is cheap-when-clean, so the common all-active case is bounded and does
	 * essentially no work. Meant to run ADMIN-side only (the bootstrap gates the
	 * call with is_admin()), so the front-end hot path pays nothing.
	 *
	 * Free features (no switch, no entitlement — e.g. the perf audit) are skipped:
	 * "off or un-entitled" is meaningless for them, so init never purges them.
	 */
	public static function clean_at_init( IWSL_Feature_Switches $switches, IWSL_Entitlements $ent, IWSL_WP_Store $store ): void {
		foreach ( self::flags() as $flag ) {
			if ( ! IWSL_Feature_Switches::is_switchable( $flag ) ) {
				continue;
			}
			$active = $switches->is_on( $flag );
			if ( $active ) {
				$gate   = $ent->evaluate( $flag );
				$active = ! empty( $gate['unlocked'] );
			}
			if ( ! $active ) {
				self::purge( $flag, $ent, $store );
			}
		}
	}
}
