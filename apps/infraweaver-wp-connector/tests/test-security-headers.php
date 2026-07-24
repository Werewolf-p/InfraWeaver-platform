<?php
/**
 * IWSL_Security_Headers grader/emitter + the five Security/Consent/Protection
 * signed methods, plus the domain's four HARD INVARIANTS (test-asserted):
 *
 *   INV-1  Raw consent-log rows NEVER cross the wire — aggregates() is counts only.
 *   INV-2  Cookie-consent DEFAULT-OFF is pinned on the signed setConfig wire path.
 *   INV-3  The SVG sanitizer allow-lists / ceilings are FROZEN (regression guard).
 *   INV-4  security.harden rejects ANY key/value outside the closed enum set.
 *
 * The pure grader + closed-set config core are unit-tested directly; the signed
 * methods are driven through IWSL_Plugin's real command registry (reflection), the
 * same way test-command-handler drives run().
 */

// ── fixed-clock helpers: an active, heartbeat-fresh site with granted flags ─────
$iwsl_sh_now = 1000000000000; // fixed unix-ms
$iwsl_sh_clock = static function () use ( $iwsl_sh_now ): int {
	return $iwsl_sh_now;
};

/** A memory store seeded active + fresh-heartbeat with the given flags granted. */
$iwsl_sh_store = static function ( array $flags ) use ( $iwsl_sh_now ): IWSL_Memory_Store {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $iwsl_sh_now );
	$map = array();
	foreach ( $flags as $flag ) {
		$map[ $flag ] = true;
	}
	$store->set( 'entitlements', $map );
	return $store;
};

/** A plugin whose entitlement gate unlocks the given flags. */
$iwsl_sh_plugin = static function ( array $flags ) use ( $iwsl_sh_store, $iwsl_sh_clock ): array {
	$store  = $iwsl_sh_store( $flags );
	$plugin = new IWSL_Plugin( $store, $iwsl_sh_clock );
	return array( $store, $plugin );
};

/** The real command registry (§7 single source of truth). */
$iwsl_sh_ref = new ReflectionMethod( 'IWSL_Plugin', 'command_handlers' );
$iwsl_sh_ref->setAccessible( true );
$registry = $iwsl_sh_ref->invoke( null );

// ── A. pure grader: grade_headers ───────────────────────────────────────────────

$empty = IWSL_Security_Headers::grade_headers( array() );
iwsl_assert_same( 'F', $empty['grade'], 'A: empty header set grades F' );
iwsl_assert_same( 0, $empty['score'], 'A: empty header set scores 0' );
$missing_all = true;
foreach ( $empty['headers'] as $row ) {
	if ( 'missing' !== $row['state'] ) {
		$missing_all = false;
	}
	iwsl_assert( isset( $row['name'], $row['state'], $row['value_hint'], $row['why'] ), 'A: each row carries name/state/value_hint/why' );
}
iwsl_assert( $missing_all, 'A: every header is "missing" on a bare response' );

$strong = IWSL_Security_Headers::grade_headers(
	array(
		'strict-transport-security' => 'max-age=31536000; includeSubDomains',
		'content-security-policy'   => "default-src 'self'",
		'x-content-type-options'    => 'nosniff',
		'x-frame-options'           => 'DENY',
		'referrer-policy'           => 'no-referrer',
		'permissions-policy'        => 'geolocation=()',
	)
);
iwsl_assert_same( 100, $strong['score'], 'A: a fully-hardened response scores 100' );
iwsl_assert_same( 'A', $strong['grade'], 'A: a fully-hardened response grades A' );

$weak_hsts = IWSL_Security_Headers::grade_headers( array( 'strict-transport-security' => 'max-age=100' ) );
$hsts_state = '';
foreach ( $weak_hsts['headers'] as $row ) {
	if ( 'Strict-Transport-Security' === $row['name'] ) {
		$hsts_state = $row['state'];
	}
}
iwsl_assert_same( 'weak', $hsts_state, 'A: HSTS with a short max-age is "weak"' );

