<?php
/**
 * Content / Branding / Config domain: the email brand surface, the brand-kit
 * extensions to IWSL_White_Label (accent/logo/name + email/maintenance adoption),
 * IWSL_Email_Delivery::brand_mail(), the IWSL_Maintenance_Mode brand seam, and the
 * five signed fleet methods (branding.get/set, config.get/set, content.duplicate)
 * incl. their wire validators and the content.duplicate CONSOLE-ACTOR bypass.
 *
 * Zero-dependency harness. The signed-method runners are driven through the private
 * IWSL_Plugin::command_handlers() registry (reflection), exactly like
 * test-command-handler.php, over a real enrolled/active plugin. The WordPress write
 * surface the duplicate runner touches is stubbed against in-memory registries;
 * current_user_can() is stubbed to DENY so the console-actor bypass is proven, and
 * the same denial proves the admin (non-console) path still refuses.
 */

// ── in-memory WordPress stubs (harness only; subprocess-isolated) ──────────────

$GLOBALS['iwsl_cb_posts']   = array();
$GLOBALS['iwsl_cb_next']    = 2000;

if ( ! function_exists( 'wp_insert_post' ) ) {
	function wp_insert_post( $postarr, $wp_error = false ) {
		$id                             = ++$GLOBALS['iwsl_cb_next'];
		$GLOBALS['iwsl_cb_posts'][ $id ] = (object) $postarr;
		return $id;
	}
}
if ( ! function_exists( 'get_post' ) ) {
	function get_post( $id ) {
		return (object) array(
			'ID'             => (int) $id,
			'post_title'     => 'Src',
			'post_content'   => 'Body',
			'post_excerpt'   => 'Excerpt',
			'post_type'      => 'product', // a CPT — proves content.duplicate extends to CPTs
			'post_status'    => 'publish',
			'post_parent'    => 0,
			'menu_order'     => 0,
			'comment_status' => 'open',
			'ping_status'    => 'open',
		);
	}
}
if ( ! function_exists( 'current_user_can' ) ) {
	// DENY: proves the signed runner bypasses (console_actor) AND the admin path does not.
	function current_user_can( $cap, ...$args ) {
		return false;
	}
}
if ( ! function_exists( 'get_current_user_id' ) ) {
	function get_current_user_id() {
		return 0;
	}
}

// ── shared entitlement helpers ────────────────────────────────────────────────

