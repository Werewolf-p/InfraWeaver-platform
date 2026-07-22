<?php
/**
 * Cookie Consent & Privacy Compliance (gate flag `cookie_consent`): the pure
 * classifier (region→model, DNT/GPC, prior-blocking transform, Consent Mode signal
 * shape, privacy-safe records) + the gated engine (filter_output / save_settings /
 * record_consent / clear_log).
 *
 * Runs under the zero-dependency harness: no WordPress output/url helpers are
 * defined, so the engine's local escaping and the classifier's pure PHP are
 * authoritative. IWSL_Cookie_Consent takes a shared in-memory IWSL_Store (so a
 * single entitlement flip re-locks instantly), a fixed injected clock, an injected
 * $server request map, and an is_front probe. The front-end effect is asserted by
 * feeding a full page through filter_output() and inspecting the returned HTML.
 */

// ── fixtures ──────────────────────────────────────────────────────────────────

function iwsl_cc_clock( int $now ): callable {
	return static function () use ( $now ): int {
		return $now;
	};
}

/** Seed a shared store as unlocked (active + fresh heartbeat + cookie_consent flag). */
function iwsl_cc_unlocked_store( IWSL_Store $store, int $now ): void {
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 ); // 1 min ago — fresh.
	$store->set( 'entitlements', array( 'plus' => true, 'cookie_consent' => true ) );
}

/** Unlocked-entitlements helper over a shared store (mirrors the other suites). */
function iwsl_cc_unlocked_entitlements( IWSL_Store $store, int $now ): IWSL_Entitlements {
	iwsl_cc_unlocked_store( $store, $now );
	return new IWSL_Entitlements( $store, iwsl_cc_clock( $now ) );
}

/** A gate seeded with an explicit state + flag map (for the blocked cases). */
function iwsl_cc_entitlements( IWSL_Store $store, int $now, string $state, array $flags, int $last_offset = 60000 ): IWSL_Entitlements {
	$store->set( 'state', $state );
	$store->set( 'last_verified_at', $now - $last_offset );
	$store->set( 'entitlements', $flags );
	return new IWSL_Entitlements( $store, iwsl_cc_clock( $now ) );
}

/** Build an engine over $store with an injected $server map and always-front probe. */
function iwsl_cc_engine( IWSL_Store $store, IWSL_Entitlements $ent, int $now, array $server = array() ): IWSL_Cookie_Consent {
	return new IWSL_Cookie_Consent(
		$ent,
		$store,
		iwsl_cc_clock( $now ),
		$server,
		static function (): bool {
			return true;
		}
	);
}

/** A representative page: a GA loader, an inline gtag call, a first-party script, a YouTube embed. */
function iwsl_cc_sample_page(): string {
	return '<!doctype html><html><head><title>x</title></head><body>'
		. '<script src="https://www.googletagmanager.com/gtag/js?id=G-XX"></script>'
		. '<script>gtag("js", new Date());</script>'
		. '<script src="/wp-content/themes/acme/app.js"></script>'
		. '<iframe src="https://www.youtube.com/embed/abc"></iframe>'
		. '</body></html>';
}

$CC_NOW = 40000000;

// ── 1. Region → legal model + DNT/GPC ─────────────────────────────────────────

iwsl_assert_same( 'opt-in', IWSL_Consent_Classifier::region_model( 'DE' ), 'region: DE (EU) → opt-in' );
iwsl_assert_same( 'opt-in', IWSL_Consent_Classifier::region_model( 'GB' ), 'region: GB (UK) → opt-in' );
iwsl_assert_same( 'opt-in', IWSL_Consent_Classifier::region_model( 'NO' ), 'region: NO (EEA) → opt-in' );
iwsl_assert_same( 'opt-out', IWSL_Consent_Classifier::region_model( 'US' ), 'region: US (CCPA) → opt-out' );
iwsl_assert_same( 'info', IWSL_Consent_Classifier::region_model( 'BR', 'info' ), 'region: other region uses the configured default' );
iwsl_assert_same( 'opt-in', IWSL_Consent_Classifier::region_model( 'ZZ' ), 'region: unknown falls back to opt-in' );

iwsl_assert_same( 'DE', IWSL_Consent_Classifier::derive_region( array( 'HTTP_CF_IPCOUNTRY' => 'de' ) ), 'derive: CF-IPCountry wins (uppercased)' );
iwsl_assert_same( 'GB', IWSL_Consent_Classifier::derive_region( array( 'HTTP_ACCEPT_LANGUAGE' => 'en-GB,en;q=0.9' ) ), 'derive: Accept-Language region subtag' );
iwsl_assert_same( 'ZZ', IWSL_Consent_Classifier::derive_region( array() ), 'derive: unknown when no signal' );
iwsl_assert_same( 'ZZ', IWSL_Consent_Classifier::derive_region( array( 'HTTP_CF_IPCOUNTRY' => 'XX' ) ), 'derive: CF sentinel XX is not a region' );