$ro_csp = IWSL_Security_Headers::grade_headers( array( 'content-security-policy-report-only' => "default-src 'self'" ) );
$csp_state = '';
foreach ( $ro_csp['headers'] as $row ) {
	if ( 'Content-Security-Policy' === $row['name'] ) {
		$csp_state = $row['state'];
	}
}
iwsl_assert_same( 'weak', $csp_state, 'A: report-only-only CSP grades "weak" (logged, not enforced)' );

$fa_csp = IWSL_Security_Headers::grade_headers( array( 'content-security-policy' => "default-src 'self'; frame-ancestors 'self'" ) );
$frame_good = false;
foreach ( $fa_csp['headers'] as $row ) {
	if ( 'X-Frame-Options' === $row['name'] && 'good' === $row['state'] ) {
		$frame_good = true;
	}
}
iwsl_assert( $frame_good, 'A: CSP frame-ancestors satisfies frame protection' );

// A REPORT-ONLY-only frame-ancestors is logged, not enforced → grades "weak", NOT
// "good" (clickjacking is not actually blocked). Regression for the grader fix.
$ro_fa = IWSL_Security_Headers::grade_headers( array( 'content-security-policy-report-only' => "default-src 'self'; frame-ancestors 'self'" ) );
$ro_frame_state = '';
foreach ( $ro_fa['headers'] as $row ) {
	if ( 'X-Frame-Options' === $row['name'] ) {
		$ro_frame_state = $row['state'];
	}
}
iwsl_assert_same( 'weak', $ro_frame_state, 'A: report-only-only frame-ancestors grades "weak", never "good" (not enforced)' );

$leaky = IWSL_Security_Headers::grade_headers( array( 'x-powered-by' => 'PHP/8.2.1', 'server' => 'nginx/1.25.3' ) );
$leak_names = array_map( static function ( $l ) { return $l['name']; }, $leaky['leaks'] );
iwsl_assert( in_array( 'X-Powered-By', $leak_names, true ), 'A: X-Powered-By is reported as an information leak' );
iwsl_assert( in_array( 'Server', $leak_names, true ), 'A: versioned Server header is reported as a leak' );

iwsl_assert_same( 31536000, IWSL_Security_Headers::hsts_max_age( 'max-age=31536000; includeSubDomains' ), 'A: hsts_max_age parses the max-age' );
iwsl_assert_same( 0, IWSL_Security_Headers::hsts_max_age( 'includeSubDomains' ), 'A: hsts_max_age is 0 when absent' );
iwsl_assert_same( 'A', IWSL_Security_Headers::letter( 95 ), 'A: letter(95)=A' );
iwsl_assert_same( 'F', IWSL_Security_Headers::letter( 10 ), 'A: letter(10)=F' );

// header normalization tolerates array-valued + mixed-case names.
$norm = IWSL_Security_Headers::normalize_headers( array( 'X-Frame-Options' => 'DENY', 'Set-Cookie' => array( 'a=1', 'b=2' ) ) );
iwsl_assert_same( 'DENY', $norm['x-frame-options'] ?? '', 'A: normalize lowercases header names' );
iwsl_assert_same( 'a=1, b=2', $norm['set-cookie'] ?? '', 'A: normalize joins array-valued headers' );

// ── B. computed_headers: CSP report-only never yields an enforcing CSP (S5 AC) ──

$ro = IWSL_Security_Headers::computed_headers( array( 'csp' => 'report-only' ) );
$ro_names = array_map( static function ( $p ) { return $p[0]; }, $ro );
iwsl_assert( in_array( 'Content-Security-Policy-Report-Only', $ro_names, true ), 'B: report-only emits the -Report-Only header' );
iwsl_assert( ! in_array( 'Content-Security-Policy', $ro_names, true ), 'B: report-only NEVER emits an enforcing Content-Security-Policy' );

