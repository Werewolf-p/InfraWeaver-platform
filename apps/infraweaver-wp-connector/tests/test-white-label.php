<?php
/**
 * Custom login + admin white-label (gate flag `white_label`, tier Ultimate): the
 * generic engine (IWSL_White_Label) + the login and admin branding surfaces.
 *
 * Runs under the zero-dependency harness — the engine and surfaces touch no
 * WordPress function that is not function_exists-guarded (escaping falls back to
 * htmlspecialchars; add_filter/add_action/esc_url/wp_http_validate_url are simply
 * skipped), so an injected store + fixed clock are all that is needed.
 *
 * A RECORDING FAKE surface proves the entitlement gate blocks BEFORE any surface
 * is resolved (apply()'s statement 1 short-circuits with zero side effects). A
 * fake admin-bar proves the admin-bar node removal, and output buffering proves
 * the login <style> block. Every gate / gauntlet / escaping / read-revalidation /
 * revocation assertion runs with no external dependency.
 */

// ── recording fakes (harness only) ────────────────────────────────────────────

/** Records remove_node() calls so the admin-bar effect can be asserted. */
final class IWSL_WL_Fake_Admin_Bar {

	/** @var string[] */
	public $removed = array();

	public function remove_node( $id ): void {
		$this->removed[] = (string) $id;
	}
}

/** A recording fake surface — proves whether (and how often) resolve() was reached. */
final class IWSL_WL_Recording_Surface implements IWSL_Brand_Surface {

	/** @var int */
	public $resolve_calls = 0;