iwsl_assert_same( true, IWSL_Consent_Classifier::dnt_enabled( array( 'HTTP_DNT' => '1' ) ), 'signal: DNT:1 detected' );
iwsl_assert_same( false, IWSL_Consent_Classifier::dnt_enabled( array( 'HTTP_DNT' => '0' ) ), 'signal: DNT:0 not enabled' );
iwsl_assert_same( true, IWSL_Consent_Classifier::gpc_enabled( array( 'HTTP_SEC_GPC' => '1' ) ), 'signal: Sec-GPC:1 detected' );
iwsl_assert_same( false, IWSL_Consent_Classifier::gpc_enabled( array() ), 'signal: GPC absent' );

$optin  = IWSL_Consent_Classifier::default_consent( 'opt-in', false, false );
iwsl_assert_same( array( 'necessary' => true, 'preferences' => false, 'statistics' => false, 'marketing' => false ), $optin, 'default: opt-in blocks all but necessary' );
$optout = IWSL_Consent_Classifier::default_consent( 'opt-out', false, false );
iwsl_assert_same( array( 'necessary' => true, 'preferences' => true, 'statistics' => true, 'marketing' => true ), $optout, 'default: opt-out grants all' );
$gpc = IWSL_Consent_Classifier::default_consent( 'opt-out', false, true );
iwsl_assert_same( false, $gpc['marketing'], 'default: GPC forces marketing off (do-not-sell)' );
iwsl_assert_same( true, $gpc['statistics'], 'default: GPC leaves statistics on' );
$dnt = IWSL_Consent_Classifier::default_consent( 'opt-out', true, false );
iwsl_assert_same( false, $dnt['marketing'], 'default: DNT forces marketing off' );
iwsl_assert_same( false, $dnt['statistics'], 'default: DNT forces statistics off' );

// ── 2. Google Consent Mode v2 signal shape ────────────────────────────────────

$def = IWSL_Consent_Classifier::consent_default_signal();
iwsl_assert_same( 7, count( $def ), 'consent-mode: default has all seven keys' );
iwsl_assert_same( 'denied', $def['ad_storage'], 'consent-mode: ad_storage denied by default' );
iwsl_assert_same( 'denied', $def['analytics_storage'], 'consent-mode: analytics_storage denied by default' );
iwsl_assert_same( 'granted', $def['security_storage'], 'consent-mode: security_storage always granted' );
iwsl_assert_same( 'granted', $def['functionality_storage'], 'consent-mode: functionality_storage always granted' );

$up_stat = IWSL_Consent_Classifier::consent_update_signal( array( 'necessary', 'statistics' ) );
iwsl_assert_same( 'granted', $up_stat['analytics_storage'], 'consent-mode: statistics consent → analytics_storage granted' );
iwsl_assert_same( 'denied', $up_stat['ad_storage'], 'consent-mode: no marketing → ad_storage stays denied' );

$up_mk = IWSL_Consent_Classifier::consent_update_signal( array( 'necessary', 'marketing' ) );
iwsl_assert_same( 'granted', $up_mk['ad_storage'], 'consent-mode: marketing → ad_storage granted' );
iwsl_assert_same( 'granted', $up_mk['ad_user_data'], 'consent-mode: marketing → ad_user_data granted' );
iwsl_assert_same( 'granted', $up_mk['ad_personalization'], 'consent-mode: marketing → ad_personalization granted' );
iwsl_assert_same( 'denied', $up_mk['analytics_storage'], 'consent-mode: no statistics → analytics_storage denied' );

// ── 3. Prior-blocking transform (the hard part) ───────────────────────────────