$enf = IWSL_Security_Headers::computed_headers( array( 'csp' => 'enforce' ) );
$enf_names = array_map( static function ( $p ) { return $p[0]; }, $enf );
iwsl_assert( in_array( 'Content-Security-Policy', $enf_names, true ), 'B: enforce emits the enforcing CSP (explicit second step)' );
iwsl_assert( ! in_array( 'Content-Security-Policy-Report-Only', $enf_names, true ), 'B: enforce does not also emit report-only' );

$frame_deny = IWSL_Security_Headers::computed_headers( array( 'frame' => 'deny' ) );
iwsl_assert_same( array( array( 'X-Frame-Options', 'DENY' ) ), $frame_deny, 'B: frame=deny emits X-Frame-Options: DENY' );
iwsl_assert_same( array(), IWSL_Security_Headers::computed_headers( array() ), 'B: an empty config emits nothing' );

// ── C. filter_new_headers: never duplicates an upstream/peer header (S5 AC) ─────

$computed = IWSL_Security_Headers::computed_headers( array( 'hsts' => true, 'nosniff' => true ) );
$present  = array( 'strict-transport-security' => true ); // already set upstream.
$new      = IWSL_Security_Headers::filter_new_headers( $computed, $present );
$new_names = array_map( static function ( $p ) { return strtolower( $p[0] ); }, $new );
iwsl_assert( ! in_array( 'strict-transport-security', $new_names, true ), 'C: an already-present header is NOT re-emitted' );
iwsl_assert( in_array( 'x-content-type-options', $new_names, true ), 'C: a still-absent header IS emitted' );

// ── D. INV-4: security.harden closed-key/enum validator ─────────────────────────

$valid = array(
	array( 'config' => (object) array( 'frame' => 'deny' ) ),
	array( 'config' => (object) array( 'hsts' => true, 'nosniff' => true, 'referrer' => 'no-referrer', 'csp' => 'report-only' ) ),
	array( 'revert' => true ),
	array( 'config' => (object) array( 'csp' => 'enforce' ) ),
);
foreach ( $valid as $i => $case ) {
	iwsl_assert( IWSL_Security_Headers::validate_params( (object) $case ), "D: valid harden params accepted (#{$i})" );
}

$invalid = array(
	'empty object'            => (object) array(),
	'stray top key'           => (object) array( 'foo' => 1 ),
	'unknown config key'      => (object) array( 'config' => (object) array( 'X-Evil' => 'x' ) ),
	'free-form frame value'   => (object) array( 'config' => (object) array( 'frame' => "deny\r\nSet-Cookie: x=1" ) ),
	'bad enum frame'          => (object) array( 'config' => (object) array( 'frame' => 'javascript:alert(1)' ) ),
	'wrong type hsts'         => (object) array( 'config' => (object) array( 'hsts' => 'yes' ) ),
	'excluded referrer'       => (object) array( 'config' => (object) array( 'referrer' => 'unsafe-url' ) ),
	'bad enum csp'            => (object) array( 'config' => (object) array( 'csp' => 'evil' ) ),
	'config not object'       => (object) array( 'config' => 'nope' ),
	'revert wrong type'       => (object) array( 'revert' => 1 ),
);
foreach ( $invalid as $label => $params ) {
	iwsl_assert( ! IWSL_Security_Headers::validate_params( $params ), "D: harden rejects — {$label}" );
}
iwsl_assert( ! IWSL_Security_Headers::validate_params( array( 'config' => array() ) ), 'D: harden rejects a non-object params' );

// sanitize_config forces every value onto its closed enum with safe defaults.
$sanitized = IWSL_Security_Headers::sanitize_config( array( 'frame' => 'bogus', 'referrer' => 'unsafe-url', 'csp' => 'bogus', 'hsts' => true ) );
iwsl_assert_same( '', $sanitized['frame'], 'D: sanitize drops an out-of-enum frame' );
iwsl_assert_same( '', $sanitized['referrer'], 'D: sanitize drops an out-of-enum referrer' );
iwsl_assert_same( 'off', $sanitized['csp'], 'D: sanitize defaults an out-of-enum csp to off' );
iwsl_assert_same( true, $sanitized['hsts'], 'D: sanitize keeps a valid bool' );

