<?php
/**
 * Per-feature operational on/off, tier-aware.
 *
 * This is a LOCAL kill-switch, NOT a tier grant. Tier membership arrives only
 * through the signed console channel (`entitlements.set`, dual-signed); this
 * class can never widen it. `set()` refuses to turn a feature ON unless the
 * live entitlement already grants it, so the signed-channel invariant holds:
 * the operator may only turn OFF (or back ON) something the tier already
 * includes. A switch the tier doesn't grant is inert — the engine still
 * self-gates on its own entitlement as statement 1 of every callback.
 *
 * Storage is one option (`iwsl_feature_switches`) mapping FEATURE-flag => bool.
 * A missing key means ON: an install that upgrades into a new feature gets it
 * running by default rather than silently disabled. Purging `iwsl_*` on unlink
 * resets every switch to its default (on), which is correct.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Feature_Switches {

	/** Option key holding the FEATURE-flag => bool map. */
	const OPTION = 'iwsl_feature_switches';

	private IWSL_Entitlements $ent;
	private IWSL_Store $store;

	public function __construct( IWSL_Entitlements $ent, IWSL_Store $store ) {
		$this->ent   = $ent;
		$this->store = $store;
	}

	/**
	 * The full set of switchable FEATURE flags. A flag absent here is NOT
	 * user-togglable (e.g. the wp-config editor, which carries no tier gate).
	 *
	 * @return array<string, true>
	 */
	public static function switchable(): array {
		return array(
			'speed_pack'           => true,
			'response_scan'        => true,
			'page_cache'           => true,
			'cdn_rewrite'          => true,
			'lazy_load'            => true,
			'media_protection'     => true,
			'media_folders'        => true,
			'elementor_blocks'     => true,
			'image_optimization'   => true,
			'auto_convert'         => true,
			'svg_upload'           => true,
			'seo_suite'            => true,
			'seo_audit'            => true,
			'duplicate_post'       => true,
			'broken_link_scan'     => true,
			'redirect_manager'     => true,
			'statistics'           => true,
			'activity_log'         => true,
			'cookie_consent'       => true,
			'maintenance_mode'     => true,
			'white_label'          => true,
			'db_optimization'      => true,
			'scheduled_db_cleanup' => true,
			'email_delivery'       => true,
			'security_headers'     => true,
		);
	}

	/** Whether a FEATURE flag is a recognized switch. */
	public static function is_switchable( string $feature ): bool {
		return isset( self::switchable()[ $feature ] );
	}

	/**
	 * Is this feature switched ON? Default true (a missing entry = on). This is
	 * ONLY the operator switch — callers still AND it with the entitlement gate.
	 */
	public function is_on( string $feature ): bool {
		$map = $this->map();
		return ! array_key_exists( $feature, $map ) || (bool) $map[ $feature ];
	}

	/**
	 * Flip a switch. Turning OFF is always allowed. Turning ON is refused unless
	 * the tier currently grants the feature — the switch can never out-run the
	 * signed entitlement.
	 *
	 * @return array{ok: bool, reason?: string, feature?: string, on?: bool}
	 */
	public function set( string $feature, bool $on ): array {
		if ( ! self::is_switchable( $feature ) ) {
			return array( 'ok' => false, 'reason' => 'unknown-feature' );
		}
		if ( $on ) {
			$gate = $this->ent->evaluate( $feature );
			if ( empty( $gate['unlocked'] ) ) {
				return array( 'ok' => false, 'reason' => 'not-entitled', 'feature' => $feature );
			}
		}
		$map             = $this->map();
		$map[ $feature ] = $on;
		$this->store->set( self::OPTION, $map );
		return array( 'ok' => true, 'feature' => $feature, 'on' => $on );
	}

	/** The stored switch map (FEATURE-flag => bool), or an empty map. @return array<string, bool> */
	private function map(): array {
		$raw = $this->store->get( self::OPTION, array() );
		if ( ! is_array( $raw ) ) {
			return array();
		}
		$clean = array();
		foreach ( $raw as $key => $value ) {
			if ( is_string( $key ) && self::is_switchable( $key ) ) {
				$clean[ $key ] = (bool) $value;
			}
		}
		return $clean;
	}
}