$r = IWSL_Consent_Classifier::block_html( iwsl_cc_sample_page() );
iwsl_assert( $r['blocked'] >= 3, 'block: neutralized at least the GA loader, inline gtag and YouTube embed' );
iwsl_assert( false !== strpos( $r['html'], 'data-iwsl-src="https://www.googletagmanager.com/gtag/js?id=G-XX"' ), 'block: GA src stashed in data-iwsl-src' );
iwsl_assert( false !== strpos( $r['html'], 'type="text/plain"' ), 'block: neutralized tag carries type="text/plain"' );
iwsl_assert( false !== strpos( $r['html'], 'data-iwsl-consent="statistics"' ), 'block: GA classified as statistics' );
iwsl_assert( false !== strpos( $r['html'], 'data-iwsl-consent="marketing"' ), 'block: YouTube embed classified as marketing' );
iwsl_assert( false !== strpos( $r['html'], 'src="/wp-content/themes/acme/app.js"' ), 'block: first-party script left INTACT (still executes)' );
iwsl_assert( false === strpos( $r['html'], '<script src="https://www.googletagmanager.com/gtag/js' ), 'block: the live GA src attribute is gone' );

// classification of individual srcs / snippets.
iwsl_assert_same( 'marketing', IWSL_Consent_Classifier::classify_src( 'https://connect.facebook.net/en_US/fbevents.js' ), 'classify: Facebook pixel → marketing' );
iwsl_assert_same( 'statistics', IWSL_Consent_Classifier::classify_src( 'https://static.hotjar.com/c/hotjar-123.js' ), 'classify: Hotjar → statistics' );
iwsl_assert_same( 'preferences', IWSL_Consent_Classifier::classify_src( 'https://fonts.googleapis.com/css?family=Inter' ), 'classify: Google Fonts → preferences' );
iwsl_assert_same( null, IWSL_Consent_Classifier::classify_src( '/wp-includes/js/jquery.js' ), 'classify: first-party asset → null (untouched)' );
iwsl_assert_same( 'marketing', IWSL_Consent_Classifier::classify_snippet( 'fbq("track","PageView");' ), 'classify: fbq snippet → marketing' );

// fail-safe / robustness.
iwsl_assert_same( '', IWSL_Consent_Classifier::block_html( '' )['html'], 'block: empty input → empty output' );
$plain = '<p>hello world, no trackers here</p>';
$pr    = IWSL_Consent_Classifier::block_html( $plain );
iwsl_assert_same( $plain, $pr['html'], 'block: tracker-free HTML returned byte-identical' );
iwsl_assert_same( 0, $pr['blocked'], 'block: nothing neutralized when no tracker matches' );
iwsl_assert( is_string( IWSL_Consent_Classifier::block_html( '<script src="https://google-analytics.com/a.js"' )['html'] ), 'block: malformed (unclosed) tag → still returns a string (fail-safe)' );

// ── 4. Gate BLOCKS: filter_output must not block/inject for a lower tier ───────

// (a) flag absent — settings pre-seeded enabled directly.
$store = new IWSL_Memory_Store();
$store->set( 'cookie_consent', array( 'enabled' => true, 'consent_mode' => true, 'categories' => array( 'statistics' => true, 'marketing' => true ) ) );
$ent_a = iwsl_cc_entitlements( $store, $CC_NOW, 'active', array( 'plus' => true ) ); // cookie_consent ABSENT
$cc_a  = iwsl_cc_engine( $store, $ent_a, $CC_NOW, array( 'HTTP_CF_IPCOUNTRY' => 'DE' ) );
$out_a = $cc_a->filter_output( iwsl_cc_sample_page() );
iwsl_assert_same( iwsl_cc_sample_page(), $out_a, 'gate (flag absent): page returned untouched (no blocking)' );
iwsl_assert( false === strpos( $out_a, 'data-iwsl-consent' ), 'gate (flag absent): no tracker neutralized' );
iwsl_assert( false === strpos( $out_a, 'iwsl-consent-config' ), 'gate (flag absent): no banner injected' );
iwsl_assert( false === strpos( $out_a, "gtag('consent','default'" ), 'gate (flag absent): no Consent Mode emitted' );

// (b) not active.
$store_b = new IWSL_Memory_Store();
$store_b->set( 'cookie_consent', array( 'enabled' => true ) );
$ent_b = iwsl_cc_entitlements( $store_b, $CC_NOW, 'pending', array( 'plus' => true, 'cookie_consent' => true ) );
$cc_b  = iwsl_cc_engine( $store_b, $ent_b, $CC_NOW );
iwsl_assert_same( iwsl_cc_sample_page(), $cc_b->filter_output( iwsl_cc_sample_page() ), 'gate (not active): page untouched despite flag' );

// (c) stale heartbeat.
$store_c = new IWSL_Memory_Store();
$store_c->set( 'cookie_consent', array( 'enabled' => true ) );
$ent_c = iwsl_cc_entitlements( $store_c, $CC_NOW, 'active', array( 'plus' => true, 'cookie_consent' => true ), 10800000 ); // 3h stale
$cc_c  = iwsl_cc_engine( $store_c, $ent_c, $CC_NOW );
iwsl_assert_same( iwsl_cc_sample_page(), $cc_c->filter_output( iwsl_cc_sample_page() ), 'gate (stale heartbeat): page untouched despite flag' );