// ── E. scan() with an injected fetcher (loopback grade + vendor detection) ──────

$strong_fetch = static function ( string $url, int $timeout ): array {
	return array(
		'code'    => 200,
		'headers' => array(
			'strict-transport-security' => 'max-age=31536000; includeSubDomains',
			'content-security-policy'   => "default-src 'self'; frame-ancestors 'self'",
			'x-content-type-options'    => 'nosniff',
			'referrer-policy'           => 'no-referrer',
			'permissions-policy'        => 'geolocation=()',
		),
		'body'    => "<html><head><script>gtag('js', new Date());</script></head><body>hi</body></html>",
		'error'   => '',
	);
};

$ent_granted = new IWSL_Entitlements( $iwsl_sh_store( array( 'security_headers' ) ), $iwsl_sh_clock );
$engine      = new IWSL_Security_Headers( $ent_granted, $iwsl_sh_store( array( 'security_headers' ) ), 'https://fixture-site.test/', $strong_fetch, static function () { return 4242; } );
$scan        = $engine->scan();
iwsl_assert_same( true, $scan['ok'], 'E: scan() succeeds behind the loopback anchor' );
iwsl_assert( in_array( $scan['grade'], array( 'A', 'B' ), true ), 'E: scan() grades a well-hardened site A/B' );
iwsl_assert_same( 4242, $scan['scanned_at'], 'E: scan() stamps scanned_at from the injected clock' );
$vendor_ids = array_map( static function ( $v ) { return $v['vendor']; }, $scan['detected_vendors'] );
iwsl_assert( in_array( 'google_analytics', $vendor_ids, true ), 'E: scan() detects the GA tracker in the fetched body' );

$ent_locked   = new IWSL_Entitlements( new IWSL_Memory_Store(), $iwsl_sh_clock );
$engine_lock  = new IWSL_Security_Headers( $ent_locked, new IWSL_Memory_Store(), 'https://fixture-site.test/', $strong_fetch );
$scan_locked  = $engine_lock->scan();
iwsl_assert_same( false, $scan_locked['ok'], 'E: scan() is refused when the entitlement is locked' );
iwsl_assert_same( 'entitlement-locked', $scan_locked['reason'], 'E: locked scan() surfaces the reason' );
iwsl_assert( isset( $scan_locked['gate'] ), 'E: locked scan() returns the gate detail' );

$err_fetch = static function ( string $url, int $timeout ): array {
	return array( 'code' => 0, 'headers' => array(), 'body' => '', 'error' => 'timeout' );
};
$engine_err = new IWSL_Security_Headers( $ent_granted, $iwsl_sh_store( array( 'security_headers' ) ), 'https://fixture-site.test/', $err_fetch );
$scan_err   = $engine_err->scan();
iwsl_assert_same( false, $scan_err['ok'], 'E: a fetch error yields a well-formed ok=false result' );
iwsl_assert_same( 'fetch-failed', $scan_err['reason'], 'E: a fetch error reports fetch-failed' );

// ── F. apply_config / config round-trip + revert (STATEMENT-1 gate) ─────────────

$engine_w = new IWSL_Security_Headers( $ent_granted, $iwsl_sh_store( array( 'security_headers' ) ), 'https://fixture-site.test/', $strong_fetch );
// A shared store so apply_config()'s write is visible to config().
$shared_store = $iwsl_sh_store( array( 'security_headers' ) );
$engine_rt    = new IWSL_Security_Headers( new IWSL_Entitlements( $shared_store, $iwsl_sh_clock ), $shared_store, 'https://fixture-site.test/', $strong_fetch );
$applied      = $engine_rt->apply_config( (object) array( 'config' => (object) array( 'hsts' => true, 'csp' => 'report-only' ) ) );
iwsl_assert_same( true, $applied['ok'], 'F: apply_config succeeds when entitled' );
iwsl_assert_same( true, $applied['applied']['hsts'], 'F: hsts stored' );
iwsl_assert_same( 'report-only', $applied['applied']['csp'], 'F: csp stored report-only' );
iwsl_assert_same( 'report-only', $engine_rt->config()['csp'], 'F: config() reads back the stored value' );
$reverted = $engine_rt->apply_config( (object) array( 'revert' => true ) );
iwsl_assert_same( 'off', $reverted['applied']['csp'], 'F: revert clears csp back to off' );
iwsl_assert_same( false, $reverted['applied']['hsts'], 'F: revert clears hsts' );