function iwsl_cb_entitlements( int $now, string $state, int $age_ms, array $flags ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', $state );
	$store->set( 'last_verified_at', $now - $age_ms );
	$store->set( 'entitlements', $flags );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** Unlocked white-label gate: active + fresh heartbeat + white_label flag. */
function iwsl_cb_unlocked_wl( int $now ): IWSL_Entitlements {
	return iwsl_cb_entitlements( $now, 'active', 60000, array( 'white_label' => true ) );
}

$CB_NOW = 20000000;
$cb_clk = static function () use ( $CB_NOW ): int {
	return $CB_NOW;
};

// ── 1. Email brand surface (pure resolve) ─────────────────────────────────────

$surface = new IWSL_Email_Brand_Surface();

$off = $surface->resolve( array( 'apply_to_email' => false, 'email_logo_url' => '/l.png', 'brand_name' => 'Acme' ) );
iwsl_assert_same( '', $off['header_html'], 'email surface: apply_to_email OFF → empty header' );
iwsl_assert_same( true, $off['active'], 'email surface: active reflects configured content even when off' );

$on = $surface->resolve( array( 'apply_to_email' => true, 'email_logo_url' => 'https://cdn.example/l.png', 'brand_name' => 'Acme & Co', 'accent_color' => '#1a2b3c' ) );
iwsl_assert( false !== strpos( $on['header_html'], 'https://cdn.example/l.png' ), 'email surface: logo src present in header' );
iwsl_assert( false !== strpos( $on['header_html'], 'Acme &amp; Co' ), 'email surface: brand name HTML-escaped' );
iwsl_assert( false === strpos( $on['header_html'], 'Acme & Co' ), 'email surface: raw ampersand absent' );
iwsl_assert( false !== strpos( $on['header_html'], '#1a2b3c' ), 'email surface: accent applied to header' );

$empty = $surface->resolve( array( 'apply_to_email' => true ) );
iwsl_assert_same( '', $empty['header_html'], 'email surface: nothing configured → empty header even when apply on' );
iwsl_assert_same( false, $empty['active'], 'email surface: active false when nothing configured' );

$xss = $surface->resolve( array( 'apply_to_email' => true, 'brand_name' => '<script>alert(1)</script>' ) );
iwsl_assert( false === strpos( $xss['header_html'], '<script>' ), 'email surface: script tag escaped in name' );

// ── 2. Brand-kit sanitizers on IWSL_White_Label ───────────────────────────────

$wl = new IWSL_White_Label( iwsl_cb_unlocked_wl( $CB_NOW ), new IWSL_Memory_Store(), $cb_clk );
$s  = $wl->save_settings(
	array(
		'brand_name'           => 'Acme',
		'accent_color'         => '#ABCDEF',
		'email_logo_url'       => '/uploads/logo.png',
		'apply_to_email'       => true,
		'apply_to_maintenance' => true,
	)
)['settings'];
iwsl_assert_same( 'Acme', $s['brand_name'], 'brand kit: brand_name persisted' );
iwsl_assert_same( '#ABCDEF', $s['accent_color'], 'brand kit: valid #rrggbb accent persisted' );
iwsl_assert_same( '/uploads/logo.png', $s['email_logo_url'], 'brand kit: rooted email logo accepted' );
iwsl_assert_same( true, $s['apply_to_email'], 'brand kit: apply_to_email cast to bool' );
iwsl_assert_same( true, $s['apply_to_maintenance'], 'brand kit: apply_to_maintenance cast to bool' );

iwsl_assert_same( '', $wl->save_settings( array( 'accent_color' => 'red' ) )['settings']['accent_color'], 'brand kit: named-color accent rejected → empty' );
iwsl_assert_same( '', $wl->save_settings( array( 'accent_color' => '#ABC' ) )['settings']['accent_color'], 'brand kit: 3-digit hex rejected (needs 6)' );
iwsl_assert_same( '', $wl->save_settings( array( 'accent_color' => '#12345g' ) )['settings']['accent_color'], 'brand kit: non-hex-digit rejected' );
iwsl_assert_same( '', $wl->save_settings( array( 'email_logo_url' => 'javascript:alert(1)' ) )['settings']['email_logo_url'], 'brand kit: javascript: email logo rejected' );
iwsl_assert_same( '', $wl->save_settings( array( 'email_logo_url' => '/a).png' ) )['settings']['email_logo_url'], 'brand kit: CSS-breaking email logo rejected' );

// ── 3. email_brand_header() gating ────────────────────────────────────────────

$store_h = new IWSL_Memory_Store();
$wl_h    = new IWSL_White_Label( iwsl_cb_unlocked_wl( $CB_NOW ), $store_h, $cb_clk );
$wl_h->save_settings( array( 'brand_name' => 'Acme', 'email_logo_url' => '/l.png', 'apply_to_email' => true ) );
iwsl_assert( false !== strpos( $wl_h->email_brand_header(), 'Acme' ), 'header: unlocked + apply_to_email on → header present' );

$wl_h->save_settings( array( 'brand_name' => 'Acme', 'email_logo_url' => '/l.png', 'apply_to_email' => false ) );
iwsl_assert_same( '', $wl_h->email_brand_header(), 'header: apply_to_email off → empty' );

$wl_h->save_settings( array( 'brand_name' => 'Acme', 'email_logo_url' => '/l.png', 'apply_to_email' => true ) );
$wl_revoked = new IWSL_White_Label( iwsl_cb_entitlements( $CB_NOW, 'active', 60000, array() ), $store_h, $cb_clk );
iwsl_assert_same( '', $wl_revoked->email_brand_header(), 'header: white_label revoked → empty (stock mail restored instantly)' );

// ── 4. IWSL_Email_Delivery::brand_mail() prepend ──────────────────────────────

$ed = new IWSL_Email_Delivery( iwsl_cb_entitlements( $CB_NOW, 'active', 60000, array() ), new IWSL_Memory_Store(), $cb_clk );

$html_args = array( 'to' => 'a@b.com', 'subject' => 'Hi', 'message' => '<p>Body</p>', 'headers' => array( 'Content-Type: text/html' ) );
iwsl_assert_same( '<div>BRAND</div><p>Body</p>', $ed->brand_mail( $html_args, '<div>BRAND</div>' )['message'], 'brand_mail: header prepended to HTML body' );

$plain_args = array( 'to' => 'a@b.com', 'subject' => 'Hi', 'message' => 'Body', 'headers' => array() );
iwsl_assert_same( 'Body', $ed->brand_mail( $plain_args, '<div>BRAND</div>' )['message'], 'brand_mail: plain-text body NEVER receives markup' );

iwsl_assert_same( $html_args, $ed->brand_mail( $html_args, '' ), 'brand_mail: empty header → args returned unchanged' );

$str_hdr = array( 'message' => '<p>B</p>', 'headers' => 'Content-Type: text/html; charset=UTF-8' );
iwsl_assert( false !== strpos( $ed->brand_mail( $str_hdr, '<div>X</div>' )['message'], '<div>X</div>' ), 'brand_mail: string Content-Type header detected as HTML' );

// ── 5. maintenance_brand() gating + build_response brand seam (precedence) ────

$store_m = new IWSL_Memory_Store();
$wl_m    = new IWSL_White_Label( iwsl_cb_unlocked_wl( $CB_NOW ), $store_m, $cb_clk );
$wl_m->save_settings( array( 'brand_name' => 'BrandCo', 'email_logo_url' => '/logo.png', 'accent_color' => '#112233', 'apply_to_maintenance' => true ) );
$brand = $wl_m->maintenance_brand();
iwsl_assert( is_array( $brand ) && 'BrandCo' === $brand['name'], 'maintenance_brand: returns brand when apply_to_maintenance on' );
iwsl_assert_same( '/logo.png', $brand['logo_url'], 'maintenance_brand: logo url present' );
iwsl_assert_same( '#112233', $brand['accent'], 'maintenance_brand: accent present' );

$wl_m->save_settings( array( 'brand_name' => 'BrandCo', 'apply_to_maintenance' => false ) );
iwsl_assert_same( null, $wl_m->maintenance_brand(), 'maintenance_brand: null when apply_to_maintenance off' );

$wl_m->save_settings( array( 'brand_name' => 'BrandCo', 'apply_to_maintenance' => true ) );
$wl_m_locked = new IWSL_White_Label( iwsl_cb_entitlements( $CB_NOW, 'active', 60000, array() ), $store_m, $cb_clk );
iwsl_assert_same( null, $wl_m_locked->maintenance_brand(), 'maintenance_brand: null when white_label locked' );

$mm = new IWSL_Maintenance_Mode( iwsl_cb_entitlements( $CB_NOW, 'active', 60000, array( 'maintenance_mode' => true ) ), new IWSL_Memory_Store(), $cb_clk );

$resp = $mm->build_response( array( 'headline' => '', 'message' => '' ), array( 'logo_url' => '/l.png', 'name' => 'BrandCo', 'accent' => '#222222' ) );
iwsl_assert( false !== strpos( $resp['body'], 'BrandCo' ), 'maintenance brand: brand name fills a BLANK local headline' );
iwsl_assert( false !== strpos( $resp['body'], '/l.png' ), 'maintenance brand: brand logo rendered' );
iwsl_assert( false !== strpos( $resp['body'], '#222222' ), 'maintenance brand: accent applied' );

$resp2 = $mm->build_response( array( 'headline' => 'Local Title' ), array( 'name' => 'BrandCo' ) );
iwsl_assert( false !== strpos( $resp2['body'], 'Local Title' ), 'maintenance brand: explicit local headline WINS' );
iwsl_assert( false === strpos( $resp2['body'], 'BrandCo' ), 'maintenance brand: brand name NOT used when local headline set' );

$resp3 = $mm->build_response( array( 'headline' => 'Hi' ) );
iwsl_assert( false === strpos( $resp3['body'], '<img class="brand-logo"' ), 'maintenance brand: no brand provider → default badge, no logo <img>' );
iwsl_assert( false !== strpos( $resp3['body'], '<div class="dot"' ), 'maintenance brand: no brand provider → default dot badge kept' );

// ── 6. Signed methods: registry presence + validator parity ───────────────────

$f            = iwsl_fixtures();
$handlers_ref = new ReflectionMethod( 'IWSL_Plugin', 'command_handlers' );
$handlers_ref->setAccessible( true );
$registry = $handlers_ref->invoke( null );

$methods = IWSL_Plugin::allowed_methods();
foreach ( array( 'branding.get', 'branding.set', 'config.get', 'config.set', 'content.duplicate' ) as $m ) {
	iwsl_assert( array_key_exists( $m, $methods ), "registry: {$m} registered in allowed_methods()" );
}
iwsl_assert_same( null, $methods['branding.get'], 'registry: branding.get requires empty params (null validator)' );
iwsl_assert_same( null, $methods['config.get'], 'registry: config.get requires empty params (null validator)' );
iwsl_assert( is_callable( $methods['branding.set'] ), 'registry: branding.set carries a params validator' );
iwsl_assert( is_callable( $methods['config.set'] ), 'registry: config.set carries a params validator' );
iwsl_assert( is_callable( $methods['content.duplicate'] ), 'registry: content.duplicate carries a params validator' );

// branding.set validator
$vbs = $methods['branding.set'];
iwsl_assert_same( true, $vbs( (object) array( 'settings' => (object) array( 'brand_name' => 'Acme', 'apply_to_email' => true ) ) ), 'branding.set validator: valid settings accepted' );
iwsl_assert_same( false, $vbs( (object) array( 'settings' => (object) array( 'bogus' => 'x' ) ) ), 'branding.set validator: stray field refused' );
iwsl_assert_same( false, $vbs( (object) array( 'settings' => (object) array( 'brand_name' => 123 ) ) ), 'branding.set validator: non-string for a string field refused' );
iwsl_assert_same( false, $vbs( (object) array( 'settings' => (object) array( 'apply_to_email' => 'yes' ) ) ), 'branding.set validator: non-bool for a bool field refused' );
iwsl_assert_same( false, $vbs( (object) array( 'stray' => 1, 'settings' => (object) array() ) ), 'branding.set validator: stray top-level key refused' );
iwsl_assert_same( false, $vbs( (object) array() ), 'branding.set validator: missing settings refused' );
iwsl_assert_same( false, $vbs( (object) array( 'settings' => (object) array( 'login_message' => str_repeat( 'a', 9000 ) ) ) ), 'branding.set validator: byte bound enforced' );

// config.set validator
$vcs = $methods['config.set'];
iwsl_assert_same( true, $vcs( (object) array( 'values' => (object) array( 'WP_MEMORY_LIMIT' => '256M' ) ) ), 'config.set validator: valid size accepted' );
iwsl_assert_same( true, $vcs( (object) array( 'values' => (object) array( 'WP_DEBUG' => true ) ) ), 'config.set validator: valid bool accepted' );
iwsl_assert_same( true, $vcs( (object) array( 'values' => (object) array() ) ), 'config.set validator: empty values accepted' );
iwsl_assert_same( false, $vcs( (object) array( 'values' => (object) array( 'EVIL_KEY' => '1' ) ) ), 'config.set validator: non-allowlist key refused' );
iwsl_assert_same( false, $vcs( (object) array( 'values' => (object) array( 'WP_MEMORY_LIMIT' => 'not-a-size' ) ) ), 'config.set validator: bad size shape refused' );
iwsl_assert_same( false, $vcs( (object) array( 'values' => (object) array( 'WP_DEBUG' => 'true' ) ) ), 'config.set validator: non-bool for a bool key refused' );
iwsl_assert_same( false, $vcs( (object) array( 'stray' => 1, 'values' => (object) array() ) ), 'config.set validator: stray top-level key refused' );

// content.duplicate validator
$vcd = $methods['content.duplicate'];
iwsl_assert_same( true, $vcd( (object) array( 'post_id' => 42 ) ), 'content.duplicate validator: positive int accepted' );
iwsl_assert_same( false, $vcd( (object) array( 'post_id' => 0 ) ), 'content.duplicate validator: zero refused' );
iwsl_assert_same( false, $vcd( (object) array( 'post_id' => -1 ) ), 'content.duplicate validator: negative refused' );
iwsl_assert_same( false, $vcd( (object) array( 'post_id' => '42' ) ), 'content.duplicate validator: string int refused' );
iwsl_assert_same( false, $vcd( (object) array( 'post_id' => 42, 'x' => 1 ) ), 'content.duplicate validator: stray key refused' );
iwsl_assert_same( false, $vcd( (object) array() ), 'content.duplicate validator: missing post_id refused' );

// ── 7. Signed-method runners over a real enrolled/active plugin ───────────────

/** An enrolled + activated plugin (heartbeat stamped) on the fixture clock. */
$cb_active_plugin = static function () use ( $f ): array {
	$store  = new IWSL_Memory_Store();
	$plugin = new IWSL_Plugin( $store, iwsl_now_t0( 5000 ) );
	$plugin->enrollment()->handle_bundle( iwsl_clone( $f->enrollment->signed ) );
	$plugin->handle_command( iwsl_clone( $f->commands->valid ) ); // activate + record heartbeat
	return array( $store, $plugin );
};

/** Grant a console-authoritative flag map through the REAL entitlements.set runner. */
$cb_grant = static function ( $registry, $plugin, array $flags ): void {
	$env                       = new stdClass();
	$env->params               = new stdClass();
	$env->params->entitlements = (object) $flags;
	$registry['entitlements.set']->run( $plugin, $env );
};

// branding.get — read-only, SAFE WHEN LOCKED.
list( $store_g, $plugin_g ) = $cb_active_plugin();
$env_g          = new stdClass();
$env_g->params  = new stdClass();
list( $ok_g, $res_g ) = $registry['branding.get']->run( $plugin_g, $env_g );
iwsl_assert_same( true, $ok_g, 'branding.get: ok even when white_label locked (read-only safe)' );
iwsl_assert_same( false, $res_g['gate']['unlocked'], 'branding.get: reports the locked gate honestly' );
iwsl_assert( isset( $res_g['settings'] ) && isset( $res_g['surfaces']['email'] ), 'branding.get: returns settings + surfaces (incl. the new email surface)' );

// branding.set — locked refusal, then unlocked success via the same gauntlet.
$env_bs                   = new stdClass();
$env_bs->params           = new stdClass();
$env_bs->params->settings = (object) array( 'brand_name' => 'Acme', 'apply_to_email' => true );
list( $ok_bl, $res_bl ) = $registry['branding.set']->run( $plugin_g, $env_bs );
iwsl_assert_same( false, $ok_bl, 'branding.set: refused (ok=false) when white_label locked' );
iwsl_assert_same( 'entitlement-locked', $res_bl['reason'], 'branding.set: reason entitlement-locked' );
iwsl_assert_same( null, $store_g->get( IWSL_White_Label::SETTINGS_KEY ), 'branding.set: NOTHING written when locked' );

$cb_grant( $registry, $plugin_g, array( 'white_label' => true ) );
list( $ok_bu, $res_bu ) = $registry['branding.set']->run( $plugin_g, $env_bs );
iwsl_assert_same( true, $ok_bu, 'branding.set: succeeds once white_label granted' );
iwsl_assert_same( 'Acme', $res_bu['settings']['brand_name'], 'branding.set: stored through the identical save-time gauntlet' );

// config.get — RBAC-only, no entitlement gate.
$env_cg         = new stdClass();
$env_cg->params = new stdClass();
list( $ok_cg, $res_cg ) = $registry['config.get']->run( $plugin_g, $env_cg );
iwsl_assert_same( true, $ok_cg, 'config.get: ok (RBAC-only, no entitlement gate)' );
iwsl_assert( isset( $res_cg['allowlist']['WP_MEMORY_LIMIT'] ), 'config.get: returns the allow-list' );
iwsl_assert( array_key_exists( 'current', $res_cg ) && array_key_exists( 'configured', $res_cg ), 'config.get: returns current + configured (configured-vs-effective honesty)' );
iwsl_assert( in_array( $res_cg['mechanism'], array( 'htaccess', 'user_ini' ), true ), 'config.get: reports the php-limits mechanism' );

// config.set — RBAC-only; empty values is a safe no-op (no file writes).
$env_cs                 = new stdClass();
$env_cs->params         = new stdClass();
$env_cs->params->values = (object) array();
list( $ok_cs, $res_cs ) = $registry['config.set']->run( $plugin_g, $env_cs );
iwsl_assert_same( true, $ok_cs, 'config.set: ok (RBAC-only)' );
iwsl_assert_same( array(), $res_cs['applied'], 'config.set: empty values → nothing applied (no writes)' );

// content.duplicate — statement-1 gate holds for the signed runner, then the
// CONSOLE-ACTOR bypass duplicates a CPT despite current_user_can()=false.
list( $store_d, $plugin_d ) = $cb_active_plugin();
$env_cd                = new stdClass();
$env_cd->params        = new stdClass();
$env_cd->params->post_id = 77;
list( $ok_dl, $res_dl ) = $registry['content.duplicate']->run( $plugin_d, $env_cd );
iwsl_assert_same( false, $ok_dl, 'content.duplicate: refused when duplicate_post locked (statement-1 gate holds for a signed request)' );
iwsl_assert_same( 'entitlement-locked', $res_dl['reason'], 'content.duplicate: locked reason surfaced' );

$cb_grant( $registry, $plugin_d, array( 'duplicate_post' => true ) );
list( $ok_du, $res_du ) = $registry['content.duplicate']->run( $plugin_d, $env_cd );
iwsl_assert_same( true, $ok_du, 'content.duplicate: console-actor bypasses edit_post cap (current_user_can=false) and clones' );
iwsl_assert_same( 77, $res_du['source_id'], 'content.duplicate: source id echoed' );
iwsl_assert( isset( $res_du['new_id'] ) && $res_du['new_id'] > 0, 'content.duplicate: a new draft id is returned' );
iwsl_assert( isset( $GLOBALS['iwsl_cb_posts'][ $res_du['new_id'] ] ) && 'product' === $GLOBALS['iwsl_cb_posts'][ $res_du['new_id'] ]->post_type, 'content.duplicate: a CPT (product) cloned cleanly' );
iwsl_assert_same( 'Src (copy)', $GLOBALS['iwsl_cb_posts'][ $res_du['new_id'] ]->post_title, 'content.duplicate: title cloned with " (copy)" suffix' );
iwsl_assert_same( 'draft', $GLOBALS['iwsl_cb_posts'][ $res_du['new_id'] ]->post_status, 'content.duplicate: clone is a draft' );

// The admin (non-console) engine must STILL refuse without the edit_post cap —
// the bypass is not leaked outside the signed runner.
$dp_admin = new IWSL_Duplicate_Post( iwsl_cb_entitlements( $CB_NOW, 'active', 60000, array( 'duplicate_post' => true ) ), null );
iwsl_assert_same( 'forbidden', $dp_admin->duplicate( get_post( 5 ) )['reason'], 'admin path: non-console engine STILL refuses without edit_post cap (bypass not leaked)' );

// ── teardown: drop this suite's globals so they never leak into another suite ──
unset( $GLOBALS['iwsl_cb_posts'], $GLOBALS['iwsl_cb_next'] );