// ── 5. Unlocked: filter_output blocks + injects banner + Consent Mode ─────────

$store = new IWSL_Memory_Store();
$ent   = iwsl_cc_unlocked_entitlements( $store, $CC_NOW );
$cc    = iwsl_cc_engine( $store, $ent, $CC_NOW, array( 'HTTP_CF_IPCOUNTRY' => 'DE' ) );
$save  = $cc->save_settings( array( 'enabled' => '1', 'consent_mode' => '1', 'categories' => array( 'statistics' => '1', 'marketing' => '1' ) ) );
iwsl_assert_same( true, $save['ok'], 'unlocked: settings saved' );
$out = $cc->filter_output( iwsl_cc_sample_page() );
iwsl_assert( false !== strpos( $out, 'data-iwsl-consent="statistics"' ), 'unlocked: GA neutralized in the served page' );
iwsl_assert( false !== strpos( $out, 'id="iwsl-consent-config"' ), 'unlocked: JSON config injected' );
iwsl_assert( false !== strpos( $out, 'iwsl-cc-banner' ), 'unlocked: banner markup injected' );
iwsl_assert( false !== strpos( $out, "gtag('consent','default'" ), 'unlocked: Consent Mode default emitted in head' );
iwsl_assert( false !== strpos( $out, 'src="/wp-content/themes/acme/app.js"' ), 'unlocked: first-party script still intact' );

// unlocked but DISABLED → no transform.
$store_d = new IWSL_Memory_Store();
$ent_d   = iwsl_cc_unlocked_entitlements( $store_d, $CC_NOW );
$cc_d    = iwsl_cc_engine( $store_d, $ent_d, $CC_NOW );
$cc_d->save_settings( array( 'enabled' => false ) );
iwsl_assert_same( iwsl_cc_sample_page(), $cc_d->filter_output( iwsl_cc_sample_page() ), 'unlocked + disabled: page untouched' );

// ── 6. Consent records: bounded + privacy-safe (no raw IP) ────────────────────

$store = new IWSL_Memory_Store();
$ent   = iwsl_cc_unlocked_entitlements( $store, $CC_NOW );
$cc    = iwsl_cc_engine( $store, $ent, $CC_NOW );
$res   = $cc->record_consent( array( 'necessary', 'statistics' ), 'DE', 'custom', '203.0.113.9', 'Mozilla/5.0 (X)' );
iwsl_assert_same( true, $res['ok'], 'record: ok' );
$rec = $res['record'];
iwsl_assert_same( array( 'necessary', 'statistics' ), $rec['cats'], 'record: only the granted categories stored, in canonical order' );
iwsl_assert_same( 'DE', $rec['region'], 'record: region stored' );
iwsl_assert_same( 'custom', $rec['method'], 'record: method stored' );
iwsl_assert( '203.0.113.9' !== $rec['id'], 'record: id is NOT the raw IP' );
iwsl_assert( false === strpos( json_encode( $rec ), '203.0.113.9' ), 'record: raw IP appears NOWHERE in the record (privacy-safe)' );
iwsl_assert( 32 === strlen( $rec['id'] ), 'record: id is a fixed-length pseudonymous digest' );

// method normalization.
$res2 = $cc->record_consent( array( 'necessary' ), 'US', 'totally-made-up', '198.51.100.7' );
iwsl_assert_same( 'custom', $res2['record']['method'], 'record: an unknown method is normalized to custom' );

// bounded ring.
$store_r = new IWSL_Memory_Store();
$ent_r   = iwsl_cc_unlocked_entitlements( $store_r, $CC_NOW );
$cc_r    = iwsl_cc_engine( $store_r, $ent_r, $CC_NOW );
for ( $i = 0; $i < IWSL_Cookie_Consent::MAX_LOG_ENTRIES + 40; $i++ ) {
	$cc_r->record_consent( array( 'necessary' ), 'DE', 'accept_all', '10.0.0.' . ( $i % 200 ) );
}
iwsl_assert_same( IWSL_Cookie_Consent::MAX_LOG_ENTRIES, count( $cc_r->log_entries() ), 'record: log FIFO-bounded to MAX_LOG_ENTRIES' );