$engine_lockw = new IWSL_Security_Headers( $ent_locked, new IWSL_Memory_Store(), 'https://fixture-site.test/', $strong_fetch );
$lockw        = $engine_lockw->apply_config( (object) array( 'config' => (object) array( 'hsts' => true ) ) );
iwsl_assert_same( false, $lockw['ok'], 'F: apply_config refused when locked' );
iwsl_assert_same( 'entitlement-locked', $lockw['reason'], 'F: locked apply_config surfaces the reason' );

// ── G. INV-1: consent aggregates() are COUNTS ONLY — no raw record ever leaks ───

$cc_store = $iwsl_sh_store( array( 'cookie_consent' ) );
$cc       = new IWSL_Cookie_Consent( new IWSL_Entitlements( $cc_store, $iwsl_sh_clock ), $cc_store, $iwsl_sh_clock, array() );
$cc->record_consent( array( 'necessary', 'statistics' ), 'EU', 'accept_all', '203.0.113.7', 'UA-a' );
$cc->record_consent( array( 'necessary' ), 'US', 'reject_all', '203.0.113.8', 'UA-b' );
$cc->record_consent( array( 'necessary', 'marketing' ), 'EU', 'accept_all', '203.0.113.9', 'UA-c' );
$agg = $cc->aggregates();
iwsl_assert_same( 3, $agg['records'], 'G: aggregates counts every record' );
iwsl_assert_same( array( 'records', 'by_method', 'by_region', 'policy_version' ), array_keys( $agg ), 'G/INV-1: aggregates exposes ONLY count keys' );
iwsl_assert_same( 2, $agg['by_method']['accept_all'] ?? 0, 'G: per-method tally counts accepts' );
iwsl_assert_same( 2, $agg['by_region']['EU'] ?? 0, 'G: per-region tally counts EU' );

// The raw log has pseudonymous ids; assert NONE of them appear in the wire payload.
$raw_ids = array_map( static function ( $r ) { return (string) ( $r['id'] ?? '' ); }, $cc->log_entries() );
$agg_json = json_encode( $agg );
$leaked   = false;
foreach ( $raw_ids as $rid ) {
	if ( '' !== $rid && false !== strpos( (string) $agg_json, $rid ) ) {
		$leaked = true;
	}
}
iwsl_assert( ! $leaked, 'G/INV-1: no pseudonymous record id appears in the aggregates payload' );
iwsl_assert( false === strpos( (string) $agg_json, '"id"' ) && false === strpos( (string) $agg_json, '"cats"' ), 'G/INV-1: aggregates payload carries no record fields' );

// ── H. INV-2: cookie-consent DEFAULT-OFF on the signed setConfig wire path ──────

list( $cs_store, $cs_plugin ) = $iwsl_sh_plugin( array( 'cookie_consent' ) );

// getConfig on a fresh (never-saved) site reports enabled:false.
list( $get_ok, $get_res ) = $registry['consent.getConfig']->run( $cs_plugin, new stdClass() );
iwsl_assert_same( true, $get_ok, 'H: consent.getConfig runs when entitled' );
iwsl_assert_same( false, $get_res['enabled'], 'H/INV-2: a fresh site reports consent enabled:false' );
iwsl_assert( isset( $get_res['aggregates'] ) && ! isset( $get_res['aggregates']['id'] ), 'H: getConfig carries aggregates, not rows' );