	public function id(): string {
		return 'brandfake';
	}
	public function label(): string {
		return 'Recording fake surface';
	}
	public function hooks(): array {
		return array( 'iwsl_fake_hook' );
	}
	public function resolve( array $settings ): array {
		$this->resolve_calls++;
		return array( 'id' => 'brandfake', 'active' => true );
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** An entitlement gate at a chosen state / heartbeat-age / flag set, on a fixed clock. */
function iwsl_wl_entitlements( int $now, string $state, int $verified_age_ms, array $flags ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', $state );
	$store->set( 'last_verified_at', $now - $verified_age_ms );
	$store->set( 'entitlements', $flags );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** Unlocked gate: active + fresh heartbeat + white_label flag. */
function iwsl_wl_unlocked( int $now ): IWSL_Entitlements {
	return iwsl_wl_entitlements( $now, 'active', 60000, array( 'plus' => true, 'white_label' => true ) );
}

$NOW   = 20000000;
$clock = static function () use ( $NOW ): int {
	return $NOW;
};

// ── 1. Gate blocks: save writes nothing, apply() no-ops, hooks return defaults ─

// (a) white_label flag ABSENT.
$store1a = new IWSL_Memory_Store();
$ent1a   = iwsl_wl_entitlements( $NOW, 'active', 60000, array( 'plus' => true ) ); // white_label absent
$wl1a    = new IWSL_White_Label( $ent1a, $store1a, $clock );
$r1a     = $wl1a->save_settings( array( 'login_header_text' => 'Acme', 'hide_wp_logo' => true ) );
iwsl_assert_same( false, $r1a['ok'], 'gate blocks (absent flag): save_settings ok=false' );
iwsl_assert_same( 'entitlement-locked', $r1a['reason'], 'gate blocks (absent flag): reason entitlement-locked' );
iwsl_assert_same( null, $store1a->get( IWSL_White_Label::SETTINGS_KEY ), 'gate blocks (absent flag): settings NEVER written' );
iwsl_assert_same( false, $wl1a->apply()['applied'], 'gate blocks (absent flag): apply() applied=false' );
iwsl_assert_same( 'DEFAULT', $wl1a->filter_login_header_text( 'DEFAULT' ), 'gate blocks (absent flag): login_headertext filter returns default' );
iwsl_assert_same( 'https://d/', $wl1a->filter_login_header_url( 'https://d/' ), 'gate blocks (absent flag): login_headerurl filter returns default' );
ob_start();
$wl1a->print_login_styles();
iwsl_assert_same( '', ob_get_clean(), 'gate blocks (absent flag): print_login_styles emits nothing' );

// (b) state != active, even WITH the flag true.
$store1b = new IWSL_Memory_Store();
$ent1b   = iwsl_wl_entitlements( $NOW, 'pending', 60000, array( 'white_label' => true ) );
$wl1b    = new IWSL_White_Label( $ent1b, $store1b, $clock );
$r1b     = $wl1b->save_settings( array( 'admin_footer_text' => 'Acme' ) );
iwsl_assert_same( 'entitlement-locked', $r1b['reason'], 'gate blocks (not active): entitlement-locked despite flag' );
iwsl_assert_same( null, $store1b->get( IWSL_White_Label::SETTINGS_KEY ), 'gate blocks (not active): settings NEVER written' );
iwsl_assert_same( 'Thanks', $wl1b->filter_admin_footer_text( 'Thanks' ), 'gate blocks (not active): admin_footer_text returns default' );

// (c) stale heartbeat, even WITH the flag true.
$store1c = new IWSL_Memory_Store();
$ent1c   = iwsl_wl_entitlements( $NOW, 'active', 10800000, array( 'white_label' => true ) ); // 3h ago — stale
$wl1c    = new IWSL_White_Label( $ent1c, $store1c, $clock );
$r1c     = $wl1c->save_settings( array( 'login_logo_url' => '/logo.png' ) );
iwsl_assert_same( 'entitlement-locked', $r1c['reason'], 'gate blocks (stale heartbeat): entitlement-locked despite flag' );
iwsl_assert_same( null, $store1c->get( IWSL_White_Label::SETTINGS_KEY ), 'gate blocks (stale heartbeat): settings NEVER written' );

// ── 2. Unlock → save persists, apply() resolves, hooks apply the brand ────────

$store2 = new IWSL_Memory_Store();
$wl2    = new IWSL_White_Label( iwsl_wl_unlocked( $NOW ), $store2, $clock );
$save2  = $wl2->save_settings(
	array(
		'login_logo_url'    => '/wp-content/uploads/brand/logo.png',
		'login_header_url'  => 'https://brand.example',
		'login_header_text' => 'Acme Intranet',
		'login_message'     => 'Members only.',
		'admin_footer_text' => 'Powered by Acme',
		'hide_wp_logo'      => true,
	)
);
iwsl_assert_same( true, $save2['ok'], 'unlock: save_settings ok=true' );
$stored2 = $store2->get( IWSL_White_Label::SETTINGS_KEY );
iwsl_assert( is_array( $stored2 ) && '/wp-content/uploads/brand/logo.png' === $stored2['login_logo_url'], 'unlock: logo URL persisted' );
iwsl_assert( is_array( $stored2 ) && true === $stored2['hide_wp_logo'], 'unlock: hide_wp_logo persisted' );

$d2    = $wl2->apply();
$login = $d2['surfaces']['login'];
iwsl_assert_same( true, $d2['applied'], 'unlock: apply() applied=true' );
iwsl_assert( false !== strpos( $login['logo_css'], 'url("/wp-content/uploads/brand/logo.png")' ), 'unlock: login logo CSS built from the stored URL' );
iwsl_assert_same( 'https://brand.example', $wl2->filter_login_header_url( 'https://default/' ), 'unlock: login_headerurl filter returns the custom URL' );
iwsl_assert_same( 'Acme Intranet', $wl2->filter_login_header_text( 'WordPress' ), 'unlock: login_headertext filter returns the custom text' );
iwsl_assert( false !== strpos( (string) $wl2->filter_login_message( 'ORIG' ), 'Members only.' ), 'unlock: login_message prepends the custom message' );
iwsl_assert( false !== strpos( (string) $wl2->filter_login_message( 'ORIG' ), 'ORIG' ), 'unlock: login_message preserves the original message' );
iwsl_assert( false !== strpos( (string) $wl2->filter_admin_footer_text( 'Thanks WP' ), 'Powered by Acme' ), 'unlock: admin_footer_text filter returns the custom footer' );

ob_start();
$wl2->print_login_styles();
$style2 = ob_get_clean();
iwsl_assert( false !== strpos( $style2, '<style id="iwsl-white-label-login">' ), 'unlock: print_login_styles emits the style block' );
iwsl_assert( false !== strpos( $style2, 'logo.png' ), 'unlock: style block contains the logo URL' );

$GLOBALS['wp_admin_bar'] = new IWSL_WL_Fake_Admin_Bar();
$wl2->remove_admin_bar_wp_logo();
iwsl_assert( in_array( 'wp-logo', $GLOBALS['wp_admin_bar']->removed, true ), 'unlock: wp-logo node removed from the admin bar' );
unset( $GLOBALS['wp_admin_bar'] );

// ── 3. URL gauntlet: hostile URLs rejected, clean URLs accepted ───────────────

$store3 = new IWSL_Memory_Store();
$wl3    = new IWSL_White_Label( iwsl_wl_unlocked( $NOW ), $store3, $clock );

$r3 = $wl3->save_settings(
	array(
		'login_logo_url'    => 'javascript:alert(1)',
		'login_header_url'  => 'https://trusted@evil.com',
		'login_header_text' => 'Kept',
	)
);
iwsl_assert_same( true, $r3['ok'], 'gauntlet: save still succeeds while dropping bad URLs' );
iwsl_assert_same( '', $r3['settings']['login_logo_url'], 'gauntlet: javascript: logo rejected → empty' );
iwsl_assert_same( '', $r3['settings']['login_header_url'], 'gauntlet: userinfo (trusted@evil) URL rejected → empty' );
iwsl_assert_same( 'Kept', $r3['settings']['login_header_text'], 'gauntlet: clean text field preserved' );

iwsl_assert_same( '', $wl3->save_settings( array( 'login_logo_url' => '//evil.com/x.png' ) )['settings']['login_logo_url'], 'gauntlet: scheme-relative logo rejected' );
iwsl_assert_same( '', $wl3->save_settings( array( 'login_header_url' => 'https://good\\evil.com' ) )['settings']['login_header_url'], 'gauntlet: backslash URL rejected' );
iwsl_assert_same( '', $wl3->save_settings( array( 'login_logo_url' => '/logo).png' ) )['settings']['login_logo_url'], 'gauntlet: CSS-breaking char in logo rejected' );

$ok3 = $wl3->save_settings( array( 'login_logo_url' => '/a/logo.png', 'login_header_url' => 'https://ok.example/x' ) )['settings'];
iwsl_assert_same( '/a/logo.png', $ok3['login_logo_url'], 'gauntlet: rooted-relative logo accepted' );
iwsl_assert_same( 'https://ok.example/x', $ok3['login_header_url'], 'gauntlet: clean https URL accepted' );

// ── 4. Escaping: hostile text is escaped in the resolved fragments ────────────

$store4 = new IWSL_Memory_Store();
$wl4    = new IWSL_White_Label( iwsl_wl_unlocked( $NOW ), $store4, $clock );
$wl4->save_settings(
	array(
		'login_message'     => '<script>alert(1)</script>',
		'login_header_text' => 'A & B "co"',
		'admin_footer_text' => '<b>boom</b>',
	)
);
$d4     = $wl4->apply();
$login4 = $d4['surfaces']['login'];
$admin4 = $d4['surfaces']['admin'];
iwsl_assert( false === strpos( $login4['message_html'], '<script>' ), 'escaping: raw <script> absent from the login message HTML' );
iwsl_assert( false !== strpos( $login4['message_html'], '&lt;script&gt;' ), 'escaping: <script> is HTML-escaped in the login message' );
iwsl_assert( false === strpos( $login4['header_text'], '"' ), 'escaping: quotes escaped in the header text' );
iwsl_assert( false === strpos( $admin4['footer_html'], '<b>' ), 'escaping: raw <b> absent from the admin footer HTML' );

// ── 5. Read-time re-validation: a DB-tampered value is dropped on read ────────

$store5 = new IWSL_Memory_Store();
$store5->set(
	IWSL_White_Label::SETTINGS_KEY,
	array(
		'login_logo_url'    => 'javascript:evil',
		'login_header_url'  => '//evil.example',
		'login_header_text' => "bad\x00text",
		'hide_wp_logo'      => true,
	)
);
$wl5 = new IWSL_White_Label( iwsl_wl_unlocked( $NOW ), $store5, $clock );
$s5  = $wl5->settings();
iwsl_assert_same( '', $s5['login_logo_url'], 'read re-validate: tampered javascript: logo dropped on read' );
iwsl_assert_same( '', $s5['login_header_url'], 'read re-validate: tampered scheme-relative header URL dropped on read' );
iwsl_assert( false === strpos( $s5['login_header_text'], "\x00" ), 'read re-validate: control char stripped from text on read' );
iwsl_assert_same( true, $s5['hide_wp_logo'], 'read re-validate: valid boolean preserved on read' );
iwsl_assert_same( '', $wl5->apply()['surfaces']['login']['logo_css'], 'read re-validate: no logo CSS emitted from the tampered store' );

// ── 6. Revocation instantly restores default chrome (settings persist) ────────

$store6 = new IWSL_Memory_Store();
$wl6    = new IWSL_White_Label( iwsl_wl_unlocked( $NOW ), $store6, $clock );
$wl6->save_settings( array( 'login_header_text' => 'Acme', 'hide_wp_logo' => true ) );
iwsl_assert( is_array( $store6->get( IWSL_White_Label::SETTINGS_KEY ) ), 'revoke: settings are persisted while unlocked' );

// Same settings store, but the flag has been revoked from the console.
$wl6_revoked = new IWSL_White_Label( iwsl_wl_entitlements( $NOW, 'active', 60000, array() ), $store6, $clock );
iwsl_assert_same( false, $wl6_revoked->apply()['applied'], 'revoke: apply() applied=false immediately after the flag is revoked' );
iwsl_assert_same( 'WP', $wl6_revoked->filter_login_header_text( 'WP' ), 'revoke: login_headertext returns default despite persisted settings' );
$GLOBALS['wp_admin_bar'] = new IWSL_WL_Fake_Admin_Bar();
$wl6_revoked->remove_admin_bar_wp_logo();
iwsl_assert( array() === $GLOBALS['wp_admin_bar']->removed, 'revoke: admin-bar node NOT removed after the flag is revoked' );
unset( $GLOBALS['wp_admin_bar'] );

// ── 7. Registry + capabilities sanity ─────────────────────────────────────────

$surfaces = IWSL_White_Label::surfaces();
iwsl_assert( array_key_exists( 'login', $surfaces ) && array_key_exists( 'admin', $surfaces ), 'registry: login + admin surfaces registered' );
iwsl_assert( $surfaces['login'] instanceof IWSL_Brand_Surface, 'registry: login surface implements IWSL_Brand_Surface' );
iwsl_assert( $surfaces['admin'] instanceof IWSL_Brand_Surface, 'registry: admin surface implements IWSL_Brand_Surface' );
iwsl_assert_same( 'login', $surfaces['login']->id(), 'registry: login surface id is stable' );
iwsl_assert( array() !== $surfaces['login']->hooks(), 'registry: login surface declares its hooks' );
$caps7 = ( new IWSL_White_Label( iwsl_wl_unlocked( $NOW ), new IWSL_Memory_Store(), $clock ) )->capabilities();
iwsl_assert( isset( $caps7['login']['hooks'] ) && in_array( 'login_headerurl', $caps7['login']['hooks'], true ), 'capabilities: login surface lists login_headerurl' );

// ── 8. Pluggable registry: an injected surface is resolved only when unlocked ─

$fake8 = new IWSL_WL_Recording_Surface();
$wl8   = new IWSL_White_Label( iwsl_wl_unlocked( $NOW ), new IWSL_Memory_Store(), $clock, array( 'brandfake' => $fake8 ) );
$d8    = $wl8->apply();
iwsl_assert_same( 1, $fake8->resolve_calls, 'pluggable: injected surface resolved once when unlocked' );
iwsl_assert( isset( $d8['surfaces']['brandfake'] ), 'pluggable: injected surface fragment present in the decision' );

$fake8b = new IWSL_WL_Recording_Surface();
$wl8b   = new IWSL_White_Label( iwsl_wl_entitlements( $NOW, 'active', 60000, array() ), new IWSL_Memory_Store(), $clock, array( 'brandfake' => $fake8b ) );
$wl8b->apply();
iwsl_assert_same( 0, $fake8b->resolve_calls, 'pluggable: locked gate resolves NO surface (zero side effects)' );

// ── 9. purge(): teardown deletes the settings option key ──────────────────────

// (a) A configured site: purge() removes the settings map.
$store9 = new IWSL_Memory_Store();
$wl9    = new IWSL_White_Label( iwsl_wl_unlocked( $NOW ), $store9, $clock );
$wl9->save_settings( array( 'login_header_text' => 'Acme', 'hide_wp_logo' => true ) );
iwsl_assert( is_array( $store9->get( IWSL_White_Label::SETTINGS_KEY ) ), 'purge setup: settings present' );
$p9 = $wl9->purge();
iwsl_assert_same( true, $p9['ok'], 'purge: ok=true' );
iwsl_assert_same( true, $p9['deleted'], 'purge: deleted true (a settings map existed)' );
iwsl_assert_same( null, $store9->get( IWSL_White_Label::SETTINGS_KEY ), 'purge: settings option key truly gone' );
iwsl_assert_same( '', $wl9->settings()['login_header_text'], 'purge: settings() falls back to defaults after purge' );
iwsl_assert_same( false, $wl9->settings()['hide_wp_logo'], 'purge: boolean falls back to default (false) after purge' );

// (b) idempotent + cheap-when-clean: a second purge finds nothing to remove.
$p9b = $wl9->purge();
iwsl_assert_same( true, $p9b['ok'], 'purge: second call still ok (idempotent)' );
iwsl_assert_same( false, $p9b['deleted'], 'purge: second call reports nothing to delete' );

// (c) a fresh, never-configured engine: purge() is a clean no-op.
$wl9f = new IWSL_White_Label( iwsl_wl_unlocked( $NOW ), new IWSL_Memory_Store(), $clock );
$p9f  = $wl9f->purge();
iwsl_assert_same( true, $p9f['ok'], 'purge (never configured): ok' );
iwsl_assert_same( false, $p9f['deleted'], 'purge (never configured): nothing to delete' );