// locked record: refused, nothing stored.
$store_l = new IWSL_Memory_Store();
$ent_l   = iwsl_cc_entitlements( $store_l, $CC_NOW, 'active', array( 'plus' => true ) );
$cc_l    = iwsl_cc_engine( $store_l, $ent_l, $CC_NOW );
$rl      = $cc_l->record_consent( array( 'necessary', 'marketing' ), 'DE', 'accept_all', '203.0.113.9' );
iwsl_assert_same( false, $rl['ok'], 'record (locked): refused' );
iwsl_assert_same( 'entitlement-locked', $rl['reason'], 'record (locked): reason entitlement-locked' );
iwsl_assert_same( array(), $cc_l->log_entries(), 'record (locked): nothing persisted' );

// ── 7. Settings validate + persist ────────────────────────────────────────────

$store = new IWSL_Memory_Store();
$ent   = iwsl_cc_unlocked_entitlements( $store, $CC_NOW );
$cc    = iwsl_cc_engine( $store, $ent, $CC_NOW );
$r     = $cc->save_settings(
	array(
		'enabled'          => '1',
		'default_model'    => 'opt-out',
		'banner_layout'    => 'box',
		'consent_mode'     => '1',
		'respect_gpc'      => '1',
		'policy_version'   => '3',
		'title'            => "Hi\x00there",
		'message'          => "line1\nline2",
		'policy_url'       => '/privacy-policy',
		'accent'           => '#ABCDEF',
		'categories'       => array( 'statistics' => '1' ),
		'vendor_overrides' => array( 'youtube' => 'preferences', 'bogus_vendor' => 'marketing', 'google_fonts' => 'notacat' ),
	)
);
iwsl_assert_same( true, $r['ok'], 'settings: saved ok' );
$s = $cc->settings();
iwsl_assert_same( true, $s['enabled'], 'settings: enabled true' );
iwsl_assert_same( 'opt-out', $s['default_model'], 'settings: model persisted' );
iwsl_assert_same( 'box', $s['banner_layout'], 'settings: layout persisted' );
iwsl_assert_same( true, $s['consent_mode'], 'settings: consent_mode persisted' );
iwsl_assert_same( true, $s['respect_gpc'], 'settings: respect_gpc persisted' );
iwsl_assert_same( false, $s['respect_dnt'], 'settings: respect_dnt defaults off' );
iwsl_assert_same( 3, $s['policy_version'], 'settings: policy_version persisted' );
iwsl_assert_same( 'Hithere', $s['title'], 'settings: control byte stripped from title' );
iwsl_assert_same( "line1\nline2", $s['message'], 'settings: newlines preserved in message' );
iwsl_assert_same( '/privacy-policy', $s['policy_url'], 'settings: rooted policy path kept' );
iwsl_assert_same( '#abcdef', $s['accent'], 'settings: valid accent lowercased + kept' );
iwsl_assert_same( false, $s['categories']['preferences'], 'settings: unchecked category off' );
iwsl_assert_same( true, $s['categories']['statistics'], 'settings: checked category on' );
iwsl_assert_same( false, $s['categories']['marketing'], 'settings: unchecked category off' );
iwsl_assert_same( 'preferences', $s['vendor_overrides']['youtube'], 'settings: valid vendor override kept' );
iwsl_assert( ! isset( $s['vendor_overrides']['bogus_vendor'] ), 'settings: unknown vendor override dropped' );
iwsl_assert( ! isset( $s['vendor_overrides']['google_fonts'] ), 'settings: invalid category override dropped' );

// invalid inputs fall back safely.
$r2 = $cc->save_settings( array( 'enabled' => '1', 'default_model' => 'nonsense', 'accent' => 'red', 'policy_url' => '//evil.example.com' ) );
iwsl_assert_same( 'opt-in', $r2['settings']['default_model'], 'settings: invalid model → opt-in' );
iwsl_assert_same( '#2a6df0', $r2['settings']['accent'], 'settings: invalid accent → default' );
iwsl_assert_same( '', $r2['settings']['policy_url'], 'settings: scheme-relative policy URL rejected' );

// locked save persists nothing.
$store_ls = new IWSL_Memory_Store();
$ent_ls   = iwsl_cc_entitlements( $store_ls, $CC_NOW, 'active', array( 'plus' => true ) );
$cc_ls    = iwsl_cc_engine( $store_ls, $ent_ls, $CC_NOW );
$rls      = $cc_ls->save_settings( array( 'enabled' => '1', 'title' => 'Nope' ) );
iwsl_assert_same( false, $rls['ok'], 'settings (locked): refused' );
iwsl_assert_same( 'entitlement-locked', $rls['reason'], 'settings (locked): reason entitlement-locked' );
iwsl_assert_same( null, $store_ls->get( 'cookie_consent' ), 'settings (locked): store untouched' );