// setConfig with NO `enabled` key ⇒ stored OFF (absent means off through the gauntlet).
$set_env                    = new stdClass();
$set_env->params            = new stdClass();
$set_env->params->settings  = (object) array( 'title' => 'We use cookies' );
list( $set_ok, $set_res ) = $registry['consent.setConfig']->run( $cs_plugin, $set_env );
iwsl_assert_same( true, $set_ok, 'H: consent.setConfig runs when entitled' );
iwsl_assert_same( false, $set_res['settings']['enabled'], 'H/INV-2: setConfig without enabled stores enabled:false' );

// Enabling is only ever an explicit action.
$on_env                   = new stdClass();
$on_env->params           = new stdClass();
$on_env->params->settings = (object) array( 'enabled' => true );
list( $on_ok, $on_res ) = $registry['consent.setConfig']->run( $cs_plugin, $on_env );
iwsl_assert_same( true, $on_res['settings']['enabled'], 'H: setConfig with enabled:true stores enabled:true (explicit opt-in)' );

// setConfig validator rejects a stray top-level key.
$set_validator = $registry['consent.setConfig']->validator;
iwsl_assert( $set_validator( (object) array( 'settings' => (object) array() ) ), 'H: setConfig validator accepts {settings:{}}' );
iwsl_assert( ! $set_validator( (object) array( 'settings' => (object) array(), 'x' => 1 ) ), 'H: setConfig validator rejects a stray key' );
iwsl_assert( ! $set_validator( (object) array( 'settings' => 'nope' ) ), 'H: setConfig validator rejects non-object settings' );

// Locked tier ⇒ the runner refuses even if the console sends the call.
list( , $cs_locked_plugin ) = $iwsl_sh_plugin( array() );
list( $lock_ok, $lock_res ) = $registry['consent.setConfig']->run( $cs_locked_plugin, $set_env );
iwsl_assert_same( false, $lock_ok, 'H: setConfig refused for a non-Ultimate (unentitled) site' );
iwsl_assert( ! empty( $lock_res['locked'] ), 'H: refusal envelope marks locked' );

// ── I. INV-3: SVG sanitizer allow-lists + ceilings are FROZEN ───────────────────

$frozen_elements = array(
	'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline',
	'polygon', 'text', 'tspan', 'textPath', 'tref', 'title', 'desc',
	'metadata', 'defs', 'use', 'symbol', 'marker', 'clipPath', 'mask',
	'pattern', 'linearGradient', 'radialGradient', 'stop', 'switch',
);
$frozen_attrs = array(
	'id', 'class', 'transform', 'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
	'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'dx', 'dy',
	'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
	'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
	'stroke-opacity', 'stroke-miterlimit', 'opacity', 'color', 'display',
	'visibility', 'overflow', 'clip-path', 'clip-rule', 'mask', 'paint-order',
	'stop-color', 'stop-opacity', 'offset', 'vector-effect', 'shape-rendering',
	'color-interpolation', 'text-anchor', 'dominant-baseline', 'alignment-baseline',
	'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing',
	'viewBox', 'preserveAspectRatio', 'version', 'enable-background',
	'gradientUnits', 'gradientTransform', 'spreadMethod', 'patternUnits',
	'patternContentUnits', 'patternTransform', 'clipPathUnits', 'maskUnits',
	'maskContentUnits', 'markerWidth', 'markerHeight', 'markerUnits', 'refX',
	'refY', 'orient', 'xml:space', 'xml:lang',
);
iwsl_assert_same( $frozen_elements, IWSL_SVG_Upload::ALLOWED_ELEMENTS, 'I/INV-3: ALLOWED_ELEMENTS is byte-identical to the frozen allow-list' );
iwsl_assert_same( $frozen_attrs, IWSL_SVG_Upload::ALLOWED_ATTRS, 'I/INV-3: ALLOWED_ATTRS is byte-identical to the frozen allow-list' );
iwsl_assert_same( 2097152, IWSL_SVG_Upload::MAX_SVG_BYTES, 'I/INV-3: MAX_SVG_BYTES ceiling unchanged (2 MB)' );
iwsl_assert_same( 10000, IWSL_SVG_Upload::MAX_NODES, 'I/INV-3: MAX_NODES ceiling unchanged (10k)' );
foreach ( array( 'script', 'style', 'image', 'a', 'foreignObject', 'animate' ) as $banned ) {
	iwsl_assert( ! in_array( $banned, IWSL_SVG_Upload::ALLOWED_ELEMENTS, true ), "I/INV-3: <{$banned}> stays off the element allow-list" );
}
iwsl_assert( ! in_array( 'style', IWSL_SVG_Upload::ALLOWED_ATTRS, true ), 'I/INV-3: the style attribute stays off the allow-list' );

