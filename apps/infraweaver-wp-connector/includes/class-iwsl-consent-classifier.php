<?php
/**
 * Pure decision core behind the gated "Cookie Consent & Privacy Compliance"
 * feature (flag `cookie_consent`, Ultimate tier). Split out from the engine
 * (IWSL_Cookie_Consent) so the hard, security-critical logic — prior-blocking a
 * page's third-party trackers, region→legal-model mapping, DNT/GPC parsing,
 * Google Consent Mode v2 signal shape, and privacy-safe consent records — can be
 * reasoned about and unit-tested with ZERO WordPress and ZERO I/O.
 *
 * Everything here is a static pure function over its arguments: no store, no
 * network, no exec/eval, no superglobals (request state is passed in as an
 * injected $server array, mirroring iwsl-page-cache-helpers.php). The engine owns
 * the gate, persistence, hooks and rendering; this owns only the maths.
 *
 * PRIOR-BLOCKING MODEL. Cookiebot-class "prior blocking" means: BEFORE the visitor
 * consents, known third-party tracker <script>/<iframe> tags are neutralized so
 * they cannot load or set a cookie — regardless of which plugin/theme injected
 * them. block_html() rewrites a matched tag to an inert placeholder
 * (`type="text/plain" data-iwsl-consent="<category>"`, src stashed in
 * `data-iwsl-src`); the engine's inline restore script un-blocks only the
 * categories the visitor later consents to, with no page reload. block_html() is
 * FAIL-SAFE: any regex failure returns the ORIGINAL html untouched — the site is
 * never blanked by a transform error.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Consent_Classifier {

	/** The four consent categories. `necessary` is always-on and non-rejectable. */
	const CATEGORIES = array( 'necessary', 'preferences', 'statistics', 'marketing' );

	/** The seven Google Consent Mode v2 signal keys, in a stable order. */
	const CONSENT_MODE_KEYS = array(
		'ad_storage',
		'ad_user_data',
		'ad_personalization',
		'analytics_storage',
		'functionality_storage',
		'personalization_storage',
		'security_storage',
	);

	/** Legal models a region can map to. */
	const MODEL_OPT_IN  = 'opt-in';   // GDPR / UK-GDPR: block until explicit consent.
	const MODEL_OPT_OUT = 'opt-out';  // CCPA/CPRA: on by default, honor Do-Not-Sell / GPC.
	const MODEL_INFO    = 'info';     // implied consent — informational banner only.
	const MODEL_NONE    = 'none';     // no banner, all categories on.

	/** Byte ceiling on any single text field a record stores. */
	const MAX_RECORD_FIELD = 64;

	/**
	 * EU/EEA + UK ISO-3166 alpha-2 codes → the opt-IN (GDPR/UK-GDPR) model. Bounded,
	 * explicit list; anything not here is judged by the caller's configured default.
	 *
	 * @return array<string, bool> country-code => true (a set, for O(1) lookup).
	 */
	public static function gdpr_countries(): array {
		return array_fill_keys(
			array(
				// EU-27.
				'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
				'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
				'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
				// EEA (non-EU).
				'IS', 'LI', 'NO',
				// United Kingdom (UK-GDPR).
				'GB',
			),
			true
		);
	}

	/**
	 * The extensible tracker signature registry: vendor id => { label, category,
	 * hosts[], snippets[] }. `hosts` are case-insensitive substrings matched against
	 * a script/iframe `src`; `snippets` are substrings matched against inline script
	 * bodies. Bounded and self-contained — adding a vendor is one entry here.
	 *
	 * @return array<string, array{ label:string, category:string, hosts:string[], snippets:string[] }>
	 */
	public static function signatures(): array {
		return array(
			'google_analytics'   => array(
				'label'    => 'Google Analytics / GA4',
				'category' => 'statistics',
				'hosts'    => array( 'google-analytics.com', 'googletagmanager.com/gtag/js', 'analytics.google.com', 'stats.g.doubleclick.net' ),
				'snippets' => array( 'gtag(', 'google-analytics.com', '__gaTracker', 'ga(\'create\'' ),
			),
			'google_tag_manager' => array(
				'label'    => 'Google Tag Manager',
				'category' => 'marketing',
				'hosts'    => array( 'googletagmanager.com/gtm.js' ),
				'snippets' => array( 'googletagmanager.com/gtm.js', 'gtm.start' ),
			),
			'google_ads'         => array(
				'label'    => 'Google Ads / DoubleClick',
				'category' => 'marketing',
				'hosts'    => array( 'googleadservices.com', 'googlesyndication.com', 'doubleclick.net', 'google.com/ads' ),
				'snippets' => array( 'google_conversion', 'gtag_report_conversion', 'googlesyndication' ),
			),
			'facebook_pixel'     => array(
				'label'    => 'Meta (Facebook) Pixel',
				'category' => 'marketing',
				'hosts'    => array( 'connect.facebook.net', 'facebook.com/tr' ),
				'snippets' => array( 'fbq(', 'connect.facebook.net', '_fbq' ),
			),
			'hotjar'             => array(
				'label'    => 'Hotjar',
				'category' => 'statistics',
				'hosts'    => array( 'static.hotjar.com', 'script.hotjar.com', 'hotjar.com' ),
				'snippets' => array( 'hj(', '_hjSettings', 'hotjar' ),
			),
			'microsoft_clarity'  => array(
				'label'    => 'Microsoft Clarity',
				'category' => 'statistics',
				'hosts'    => array( 'clarity.ms' ),
				'snippets' => array( 'clarity(', 'clarity.ms' ),
			),
			'linkedin_insight'   => array(
				'label'    => 'LinkedIn Insight',
				'category' => 'marketing',
				'hosts'    => array( 'snap.licdn.com', 'px.ads.linkedin.com' ),
				'snippets' => array( '_linkedin_partner_id', '_linkedin_data_partner' ),
			),
			'tiktok_pixel'       => array(
				'label'    => 'TikTok Pixel',
				'category' => 'marketing',
				'hosts'    => array( 'analytics.tiktok.com' ),
				'snippets' => array( 'ttq.load', 'ttq.page', 'analytics.tiktok.com' ),
			),
			'twitter_ads'        => array(
				'label'    => 'X (Twitter)',
				'category' => 'marketing',
				'hosts'    => array( 'static.ads-twitter.com', 'platform.twitter.com', 'ads-twitter.com', 'analytics.twitter.com' ),
				'snippets' => array( 'twq(' ),
			),
			'pinterest'          => array(
				'label'    => 'Pinterest Tag',
				'category' => 'marketing',
				'hosts'    => array( 's.pinimg.com', 'ct.pinterest.com' ),
				'snippets' => array( 'pintrk(' ),
			),
			'youtube'            => array(
				'label'    => 'YouTube embed',
				'category' => 'marketing',
				'hosts'    => array( 'youtube.com/embed', 'youtube-nocookie.com/embed', 'youtu.be/', 'youtube.com/watch' ),
				'snippets' => array(),
			),
			'vimeo'              => array(
				'label'    => 'Vimeo embed',
				'category' => 'marketing',
				'hosts'    => array( 'player.vimeo.com' ),
				'snippets' => array(),
			),
			'google_maps'        => array(
				'label'    => 'Google Maps',
				'category' => 'preferences',
				'hosts'    => array( 'maps.googleapis.com', 'google.com/maps/embed', 'maps.google.com' ),
				'snippets' => array(),
			),
			'google_fonts'       => array(
				'label'    => 'Google Fonts',
				'category' => 'preferences',
				'hosts'    => array( 'fonts.googleapis.com', 'fonts.gstatic.com' ),
				'snippets' => array(),
			),
			'intercom'           => array(
				'label'    => 'Intercom',
				'category' => 'preferences',
				'hosts'    => array( 'widget.intercom.io', 'js.intercomcdn.com', 'intercomcdn.com' ),
				'snippets' => array( 'intercomSettings', 'Intercom(' ),
			),
			'hubspot'            => array(
				'label'    => 'HubSpot',
				'category' => 'marketing',
				'hosts'    => array( 'js.hs-scripts.com', 'js.hsforms.net', 'js.hubspot.com', 'hs-analytics.net', 'hs-banner.com' ),
				'snippets' => array( '_hsq', 'hs-scripts' ),
			),
		);
	}

	// ── classification ──────────────────────────────────────────────────────────

	/**
	 * The category a `src` URL belongs to, or null when it matches no known tracker
	 * (a first-party / necessary asset — left untouched). Case-insensitive substring
	 * match against each signature's hosts.
	 */
	public static function classify_src( string $src, ?array $signatures = null ): ?string {
		if ( '' === $src ) {
			return null;
		}
		$sigs = null !== $signatures ? $signatures : self::signatures();
		foreach ( $sigs as $sig ) {
			if ( ! isset( $sig['hosts'], $sig['category'] ) || ! is_array( $sig['hosts'] ) ) {
				continue;
			}
			foreach ( $sig['hosts'] as $needle ) {
				if ( is_string( $needle ) && '' !== $needle && false !== stripos( $src, $needle ) ) {
					return (string) $sig['category'];
				}
			}
		}
		return null;
	}

	/**
	 * The category an inline script BODY belongs to, or null. Matches each
	 * signature's snippet markers (function calls, ids). Case-insensitive.
	 */
	public static function classify_snippet( string $code, ?array $signatures = null ): ?string {
		if ( '' === $code ) {
			return null;
		}
		$sigs = null !== $signatures ? $signatures : self::signatures();
		foreach ( $sigs as $sig ) {
			if ( ! isset( $sig['snippets'], $sig['category'] ) || ! is_array( $sig['snippets'] ) ) {
				continue;
			}
			foreach ( $sig['snippets'] as $needle ) {
				if ( is_string( $needle ) && '' !== $needle && false !== stripos( $code, $needle ) ) {
					return (string) $sig['category'];
				}
			}
		}
		return null;
	}

	// ── prior-blocking transform (the hard part; FAIL-SAFE) ──────────────────────

	/**
	 * Neutralize every known third-party tracker <script>/<iframe> in a full page so
	 * nothing loads or sets a cookie before consent. A matched tag is rewritten to an
	 * inert placeholder: `type="text/plain"`, its `src` moved to `data-iwsl-src`, and
	 * a `data-iwsl-consent="<category>"` marker added so the client can selectively
	 * restore it on consent. First-party / unknown scripts are left byte-for-byte
	 * intact. FAIL-SAFE: on ANY regex failure the ORIGINAL html is returned unchanged
	 * with blocked=0 — a transform error never blanks the site.
	 *
	 * @return array{ html:string, blocked:int, categories:string[] }
	 */
	public static function block_html( string $html, ?array $signatures = null ): array {
		if ( '' === $html ) {
			return array( 'html' => $html, 'blocked' => 0, 'categories' => array() );
		}
		$sigs    = null !== $signatures ? $signatures : self::signatures();
		$blocked = 0;
		$cats    = array();

		$out = preg_replace_callback(
			'#<script\b([^>]*)>(.*?)</script>#is',
			static function ( array $m ) use ( $sigs, &$blocked, &$cats ): string {
				$attrs = (string) $m[1];
				$body  = (string) $m[2];
				$src   = self::get_attr( $attrs, 'src' );

				$category = null;
				if ( null !== $src && '' !== $src ) {
					$category = self::classify_src( $src, $sigs );
				} elseif ( '' !== trim( $body ) ) {
					$category = self::classify_snippet( $body, $sigs );
				}
				if ( null === $category ) {
					return $m[0]; // first-party / unknown — untouched.
				}

				++$blocked;
				$cats[ $category ] = true;
				return '<script' . self::neutralize_attrs( $attrs, $category ) . '>' . $body . '</script>';
			},
			$html
		);
		if ( ! is_string( $out ) ) {
			return array( 'html' => $html, 'blocked' => 0, 'categories' => array() ); // FAIL-SAFE.
		}

		$out2 = preg_replace_callback(
			'#<iframe\b([^>]*)>#is',
			static function ( array $m ) use ( $sigs, &$blocked, &$cats ): string {
				$attrs = (string) $m[1];
				$src   = self::get_attr( $attrs, 'src' );
				if ( null === $src || '' === $src ) {
					return $m[0];
				}
				$category = self::classify_src( $src, $sigs );
				if ( null === $category ) {
					return $m[0];
				}
				++$blocked;
				$cats[ $category ] = true;
				return '<iframe' . self::neutralize_attrs( $attrs, $category ) . '>';
			},
			$out
		);
		if ( ! is_string( $out2 ) ) {
			return array( 'html' => $html, 'blocked' => 0, 'categories' => array() ); // FAIL-SAFE.
		}

		return array(
			'html'       => $out2,
			'blocked'    => $blocked,
			'categories' => array_keys( $cats ),
		);
	}

	/**
	 * Rewrite a tag's attribute blob into the neutralized form: strip any existing
	 * `type`, rename `src`→`data-iwsl-src`, then append `type="text/plain"` and the
	 * consent marker. The category comes from our own registry (safe token), but it
	 * is still filtered to the known set before it reaches the markup.
	 */
	private static function neutralize_attrs( string $attrs, string $category ): string {
		$category = in_array( $category, self::CATEGORIES, true ) ? $category : 'marketing';
		$attrs    = self::strip_attr( $attrs, 'type' );
		$attrs    = self::rename_attr( $attrs, 'src', 'data-iwsl-src' );
		$attrs    = rtrim( $attrs );
		return ( '' === $attrs ? '' : $attrs ) . ' type="text/plain" data-iwsl-consent="' . $category . '" data-iwsl-blocked="1"';
	}

	/** Read one attribute's value from an attribute blob (double/single/unquoted), or null. */
	public static function get_attr( string $attrs, string $name ): ?string {
		$n = preg_quote( $name, '#' );
		if ( preg_match( '#(?<![-\w])' . $n . '\s*=\s*"([^"]*)"#i', $attrs, $m ) ) {
			return $m[1];
		}
		if ( preg_match( "#(?<![-\\w])" . $n . "\\s*=\\s*'([^']*)'#i", $attrs, $m ) ) {
			return $m[1];
		}
		if ( preg_match( '#(?<![-\w])' . $n . '\s*=\s*([^\s>]+)#i', $attrs, $m ) ) {
			return $m[1];
		}
		return null;
	}

	/** Rename an attribute key (first occurrence) without touching its value. */
	private static function rename_attr( string $attrs, string $from, string $to ): string {
		$out = preg_replace(
			'#(?<![-\w])' . preg_quote( $from, '#' ) . '(\s*=\s*)#i',
			$to . '$1',
			$attrs,
			1
		);
		return is_string( $out ) ? $out : $attrs;
	}

	/** Remove an attribute (name=value, any quoting) from an attribute blob. */
	private static function strip_attr( string $attrs, string $name ): string {
		$out = preg_replace(
			'#(?<![-\w])' . preg_quote( $name, '#' ) . '\s*=\s*("[^"]*"|\'[^\']*\'|[^\s>]+)#i',
			'',
			$attrs
		);
		return is_string( $out ) ? $out : $attrs;
	}

	// ── region → legal model + signals ───────────────────────────────────────────

	/**
	 * Cheaply derive the visitor's region (ISO-3166 alpha-2, uppercase). Prefers an
	 * edge-provided `HTTP_CF_IPCOUNTRY`, else the region subtag of the first
	 * `Accept-Language` entry (e.g. `en-GB` → GB), else 'ZZ' (unknown). Pure over an
	 * injected $server map (never $_SERVER), mirroring the page-cache helpers.
	 */
	public static function derive_region( array $server ): string {
		$cf = isset( $server['HTTP_CF_IPCOUNTRY'] ) && is_string( $server['HTTP_CF_IPCOUNTRY'] )
			? strtoupper( trim( $server['HTTP_CF_IPCOUNTRY'] ) ) : '';
		if ( 1 === preg_match( '/^[A-Z]{2}$/', $cf ) && 'XX' !== $cf && 'T1' !== $cf ) {
			return $cf;
		}

		$al = isset( $server['HTTP_ACCEPT_LANGUAGE'] ) && is_string( $server['HTTP_ACCEPT_LANGUAGE'] )
			? $server['HTTP_ACCEPT_LANGUAGE'] : '';
		if ( '' !== $al ) {
			$first = strtok( $al, ',;' );
			if ( is_string( $first ) && preg_match( '/^[A-Za-z]{2,3}-([A-Za-z]{2})\b/', trim( $first ), $m ) ) {
				return strtoupper( $m[1] );
			}
		}
		return 'ZZ';
	}

	/**
	 * Map a region to its legal consent model. EU/EEA/UK → opt-IN (GDPR); US →
	 * opt-OUT (CCPA/CPRA, applied conservatively nationwide since a country code
	 * cannot resolve California); everything else → the caller's configured default.
	 */
	public static function region_model( string $region, string $default_model = self::MODEL_OPT_IN ): string {
		$region = strtoupper( $region );
		if ( isset( self::gdpr_countries()[ $region ] ) ) {
			return self::MODEL_OPT_IN;
		}
		if ( 'US' === $region ) {
			return self::MODEL_OPT_OUT;
		}
		return self::valid_model( $default_model ) ? $default_model : self::MODEL_OPT_IN;
	}

	/** Whether a model string is one we recognize. */
	public static function valid_model( string $model ): bool {
		return in_array( $model, array( self::MODEL_OPT_IN, self::MODEL_OPT_OUT, self::MODEL_INFO, self::MODEL_NONE ), true );
	}

	/** Whether the injected request carries a Do-Not-Track signal (`DNT: 1`). */
	public static function dnt_enabled( array $server ): bool {
		return isset( $server['HTTP_DNT'] ) && '1' === (string) $server['HTTP_DNT'];
	}

	/** Whether the injected request carries a Global Privacy Control signal (`Sec-GPC: 1`). */
	public static function gpc_enabled( array $server ): bool {
		return isset( $server['HTTP_SEC_GPC'] ) && '1' === (string) $server['HTTP_SEC_GPC'];
	}

	/**
	 * The DEFAULT per-category grant map for a model + signals, before any explicit
	 * visitor choice. opt-in → only `necessary` on. opt-out/info/none → everything on.
	 * GPC ("do not sell/share") forces marketing OFF; DNT forces marketing AND
	 * statistics OFF. `necessary` is always true (non-rejectable).
	 *
	 * @return array{ necessary:bool, preferences:bool, statistics:bool, marketing:bool }
	 */
	public static function default_consent( string $model, bool $dnt, bool $gpc ): array {
		$on = ( self::MODEL_OPT_IN !== $model ); // opt-out / info / none start opted-in.
		$grants = array(
			'necessary'   => true,
			'preferences' => $on,
			'statistics'  => $on,
			'marketing'   => $on,
		);
		if ( $gpc ) {
			$grants['marketing'] = false;
		}
		if ( $dnt ) {
			$grants['marketing']  = false;
			$grants['statistics'] = false;
		}
		return $grants;
	}

	// ── Google Consent Mode v2 ───────────────────────────────────────────────────

	/**
	 * The `gtag('consent','default',…)` map: denied-by-default for all ad/analytics/
	 * personalization storage, granted for the two always-necessary buckets
	 * (functionality + security). Emitted early, before any tag can fire.
	 *
	 * @return array<string,string> each CONSENT_MODE_KEYS key => 'granted'|'denied'.
	 */
	public static function consent_default_signal(): array {
		return array(
			'ad_storage'              => 'denied',
			'ad_user_data'            => 'denied',
			'ad_personalization'      => 'denied',
			'analytics_storage'       => 'denied',
			'functionality_storage'   => 'granted',
			'personalization_storage' => 'denied',
			'security_storage'        => 'granted',
		);
	}

	/**
	 * The `gtag('consent','update',…)` map for a set of consented categories:
	 * marketing→ad_storage/ad_user_data/ad_personalization, statistics→
	 * analytics_storage, preferences→personalization_storage. functionality_storage
	 * and security_storage are always granted (necessary).
	 *
	 * @param string[] $categories consented category names.
	 * @return array<string,string>
	 */
	public static function consent_update_signal( array $categories ): array {
		$has = array_fill_keys( array_values( array_intersect( self::CATEGORIES, $categories ) ), true );
		$mk  = isset( $has['marketing'] );
		return array(
			'ad_storage'              => $mk ? 'granted' : 'denied',
			'ad_user_data'            => $mk ? 'granted' : 'denied',
			'ad_personalization'      => $mk ? 'granted' : 'denied',
			'analytics_storage'       => isset( $has['statistics'] ) ? 'granted' : 'denied',
			'functionality_storage'   => 'granted',
			'personalization_storage' => isset( $has['preferences'] ) ? 'granted' : 'denied',
			'security_storage'        => 'granted',
		);
	}

	// ── privacy-safe consent records ─────────────────────────────────────────────

	/**
	 * A privacy-safe pseudonymous visitor id: sha-256 of (ip | ua | salt), truncated.
	 * The raw IP is NEVER stored — only this non-reversible digest, so the log proves
	 * a consent happened without holding personal data.
	 */
	public static function anonymize( string $ip, string $ua, string $salt ): string {
		return substr( hash( 'sha256', $ip . '|' . $ua . '|' . $salt ), 0, 32 );
	}

	/**
	 * Build one immutable, privacy-safe consent record. Contains ONLY: timestamp,
	 * the pseudonymous id, the granted categories (filtered to the known set),
	 * region, policy version, and the method — never a raw IP, never a name.
	 *
	 * @param string[] $categories granted category names.
	 * @return array{ at:int, id:string, cats:string[], region:string, ver:int, method:string }
	 */
	public static function build_record( int $at, string $anon_id, array $categories, string $region, int $policy_version, string $method ): array {
		return array(
			'at'     => $at,
			'id'     => self::clean_field( $anon_id ),
			'cats'   => array_values( array_intersect( self::CATEGORIES, $categories ) ),
			'region' => self::clean_region( $region ),
			'ver'    => max( 1, $policy_version ),
			'method' => self::clean_method( $method ),
		);
	}

	/** The recognized consent methods; anything else is normalized to `custom`. */
	private static function clean_method( string $method ): string {
		$allowed = array( 'accept_all', 'reject_all', 'custom', 'implied', 'gpc', 'dnt' );
		return in_array( $method, $allowed, true ) ? $method : 'custom';
	}

	/** A short region token: alpha only, capped, uppercased; else 'ZZ'. */
	private static function clean_region( string $region ): string {
		$region = strtoupper( preg_replace( '/[^A-Za-z]/', '', $region ) ?? '' );
		if ( '' === $region ) {
			return 'ZZ';
		}
		return substr( $region, 0, 8 );
	}

	/** Control-strip + cap a stored token. */
	private static function clean_field( string $value ): string {
		$stripped = preg_replace( '/[^A-Za-z0-9_.:-]/', '', $value );
		$stripped = null === $stripped ? '' : $stripped;
		return substr( $stripped, 0, self::MAX_RECORD_FIELD );
	}
}