// ── 8. Effective signatures honor per-vendor overrides ────────────────────────

$store = new IWSL_Memory_Store();
$ent   = iwsl_cc_unlocked_entitlements( $store, $CC_NOW );
$cc    = iwsl_cc_engine( $store, $ent, $CC_NOW );
$eff   = $cc->effective_signatures( array( 'vendor_overrides' => array( 'youtube' => 'preferences' ) ) );
iwsl_assert_same( 'preferences', $eff['youtube']['category'], 'signatures: override retags YouTube to preferences' );
iwsl_assert_same( 'statistics', $eff['google_analytics']['category'], 'signatures: un-overridden vendor keeps its default category' );

// ── 9. Fresh-install default state (the documented banner-not-showing cause) ──

// A fresh site has no stored settings → enabled defaults FALSE → start_buffer/
// filter_output bail before any transform. Enabling (one click) is REQUIRED.
$store_sn = new IWSL_Memory_Store();
$fresh    = iwsl_cc_engine( $store_sn, iwsl_cc_unlocked_entitlements( $store_sn, $CC_NOW ), $CC_NOW )->sanitize_settings( array() );
iwsl_assert_same( false, $fresh['enabled'], 'fresh install: enabled defaults OFF (root cause of "no banner")' );

$store_f = new IWSL_Memory_Store();
$ent_f   = iwsl_cc_unlocked_entitlements( $store_f, $CC_NOW );
$cc_f    = iwsl_cc_engine( $store_f, $ent_f, $CC_NOW, array( 'HTTP_CF_IPCOUNTRY' => 'DE' ) );
iwsl_assert_same( false, $cc_f->is_configured(), 'fresh install: is_configured false before any save' );
iwsl_assert_same( iwsl_cc_sample_page(), $cc_f->filter_output( iwsl_cc_sample_page() ), 'fresh install: unlocked but never configured → page untouched (no banner)' );

// ── 10. One-click automation: recommended defaults + apply ────────────────────

$rd = IWSL_Consent_Classifier::recommended_defaults();
iwsl_assert_same( true, $rd['enabled'], 'defaults: recommended preset enables the feature' );
iwsl_assert_same( 'opt-in', $rd['default_model'], 'defaults: GDPR-safe opt-in model' );
iwsl_assert_same( true, $rd['consent_mode'], 'defaults: Google Consent Mode v2 on' );
iwsl_assert_same( true, $rd['respect_gpc'], 'defaults: GPC (do-not-sell) honored' );
iwsl_assert_same( false, $rd['respect_dnt'], 'defaults: legacy DNT off' );
iwsl_assert_same( array( 'preferences' => true, 'statistics' => true, 'marketing' => true ), $rd['categories'], 'defaults: every category offered to the visitor' );

// The preset survives the save-time gauntlet unchanged in meaning.
$rd_clean = $cc_f->sanitize_settings( $rd );
iwsl_assert_same( true, $rd_clean['enabled'], 'defaults: preset passes the sanitizer enabled' );
iwsl_assert_same( 'opt-in', $rd_clean['default_model'], 'defaults: preset model survives the sanitizer' );
iwsl_assert_same( '#2a6df0', $rd_clean['accent'], 'defaults: empty accent falls back to the engine default color' );

// Engine layer: no get_privacy_policy_url in the harness → policy_url stays ''.
iwsl_assert_same( '', $cc_f->recommended_defaults()['policy_url'], 'defaults: no fabricated policy URL when WP cannot provide one' );

// ONE CLICK on the fresh engine → configured, enabled, banner + blocking live.
$applied = $cc_f->apply_recommended_defaults();
iwsl_assert_same( true, $applied['ok'], 'one-click: apply_recommended_defaults ok' );
iwsl_assert_same( true, $cc_f->is_configured(), 'one-click: is_configured true after apply' );
iwsl_assert_same( true, $cc_f->settings()['enabled'], 'one-click: enabled persisted' );
$live = $cc_f->filter_output( iwsl_cc_sample_page() );
iwsl_assert( false !== strpos( $live, 'iwsl-cc-banner' ), 'one-click: banner markup now injected for a fresh visitor' );
iwsl_assert( false !== strpos( $live, 'data-iwsl-consent="statistics"' ), 'one-click: GA auto-blocked before consent' );
iwsl_assert( false !== strpos( $live, 'data-iwsl-consent="marketing"' ), 'one-click: YouTube embed auto-blocked before consent' );
iwsl_assert( false !== strpos( $live, "gtag('consent','default'" ), 'one-click: Consent Mode default emitted' );
iwsl_assert( false !== strpos( $live, 'We value your privacy' ), 'one-click: built-in banner copy used when title is empty' );