// ── J. registry wiring: the five methods are on the signed allow-list ───────────

$allowed = IWSL_Plugin::allowed_methods();
foreach ( array( 'security.scan', 'security.harden', 'consent.getConfig', 'consent.setConfig', 'protection.status' ) as $m ) {
	iwsl_assert( array_key_exists( $m, $allowed ), "J: {$m} is on the signed allow-list (no public endpoint)" );
	iwsl_assert( array_key_exists( $m, $registry ), "J: {$m} is registered in the command handler map" );
}
iwsl_assert_same( array( 'IWSL_Security_Headers', 'validate_params' ), $registry['security.harden']->validator, 'J: security.harden wires the closed-set validator' );
iwsl_assert_same( null, $allowed['security.scan'], 'J: security.scan takes no params (empty-params validator)' );
iwsl_assert_same( null, $allowed['protection.status'], 'J: protection.status takes no params' );

// ── K. runners through the real registry (locked + granted) ─────────────────────

list( , $sec_locked ) = $iwsl_sh_plugin( array() );
list( $sl_ok, $sl_res ) = $registry['security.scan']->run( $sec_locked, new stdClass() );
iwsl_assert_same( false, $sl_ok, 'K: security.scan refused when locked' );
iwsl_assert( ! empty( $sl_res['locked'] ) && isset( $sl_res['gate'] ), 'K: locked scan returns { locked, gate }' );

list( , $sec_granted ) = $iwsl_sh_plugin( array( 'security_headers' ) );
list( $sg_ok, $sg_res ) = $registry['security.scan']->run( $sec_granted, new stdClass() );
iwsl_assert_same( true, $sg_ok, 'K: security.scan dispatches when entitled' );
iwsl_assert( isset( $sg_res['ok'] ), 'K: scan result is well-formed even with no HTTP API in the harness' );

// Build a proper envelope for harden (params carries the config).
$harden_env         = new stdClass();
$harden_env->params = (object) array( 'config' => (object) array( 'nosniff' => true, 'frame' => 'sameorigin' ) );
list( $hd_ok, $hd_res ) = $registry['security.harden']->run( $sec_granted, $harden_env );
iwsl_assert_same( true, $hd_ok, 'K: security.harden applies a closed-set config when entitled' );
iwsl_assert_same( true, $hd_res['applied']['nosniff'], 'K: harden stored nosniff' );
iwsl_assert_same( 'sameorigin', $hd_res['applied']['frame'], 'K: harden stored the frame enum' );

list( $ps_ok, $ps_res ) = $registry['protection.status']->run( $sec_granted, new stdClass() );
iwsl_assert_same( true, $ps_ok, 'K: protection.status runs' );
foreach ( array( 'media_protection', 'svg_upload', 'cookie_consent', 'security_headers' ) as $section ) {
	iwsl_assert( isset( $ps_res[ $section ]['entitled'] ), "K: protection.status reports the {$section} section" );
}
iwsl_assert( array_key_exists( 'protected_count', $ps_res['media_protection'] ), 'K: media_protection status carries protected_count' );
iwsl_assert_same( true, $ps_res['security_headers']['entitled'], 'K: security_headers reported entitled on a granted site' );
iwsl_assert( is_array( $ps_res['security_headers']['config'] ), 'K: security_headers status carries the current config' );