// Sparse overrides merge over the preset (wizard branding step).
$cc_f->apply_recommended_defaults( array( 'accent' => '#112233', 'banner_layout' => 'box' ) );
iwsl_assert_same( '#112233', $cc_f->settings()['accent'], 'one-click: accent override applied' );
iwsl_assert_same( 'box', $cc_f->settings()['banner_layout'], 'one-click: layout override applied' );

// Locked site: one click persists NOTHING (gate is STATEMENT 1 of the save).
$store_lk = new IWSL_Memory_Store();
$ent_lk   = iwsl_cc_entitlements( $store_lk, $CC_NOW, 'active', array( 'plus' => true ) ); // cookie_consent ABSENT
$cc_lk    = iwsl_cc_engine( $store_lk, $ent_lk, $CC_NOW );
$app_lk   = $cc_lk->apply_recommended_defaults();
iwsl_assert_same( false, $app_lk['ok'], 'one-click (locked): refused' );
iwsl_assert_same( 'entitlement-locked', $app_lk['reason'], 'one-click (locked): reason entitlement-locked' );
iwsl_assert_same( null, $store_lk->get( 'cookie_consent' ), 'one-click (locked): store untouched' );

// ── 11. Auto-detection: detect_vendors / detect_trackers ─────────────────────

$det = IWSL_Consent_Classifier::detect_vendors( iwsl_cc_sample_page() );
iwsl_assert_same( 2, count( $det ), 'detect: exactly GA + YouTube found on the sample page' );
iwsl_assert_same( 'statistics', $det['google_analytics']['category'], 'detect: GA categorized statistics (analytics)' );
iwsl_assert_same( 2, $det['google_analytics']['count'], 'detect: GA counted twice (loader src + inline gtag)' );
iwsl_assert_same( 'YouTube embed', $det['youtube']['label'], 'detect: YouTube label carried for the wizard UI' );
iwsl_assert_same( 'marketing', $det['youtube']['category'], 'detect: YouTube categorized marketing' );
iwsl_assert_same( array(), IWSL_Consent_Classifier::detect_vendors( '<p>hello</p>' ), 'detect: tracker-free page → empty map' );
iwsl_assert_same( array(), IWSL_Consent_Classifier::detect_vendors( '' ), 'detect: empty input → empty map' );

// Engine wrapper honors the admin's per-vendor overrides.
$store_dv = new IWSL_Memory_Store();
$ent_dv   = iwsl_cc_unlocked_entitlements( $store_dv, $CC_NOW );
$cc_dv    = iwsl_cc_engine( $store_dv, $ent_dv, $CC_NOW );
$cc_dv->save_settings( array( 'enabled' => '1', 'vendor_overrides' => array( 'youtube' => 'preferences' ) ) );
iwsl_assert_same( 'preferences', $cc_dv->detect_trackers( iwsl_cc_sample_page() )['youtube']['category'], 'detect: engine wrapper applies vendor overrides' );

// New signatures: Matomo / Snapchat / Tawk.to auto-classified.
iwsl_assert_same( 'statistics', IWSL_Consent_Classifier::classify_src( 'https://cdn.matomo.cloud/acme/matomo.js' ), 'classify: Matomo → statistics' );
iwsl_assert_same( 'statistics', IWSL_Consent_Classifier::classify_snippet( '_paq.push(["trackPageView"]);' ), 'classify: Matomo _paq snippet → statistics' );
iwsl_assert_same( 'marketing', IWSL_Consent_Classifier::classify_src( 'https://sc-static.net/scevent.min.js' ), 'classify: Snapchat Pixel → marketing' );
iwsl_assert_same( 'marketing', IWSL_Consent_Classifier::classify_snippet( 'snaptr("init","abc");' ), 'classify: snaptr snippet → marketing' );
iwsl_assert_same( 'preferences', IWSL_Consent_Classifier::classify_src( 'https://embed.tawk.to/abc/default' ), 'classify: Tawk.to chat → preferences (functional)' );

// ── 12. Admin preview + non-HTML buffer guard ────────────────────────────────

// Preview flag flows into the runtime config; the show-path checks it.
$store_p = new IWSL_Memory_Store();
$ent_p   = iwsl_cc_unlocked_entitlements( $store_p, $CC_NOW );
$cc_p    = iwsl_cc_engine( $store_p, $ent_p, $CC_NOW, array( 'HTTP_CF_IPCOUNTRY' => 'DE', 'QUERY_STRING' => 'iwsl_cc_preview=1' ) );
$cc_p->apply_recommended_defaults();
$out_p = $cc_p->filter_output( iwsl_cc_sample_page() );
iwsl_assert( false !== strpos( $out_p, '"preview":true' ), 'preview: ?iwsl_cc_preview=1 sets preview:true in the config' );
iwsl_assert( false !== strpos( $out_p, '!CFG.preview' ), 'preview: runtime ignores a prior consent cookie while previewing' );

$cc_np  = iwsl_cc_engine( $store_p, $ent_p, $CC_NOW, array( 'HTTP_CF_IPCOUNTRY' => 'DE' ) );
$out_np = $cc_np->filter_output( iwsl_cc_sample_page() );
iwsl_assert( false !== strpos( $out_np, '"preview":false' ), 'preview: normal visit carries preview:false' );

// REQUEST_URI fallback when QUERY_STRING is absent from the server map.
$cc_ru  = iwsl_cc_engine( $store_p, $ent_p, $CC_NOW, array( 'REQUEST_URI' => '/?iwsl_cc_preview=1' ) );
iwsl_assert( false !== strpos( $cc_ru->filter_output( iwsl_cc_sample_page() ), '"preview":true' ), 'preview: derived from REQUEST_URI when QUERY_STRING absent' );

// preview_url uses the (stubbed) home_url.
iwsl_assert_same( 'https://fixture-site.test/?iwsl_cc_preview=1', $cc_p->preview_url(), 'preview: preview_url built from home_url' );

// Non-HTML buffers are NEVER injected into, even enabled + unlocked.
$json_payload = '{"ok":true,"items":[1,2,3]}';
iwsl_assert_same( $json_payload, $cc_p->filter_output( $json_payload ), 'guard: JSON buffer served byte-identical (no injection)' );
$xml_payload = '<?xml version="1.0"?><rss><channel><title>t</title></channel></rss>';
iwsl_assert_same( $xml_payload, $cc_p->filter_output( $xml_payload ), 'guard: XML/RSS buffer served byte-identical (no injection)' );
$fragment = '<body><p>partial theme output</p></body>';
iwsl_assert( false !== strpos( $cc_p->filter_output( $fragment ), 'iwsl-cc-banner' ), 'guard: a </body>-bearing page still gets the banner (fallback append)' );

// ── 12. Centered-popup layout + a closable preferences modal (2026-07-22) ─────
$cc_center = $cc->sanitize_settings( array( 'enabled' => '1', 'banner_layout' => 'center', 'categories' => array( 'statistics' => '1' ) ) );
iwsl_assert_same( 'center', $cc_center['banner_layout'], 'layout: "center" accepted by sanitize' );
iwsl_assert_same( 'bar', $cc->sanitize_settings( array( 'banner_layout' => 'wobble' ) )['banner_layout'], 'layout: unknown value falls back to bar' );

$cc_page       = '<html><head></head><body></body></html>';
$cc_center_out = $cc->transform( $cc_page, $cc_center );
iwsl_assert( false !== strpos( $cc_center_out, 'iwsl-cc-center' ), 'center: root carries the iwsl-cc-center class' );
iwsl_assert( false !== strpos( $cc_center_out, 'iwsl-cc-scrim' ), 'center: blurred full-viewport scrim rendered' );
iwsl_assert( false !== strpos( $cc_center_out, 'backdrop-filter:blur' ), 'center: scrim uses backdrop blur' );

$cc_bar_out = $cc->transform( $cc_page, $cc->sanitize_settings( array( 'enabled' => '1', 'banner_layout' => 'bar', 'categories' => array( 'statistics' => '1' ) ) ) );
iwsl_assert( false !== strpos( $cc_bar_out, 'data-iwsl-action="close-modal"' ), 'modal: has a close (×) control' );
iwsl_assert( false !== strpos( $cc_bar_out, 'data-iwsl-action="dismiss"' ), 'banner: has a dismiss (×) control' );
iwsl_assert( false !== strpos( $cc_bar_out, 'reopen"){show();}' ), 'reopen: opens the simple banner, not the prefs modal' );
iwsl_assert( false !== strpos( $cc_bar_out, 'close-modal"){' ), 'runtime: close-modal handler wired' );
iwsl_assert( false !== strpos( $cc_bar_out, 'dismiss"){hide();' ), 'runtime: dismiss handler returns to the floating handle' );

// cleanup: this suite installs no $GLOBALS — script-local temporaries only.
unset( $store, $ent, $cc, $CC_NOW );
