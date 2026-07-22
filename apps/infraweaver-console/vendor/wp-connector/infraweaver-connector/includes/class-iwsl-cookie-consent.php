<?php
/**
 * Generic engine behind the gated "Cookie Consent & Privacy Compliance" feature
 * (flag `cookie_consent`, Ultimate tier) — a self-contained, Cookiebot/Complianz-
 * class consent platform with NO external service and NO CDN: every asset (banner
 * CSS/JS, Consent Mode signals, blocking transform) is on-server and inline.
 *
 * WHAT IT DOES.
 *  - PRIOR BLOCKING. On every anonymous front-end render it output-buffers the whole
 *    page and neutralizes known third-party tracker <script>/<iframe> tags BEFORE
 *    consent (IWSL_Consent_Classifier::block_html) so they cannot load or set a
 *    cookie — regardless of which plugin/theme injected them. An inline restore
 *    script un-blocks only the categories the visitor consents to, with no reload.
 *  - GEO-AWARE MODEL. EU/EEA/UK → opt-IN (GDPR/UK-GDPR); US → opt-OUT (CCPA/CPRA,
 *    with "Do Not Sell/Share" + Global Privacy Control honored); other regions →
 *    a configurable default. DNT and GPC signals are respected.
 *  - GOOGLE CONSENT MODE v2. Emits denied-by-default `gtag('consent','default',…)`
 *    early and `gtag('consent','update',…)` on consent (all seven signals).
 *  - PROVABLE COMPLIANCE. A bounded, privacy-safe consent log (timestamp,
 *    pseudonymous id, granted categories, region, policy version, method — never a
 *    raw IP) recorded server-side from the first-party consent cookie on the next
 *    render, so NO public/nopriv endpoint is added.
 *  - VERSIONED POLICY. Bumping the policy version re-prompts every visitor.
 *  - ONE-CLICK AUTO SETUP. recommended_defaults() is a complete, GDPR-safe settings
 *    map (opt-in, Consent Mode, GPC, all categories, auto-detected policy URL);
 *    apply_recommended_defaults() persists it through the same gated save path, so
 *    the admin wizard can turn the whole feature on correctly in ONE action.
 *  - ADMIN PREVIEW. A logged-in administrator appending ?iwsl_cc_preview=1 to any
 *    front-end URL sees the banner exactly as a fresh visitor would (their own
 *    consent cookie is ignored for display) — logged-in visitors are otherwise
 *    never touched. Preview changes ONLY what that admin's own browser renders.
 *
 * TRUST MODEL. Console-authoritative, mirroring every other Plus feature: the
 * `cookie_consent` flag is written ONLY by the dual-signed `entitlements.set`
 * runner (§7). There is deliberately NO self-set path, REST route, AJAX endpoint,
 * cron or nopriv surface — this is a front-end output-buffer plus a purely-local
 * admin settings/clear-log action. The gate is re-checked at every layer: the
 * admin page, the admin-post handlers (LAYER 2), and here as STATEMENT 1 of the
 * buffer callback, every mutator, record_consent() and clear_log(). The innermost
 * checks are authoritative — a locked/revoked site shows NO banner, blocks NOTHING
 * and records nothing, instantly. RESIDUAL RISK is the accepted `plus` model: a
 * direct-DB flip unlocks locally but re-locks within HEARTBEAT_FRESH_MS (2h)
 * because evaluate() also requires state==active AND a fresh signed heartbeat.
 *
 * SAFETY. In-process only — no exec/shell_exec/proc_open, no network, no eval. The
 * blocking transform is FAIL-SAFE: any error returns the ORIGINAL page unmodified,
 * never a blank site. The banner is fully self-contained (inline CSS/JS, no
 * external font/CDN/image) so it satisfies a strict CSP. Every stored value passes
 * a save-time gauntlet and is re-validated on read; every dynamic fragment is
 * escaped at output; the consent log is a bounded FIFO ring. WordPress calls are
 * function_exists-guarded so the engine runs under the zero-dependency test harness
 * with an injected store, clock, request map and front-end probe.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Cookie_Consent {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'cookie_consent';

	/** Store key for the sanitized settings map (option iwsl_cookie_consent). */
	const SETTINGS_KEY = 'cookie_consent';
	/** Store key for the consent-record ring buffer. */
	const LOG_KEY = 'cookie_consent_log';
	/** Store key for the per-site anonymization salt (generated once). */
	const SALT_KEY = 'cookie_consent_salt';

	/** admin-post action + nonce for the settings save. */
	const SAVE_ACTION = 'iwsl_cookie_consent_save';
	const SAVE_NONCE  = 'iwsl_cookie_consent_save';
	/** admin-post action + nonce for the "Clear consent log" button. */
	const CLEARLOG_ACTION = 'iwsl_cookie_consent_clear_log';
	const CLEARLOG_NONCE  = 'iwsl_cookie_consent_clear_log';

	/** Per-user PRG result transient prefix (append the user id). */
	const RESULT_TRANSIENT_PREFIX = 'iwsl_consent_result_';
	/** Result transient TTL (seconds). */
	const RESULT_TTL = 60;

	/** The Plus admin page slug the PRG redirect returns to. */
	const PAGE_SLUG = 'infraweaver-plus';

	/** First-party cookie the banner persists the visitor's choice in. */
	const COOKIE_NAME = 'iwsl_consent';

	/** Query parameter a logged-in administrator uses to preview the banner. */
	const PREVIEW_PARAM = 'iwsl_cc_preview';

	/** Hard FIFO cap on stored consent records — bounds option size. */
	const MAX_LOG_ENTRIES = 500;
	/** Rows shown in the admin log table (most recent first). */
	const MAX_DISPLAY = 100;

	/** Byte ceilings for the text settings. */
	const MAX_TITLE_LEN   = 200;
	const MAX_MESSAGE_LEN = 1000;
	const MAX_URL_LEN     = 2048;

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store settings + log live here. */
	private $store;

	/** @var callable():int current unix ms. */
	private $now_ms;

	/** @var array<string, mixed> request server map (region/DNT/GPC/cookie source). */
	private $server;

	/** @var callable():bool whether this is an anonymous front-end template render. */
	private $is_front;

	/**
	 * @param IWSL_Entitlements    $entitlements The gate.
	 * @param IWSL_Store|null      $store        Settings + log; defaults to the WP option store.
	 * @param callable|null        $now_ms       Clock, mirrors IWSL_Entitlements.
	 * @param array<string,mixed>|null $server   Request server map; defaults to $_SERVER (read-only).
	 * @param callable|null        $is_front     fn():bool; default is the anonymous front-end probe.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		?IWSL_Store $store = null,
		?callable $now_ms = null,
		?array $server = null,
		?callable $is_front = null
	) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : new IWSL_WP_Store();
		$this->now_ms       = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
		// Only header values are read (region/DNT/GPC/cookie), always cleaned and
		// never echoed raw — reading $_SERVER here is safe, mirroring the page cache.
		$this->server   = null !== $server ? $server : ( isset( $_SERVER ) && is_array( $_SERVER ) ? $_SERVER : array() ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
		$this->is_front = $is_front ?? self::default_is_front();
	}

	/**
	 * Wire the front-end output buffer + the two admin-post handlers. The buffer is
	 * started on template_redirect (front-end only); its callback re-checks the gate
	 * as its first act, so a locked/revoked site buffers nothing meaningful and the
	 * page is served untouched. Guarded so the harness can call it harmlessly.
	 */
	public function register(): void {
		if ( ! function_exists( 'add_action' ) ) {
			return;
		}
		add_action( 'template_redirect', array( $this, 'start_buffer' ), 2 );
		add_action( 'admin_post_' . self::SAVE_ACTION, array( $this, 'handle_save' ) );
		add_action( 'admin_post_' . self::CLEARLOG_ACTION, array( $this, 'handle_clear_log' ) );
	}

	// ── front-end: buffer + transform (STATEMENT 1 is the authoritative gate) ────

	/**
	 * template_redirect callback. STATEMENT 1 is the gate — a locked/revoked site
	 * returns immediately (no banner, no blocking, no recording). Records the visitor
	 * cookie (server-side, no endpoint) then starts the whole-page output buffer.
	 */
	public function start_buffer(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}
		if ( ! (bool) ( $this->is_front )() ) {
			return;
		}
		if ( empty( $this->settings()['enabled'] ) ) {
			return;
		}
		$this->maybe_record_consent();
		if ( function_exists( 'ob_start' ) ) {
			ob_start( array( $this, 'filter_output' ) );
		}
	}

	/**
	 * The output-buffer callback: receives the whole page HTML. STATEMENT 1 is the
	 * authoritative gate. Runs the prior-blocking transform + banner/Consent-Mode
	 * injection, FAIL-SAFE — any non-string transform result returns the original
	 * page so the site is never blanked.
	 *
	 * @param mixed $html
	 * @return mixed
	 */
	public function filter_output( $html ) {
		if ( ! is_string( $html ) || '' === $html ) {
			return $html;
		}
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $html;
		}
		$settings = $this->settings();
		if ( empty( $settings['enabled'] ) ) {
			return $html;
		}
		if ( ! self::looks_like_html( $html ) ) {
			return $html; // JSON/XML/other non-document buffer — never inject into it.
		}
		$out = $this->transform( $html, $settings );
		return is_string( $out ) ? $out : $html;
	}

	/**
	 * Whether a buffered payload is an HTML document the banner may be injected
	 * into. A template that emits JSON, XML or plain text (sitemaps, exports)
	 * must be served byte-identical — injecting markup would corrupt it.
	 */
	private static function looks_like_html( string $html ): bool {
		return false !== stripos( $html, '<html' )
			|| false !== stripos( $html, '<!doctype' )
			|| false !== stripos( $html, '</body>' );
	}

	/**
	 * Pure page transform: block known trackers, then inject the Consent Mode default
	 * (in <head>), the JSON config, the banner markup + inline restore script (before
	 * </body>). Never throws; returns the original html on any blocking failure.
	 *
	 * @param array<string,mixed> $settings
	 */
	public function transform( string $html, array $settings ): string {
		$region   = IWSL_Consent_Classifier::derive_region( $this->server );
		$model    = IWSL_Consent_Classifier::region_model( $region, (string) $settings['default_model'] );
		$dnt      = ! empty( $settings['respect_dnt'] ) && IWSL_Consent_Classifier::dnt_enabled( $this->server );
		$gpc      = ! empty( $settings['respect_gpc'] ) && IWSL_Consent_Classifier::gpc_enabled( $this->server );
		$defaults = IWSL_Consent_Classifier::default_consent( $model, $dnt, $gpc );

		$blocked = IWSL_Consent_Classifier::block_html( $html, $this->effective_signatures( $settings ) );
		$page    = (string) $blocked['html'];

		// Head: Consent Mode default (denied-by-default) as early as possible.
		if ( ! empty( $settings['consent_mode'] ) ) {
			$page = self::inject_after_head( $page, $this->consent_mode_default_script() );
		}

		// Body: JSON config + banner + restore runtime, all inline/self-contained.
		$footer = $this->config_script( $settings, $model, $defaults )
			. $this->banner_html( $settings, $model )
			. $this->runtime_script();
		$page = self::inject_before_body_end( $page, $footer );

		return $page;
	}

	// ── settings (reads safe on every render) ────────────────────────────────────

	/**
	 * The sanitized settings map, re-validated on every read (defence-in-depth): a
	 * DB-tampered value is normalized here, never mutated in place. `saved_at` is
	 * preserved from the stored record.
	 *
	 * @return array<string,mixed>
	 */
	public function settings(): array {
		$stored = $this->store->get( self::SETTINGS_KEY, array() );
		$stored = is_array( $stored ) ? $stored : array();
		$clean  = $this->sanitize_settings( $stored );
		$clean['saved_at'] = isset( $stored['saved_at'] ) ? (int) $stored['saved_at'] : 0;
		return $clean;
	}

	/** The effective policy version (>=1). */
	public function policy_version(): int {
		return max( 1, (int) $this->settings()['policy_version'] );
	}

	/**
	 * The consent records, shape-validated on read. A malformed entry is dropped,
	 * never mutated in place. Oldest first (chronological).
	 *
	 * @return array<int, array{ at:int, id:string, cats:string[], region:string, ver:int, method:string }>
	 */
	public function log_entries(): array {
		$stored = $this->store->get( self::LOG_KEY, array() );
		if ( ! is_array( $stored ) ) {
			return array();
		}
		$out = array();
		foreach ( $stored as $entry ) {
			$valid = self::sanitize_record_shape( $entry );
			if ( null !== $valid ) {
				$out[] = $valid;
			}
		}
		return $out;
	}

	/**
	 * The effective tracker signatures with the admin's per-vendor category overrides
	 * applied. Extensible: an override retags a known vendor into another category.
	 *
	 * @param array<string,mixed> $settings
	 * @return array<string, array>
	 */
	public function effective_signatures( array $settings ): array {
		$sigs      = IWSL_Consent_Classifier::signatures();
		$overrides = isset( $settings['vendor_overrides'] ) && is_array( $settings['vendor_overrides'] )
			? $settings['vendor_overrides'] : array();
		foreach ( $overrides as $vendor => $category ) {
			if ( isset( $sigs[ $vendor ] ) && in_array( $category, IWSL_Consent_Classifier::CATEGORIES, true ) ) {
				$sigs[ $vendor ]['category'] = $category;
			}
		}
		return $sigs;
	}

	// ── one-click automation (the wizard surface) ────────────────────────────────

	/**
	 * Whether the admin has ever saved (or auto-applied) consent settings. False on
	 * a fresh install — the wizard uses this to offer the one-click setup.
	 */
	public function is_configured(): bool {
		return 0 < (int) $this->settings()['saved_at'];
	}

	/**
	 * The complete GDPR-safe recommended settings map (classifier defaults plus the
	 * site's own privacy-policy URL when WordPress knows one). Pure read — nothing
	 * is persisted; the wizard renders this as "what one click will apply". The map
	 * still passes the full save-time gauntlet in apply_recommended_defaults().
	 *
	 * @return array<string,mixed>
	 */
	public function recommended_defaults(): array {
		$defaults = IWSL_Consent_Classifier::recommended_defaults();
		$policy   = function_exists( 'get_privacy_policy_url' ) ? (string) get_privacy_policy_url() : '';
		if ( '' !== $policy ) {
			$defaults['policy_url'] = $policy; // re-validated by the sanitizer on save.
		}
		return $defaults;
	}

	/**
	 * ONE CLICK: persist the recommended defaults (optionally overridden field-by-
	 * field, e.g. a brand accent) through the normal gated save path — STATEMENT 1
	 * of save_settings() is the authoritative entitlement gate, so a locked site
	 * stores nothing. After this the banner + prior-blocking are live for visitors.
	 *
	 * @param array<string,mixed> $overrides sparse map merged over the defaults.
	 * @return array{ ok:bool, reason?:string, settings?:array, gate?:array }
	 */
	public function apply_recommended_defaults( array $overrides = array() ): array {
		// First-time setup starts from the GDPR-safe recommended baseline; a RE-RUN on
		// an ALREADY-configured site starts from the site's CURRENT settings, so the
		// wizard's sparse overrides (accent / layout / policy URL / title / message)
		// change only those fields and never silently reset the operator's category
		// toggles, per-vendor overrides, legal model, or GPC/DNT choices made in the
		// full settings form below the wizard.
		$base = $this->is_configured() ? $this->settings() : $this->recommended_defaults();
		return $this->save_settings( array_merge( $base, $overrides ) );
	}

	/**
	 * Auto-detect known third-party trackers in a page's HTML (vendor => label,
	 * category, count), honoring the admin's per-vendor overrides. Pure analysis —
	 * nothing is rewritten or stored; the wizard uses it to show "found on your
	 * site" evidence. Self-contained: the caller supplies the HTML (no network).
	 *
	 * @return array<string, array{ label:string, category:string, count:int }>
	 */
	public function detect_trackers( string $html ): array {
		return IWSL_Consent_Classifier::detect_vendors( $html, $this->effective_signatures( $this->settings() ) );
	}

	/**
	 * The front-end URL a logged-in administrator opens to preview the live banner
	 * (their own prior consent cookie is ignored for display, nothing else changes).
	 */
	public function preview_url(): string {
		$base = function_exists( 'home_url' ) ? (string) home_url( '/' ) : '/';
		return $base . ( false === strpos( $base, '?' ) ? '?' : '&' ) . self::PREVIEW_PARAM . '=1';
	}

	// ── mutators (STATEMENT 1 is the authoritative gate) ─────────────────────────

	/**
	 * Persist a new settings map. STATEMENT 1 is the authoritative entitlement gate —
	 * nothing below it runs for a locked site. The whole input runs through the
	 * sanitizer (a fresh immutable map) before storage.
	 *
	 * @param array<string,mixed> $input Raw form input (unslashed by the caller).
	 * @return array{ ok:bool, reason?:string, settings?:array, gate?:array }
	 */
	public function save_settings( array $input ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}
		$clean             = $this->sanitize_settings( $input );
		$clean['saved_at'] = $this->now_seconds();
		$this->store->set( self::SETTINGS_KEY, $clean );
		// The banner (or its absence) is baked into the front-end HTML a page cache
		// may be serving. Flush it so enabling/disabling/reconfiguring the banner
		// (including the one-click apply_recommended_defaults() path, which calls
		// this method directly) never leaves a stale banner behind. IWSL_Teardown
		// is a peer engine; guarded so this class has no hard dependency on it.
		if ( class_exists( 'IWSL_Teardown' ) ) {
			IWSL_Teardown::flush_page_cache();
		}
		return array( 'ok' => true, 'settings' => $clean );
	}

	/**
	 * Append one privacy-safe consent record. STATEMENT 1 is the gate. The raw IP is
	 * hashed with the per-site salt into a pseudonymous id and NEVER stored; the ring
	 * is FIFO-trimmed to MAX_LOG_ENTRIES. Immutable: a fresh list is built and stored.
	 *
	 * @param string[] $categories granted category names.
	 * @return array{ ok:bool, reason?:string, entries_count?:int, record?:array, gate?:array }
	 */
	public function record_consent( array $categories, string $region, string $method, string $ip = '', string $ua = '' ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}
		$anon  = IWSL_Consent_Classifier::anonymize( $ip, $ua, $this->salt() );
		$entry = IWSL_Consent_Classifier::build_record(
			$this->now_seconds(),
			$anon,
			$categories,
			$region,
			$this->policy_version(),
			$method
		);

		$next = array_merge( $this->log_entries(), array( $entry ) );
		if ( count( $next ) > self::MAX_LOG_ENTRIES ) {
			$next = array_slice( $next, -self::MAX_LOG_ENTRIES );
		}
		$this->store->set( self::LOG_KEY, $next );

		return array( 'ok' => true, 'entries_count' => count( $next ), 'record' => $entry );
	}

	/**
	 * Empty the consent log. STATEMENT 1 is the gate — a locked site cannot clear (or
	 * touch) the store, so the log survives a bypassed admin layer.
	 *
	 * @return array{ ok:bool, reason?:string, cleared?:bool, gate?:array }
	 */
	public function clear_log(): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}
		$this->store->set( self::LOG_KEY, array() );
		return array( 'ok' => true, 'cleared' => true );
	}

	/**
	 * Teardown: permanently remove this feature's footprint — delete the sanitized
	 * settings, the consent-record log and the anonymization salt (the three
	 * option keys this engine owns). NOT gated by the entitlement: a full teardown
	 * must succeed even after `cookie_consent` has already been revoked (that is
	 * precisely when a teardown is invoked). Idempotent + cheap: deleting an
	 * already-absent option key is a no-op.
	 *
	 * @return array{ ok:bool, options_removed:string[] }
	 */
	public function purge(): array {
		$options = array( self::SETTINGS_KEY, self::LOG_KEY, self::SALT_KEY );
		foreach ( $options as $key ) {
			$this->store->delete( $key );
		}
		return array(
			'ok'              => true,
			'options_removed' => $options,
		);
	}

	/**
	 * Record the visitor's consent from the first-party cookie, server-side, on a
	 * front-end render — so proof-of-consent needs NO public endpoint. Deduped: a
	 * fresh page load whose cookie matches the most recent record for the same
	 * pseudonymous id + policy version + categories is not re-logged. No-op when the
	 * cookie is absent or malformed.
	 */
	public function maybe_record_consent(): void {
		$raw = $this->read_cookie( self::COOKIE_NAME );
		if ( '' === $raw ) {
			return;
		}
		$payload = json_decode( $raw, true );
		if ( ! is_array( $payload ) ) {
			return;
		}
		$version = isset( $payload['v'] ) ? (int) $payload['v'] : 0;
		if ( $version < 1 || $version !== $this->policy_version() ) {
			return; // stale-policy cookie — the banner will re-prompt.
		}
		$categories = isset( $payload['c'] ) && is_array( $payload['c'] )
			? array_values( array_intersect( IWSL_Consent_Classifier::CATEGORIES, array_map( 'strval', $payload['c'] ) ) )
			: array( 'necessary' );
		$method = isset( $payload['m'] ) && is_string( $payload['m'] ) ? $payload['m'] : 'custom';

		$ip     = isset( $this->server['REMOTE_ADDR'] ) ? (string) $this->server['REMOTE_ADDR'] : '';
		$ua     = isset( $this->server['HTTP_USER_AGENT'] ) ? (string) $this->server['HTTP_USER_AGENT'] : '';
		$region = IWSL_Consent_Classifier::derive_region( $this->server );
		$anon   = IWSL_Consent_Classifier::anonymize( $ip, $ua, $this->salt() );

		if ( $this->already_logged( $anon, $version, $categories ) ) {
			return;
		}
		$this->record_consent( $categories, $region, $method, $ip, $ua );
	}

	// ── the save-time validation gauntlet ────────────────────────────────────────

	/**
	 * Normalize a raw input map into the stored settings shape. Immutable: builds a
	 * fresh array; never mutates $input.
	 *
	 * @param array<string,mixed> $input
	 * @return array<string,mixed>
	 */
	public function sanitize_settings( array $input ): array {
		$layout = isset( $input['banner_layout'] ) && in_array( $input['banner_layout'], array( 'box', 'center' ), true ) ? (string) $input['banner_layout'] : 'bar';
		$model  = isset( $input['default_model'] ) && IWSL_Consent_Classifier::valid_model( (string) $input['default_model'] )
			? (string) $input['default_model'] : IWSL_Consent_Classifier::MODEL_OPT_IN;

		return array(
			'enabled'          => ! empty( $input['enabled'] ),
			'banner_layout'    => $layout,
			'default_model'    => $model,
			'consent_mode'     => ! empty( $input['consent_mode'] ),
			'respect_gpc'      => ! empty( $input['respect_gpc'] ),
			'respect_dnt'      => ! empty( $input['respect_dnt'] ),
			'policy_version'   => max( 1, isset( $input['policy_version'] ) ? (int) $input['policy_version'] : 1 ),
			'title'            => self::clean_text( self::pluck( $input, 'title' ), self::MAX_TITLE_LEN ),
			'message'          => self::clean_multiline( self::pluck( $input, 'message' ), self::MAX_MESSAGE_LEN ),
			'policy_url'       => self::clean_url( self::pluck( $input, 'policy_url' ) ),
			'accent'           => self::clean_color( self::pluck( $input, 'accent' ) ),
			'categories'       => self::clean_categories( isset( $input['categories'] ) ? $input['categories'] : null ),
			'vendor_overrides' => self::clean_overrides( isset( $input['vendor_overrides'] ) ? $input['vendor_overrides'] : null ),
			'saved_at'         => 0,
		);
	}

	/** Read a string field defensively from a mixed input map. */
	private static function pluck( array $input, string $key ): string {
		return isset( $input[ $key ] ) && is_string( $input[ $key ] ) ? $input[ $key ] : '';
	}

	/** Which optional categories the site declares it uses (necessary is always on). @return array<string,bool> */
	private static function clean_categories( $value ): array {
		$out = array( 'necessary' => true, 'preferences' => true, 'statistics' => true, 'marketing' => true );
		if ( is_array( $value ) ) {
			foreach ( array( 'preferences', 'statistics', 'marketing' ) as $cat ) {
				$out[ $cat ] = ! empty( $value[ $cat ] );
			}
		}
		return $out;
	}

	/** Per-vendor category overrides, keys/values validated to the known sets. @return array<string,string> */
	private static function clean_overrides( $value ): array {
		$out = array();
		if ( ! is_array( $value ) ) {
			return $out;
		}
		$vendors = IWSL_Consent_Classifier::signatures();
		foreach ( $value as $vendor => $category ) {
			if ( is_string( $vendor ) && isset( $vendors[ $vendor ] )
				&& is_string( $category ) && in_array( $category, IWSL_Consent_Classifier::CATEGORIES, true ) ) {
				$out[ $vendor ] = $category;
			}
		}
		return $out;
	}

	/** A validated 6-hex accent color, or the default. */
	private static function clean_color( string $value ): string {
		$value = trim( $value );
		return 1 === preg_match( '/^#[0-9a-fA-F]{6}$/', $value ) ? strtolower( $value ) : '#2a6df0';
	}

	/**
	 * A readable button-text color (`#fff` or `#111`) for a 6-hex background, chosen
	 * by WCAG relative luminance so a pale admin-picked accent never leaves white
	 * text on a light fill (an invisible primary button). Pure — no WP dependency.
	 */
	private static function readable_foreground( string $hex ): string {
		$hex = ltrim( trim( $hex ), '#' );
		if ( 6 !== strlen( $hex ) || 1 !== preg_match( '/^[0-9a-fA-F]{6}$/', $hex ) ) {
			return '#fff';
		}
		$linear = static function ( int $c ): float {
			$s = $c / 255;
			return $s <= 0.03928 ? $s / 12.92 : pow( ( $s + 0.055 ) / 1.055, 2.4 );
		};
		$r = $linear( (int) hexdec( substr( $hex, 0, 2 ) ) );
		$g = $linear( (int) hexdec( substr( $hex, 2, 2 ) ) );
		$b = $linear( (int) hexdec( substr( $hex, 4, 2 ) ) );
		$luminance = 0.2126 * $r + 0.7152 * $g + 0.0722 * $b;
		return $luminance > 0.5 ? '#111' : '#fff';
	}

	/**
	 * Validate a policy-URL: empty, a rooted internal path (`/…`, no scheme, no `//`),
	 * or a strict absolute http(s) URL. Anything else → '' (no link rendered).
	 */
	private static function clean_url( string $url ): string {
		$url = trim( $url );
		if ( '' === $url || strlen( $url ) > self::MAX_URL_LEN ) {
			return '';
		}
		if ( false !== strpos( $url, '\\' ) || preg_match( '/[\x00-\x1F\x7F\s]/', $url ) ) {
			return '';
		}
		if ( 0 === strpos( $url, '//' ) ) {
			return '';
		}
		if ( '/' === $url[0] ) {
			return false === strpos( $url, '://' ) ? $url : '';
		}
		$parts  = function_exists( 'wp_parse_url' ) ? wp_parse_url( $url ) : parse_url( $url );
		$scheme = is_array( $parts ) && isset( $parts['scheme'] ) ? strtolower( (string) $parts['scheme'] ) : '';
		if ( ! is_array( $parts ) || ( 'http' !== $scheme && 'https' !== $scheme ) || empty( $parts['host'] ) ) {
			return '';
		}
		if ( isset( $parts['user'] ) || isset( $parts['pass'] ) ) {
			return '';
		}
		if ( function_exists( 'esc_url_raw' ) ) {
			$e = esc_url_raw( $url, array( 'http', 'https' ) );
			return $e === $url ? $url : '';
		}
		return $url;
	}

	/** Strip control chars (incl. CR/LF), trim, hard-truncate. */
	private static function clean_text( string $value, int $max ): string {
		$stripped = preg_replace( '/[\x00-\x1F\x7F]/', '', $value );
		$stripped = null === $stripped ? '' : trim( $stripped );
		return strlen( $stripped ) > $max ? substr( $stripped, 0, $max ) : $stripped;
	}

	/** Strip control chars EXCEPT newline, trim, hard-truncate (message keeps breaks). */
	private static function clean_multiline( string $value, int $max ): string {
		$stripped = preg_replace( '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', '', $value );
		$stripped = null === $stripped ? '' : trim( $stripped );
		return strlen( $stripped ) > $max ? substr( $stripped, 0, $max ) : $stripped;
	}

	/** Re-validate one stored record's shape, returning a fresh normalized copy or null. */
	private static function sanitize_record_shape( $entry ): ?array {
		if ( ! is_array( $entry ) || ! isset( $entry['id'] ) || ! is_string( $entry['id'] ) ) {
			return null;
		}
		$cats = isset( $entry['cats'] ) && is_array( $entry['cats'] )
			? array_values( array_intersect( IWSL_Consent_Classifier::CATEGORIES, array_map( 'strval', $entry['cats'] ) ) )
			: array();
		return array(
			'at'     => isset( $entry['at'] ) ? (int) $entry['at'] : 0,
			'id'     => $entry['id'],
			'cats'   => $cats,
			'region' => isset( $entry['region'] ) && is_string( $entry['region'] ) ? $entry['region'] : 'ZZ',
			'ver'    => isset( $entry['ver'] ) ? max( 1, (int) $entry['ver'] ) : 1,
			'method' => isset( $entry['method'] ) && is_string( $entry['method'] ) ? $entry['method'] : 'custom',
		);
	}

	// ── inline runtime builders (self-contained; strict-CSP-safe) ────────────────

	/** The Google Consent Mode v2 default (denied-by-default) <script>, emitted early. */
	private function consent_mode_default_script(): string {
		$signal = IWSL_Consent_Classifier::consent_default_signal();
		$json   = self::json( $signal );
		return "<script>window.dataLayer=window.dataLayer||[];"
			. "function gtag(){dataLayer.push(arguments);}"
			. "gtag('consent','default'," . $json . ");</script>";
	}

	/**
	 * The JSON config the runtime reads (by id) — no inline eval, CSP-safe. Carries
	 * the cookie name, policy version, model, shown categories, default grants and
	 * the respect flags.
	 *
	 * @param array<string,mixed> $settings
	 * @param array<string,bool>  $defaults
	 */
	private function config_script( array $settings, string $model, array $defaults ): string {
		$cats = array();
		foreach ( array( 'preferences', 'statistics', 'marketing' ) as $cat ) {
			if ( ! empty( $settings['categories'][ $cat ] ) ) {
				$cats[] = $cat;
			}
		}
		$config = array(
			'cookie'      => self::COOKIE_NAME,
			'version'     => $this->policy_version(),
			'model'       => $model,
			'categories'  => $cats,
			'defaults'    => $defaults,
			'consentMode' => ! empty( $settings['consent_mode'] ),
			'respectGpc'  => ! empty( $settings['respect_gpc'] ),
			'respectDnt'  => ! empty( $settings['respect_dnt'] ),
			'preview'     => $this->is_preview(),
		);
		return '<script type="application/json" id="iwsl-consent-config">' . self::json( $config ) . '</script>';
	}

	/**
	 * The accessible, theme-aware banner + preferences modal + floating re-open handle,
	 * fully inline (no external asset). Every dynamic fragment is escaped; the accent
	 * is a validated hex; Accept-all / Reject-all / Manage are equal-prominence.
	 *
	 * @param array<string,mixed> $settings
	 */
	private function banner_html( array $settings, string $model ): string {
		$accent  = self::clean_color( (string) $settings['accent'] );
		$layout  = in_array( $settings['banner_layout'], array( 'box', 'center' ), true ) ? (string) $settings['banner_layout'] : 'bar';
		$title   = '' !== (string) $settings['title'] ? (string) $settings['title'] : 'We value your privacy';
		$message = '' !== (string) $settings['message'] ? (string) $settings['message']
			: 'We use cookies to enhance your experience, analyze traffic and for marketing. Choose which categories to allow. Necessary cookies are always on.';
		$policy  = (string) $settings['policy_url'];

		$cat_labels = array(
			'necessary'   => array( 'Necessary', 'Required for the site to function. Always active.' ),
			'preferences' => array( 'Preferences', 'Remember your choices and functional embeds (maps, fonts, chat).' ),
			'statistics'  => array( 'Statistics', 'Anonymous analytics that help us understand how the site is used.' ),
			'marketing'   => array( 'Marketing', 'Ads and cross-site tracking (pixels, remarketing).' ),
		);

		$h  = '<div id="iwsl-cc" class="iwsl-cc iwsl-cc-' . self::esc_attr_safe( $layout ) . '" data-model="' . self::esc_attr_safe( $model ) . '" hidden>';
		$h .= '<style>' . $this->banner_css( $accent ) . '</style>';

		// Full-viewport blurred scrim — only visible in the centered-popup layout while
		// the banner is open (toggled by the runtime's iwsl-cc-open class on the root).
		$h .= '<div class="iwsl-cc-scrim" aria-hidden="true"></div>';

		// Banner.
		$h .= '<div class="iwsl-cc-banner" role="dialog" aria-modal="false" aria-live="polite" aria-labelledby="iwsl-cc-title" aria-describedby="iwsl-cc-desc">';
		$h .= '<button type="button" class="iwsl-cc-x iwsl-cc-banner-x" data-iwsl-action="dismiss" aria-label="Close">&times;</button>';
		$h .= '<div class="iwsl-cc-copy">';
		$h .= '<h2 id="iwsl-cc-title">' . self::esc_html_safe( $title ) . '</h2>';
		$h .= '<p id="iwsl-cc-desc">' . nl2br( self::esc_html_safe( $message ) );
		if ( '' !== $policy ) {
			$h .= ' <a class="iwsl-cc-policy" href="' . self::esc_url_safe( $policy ) . '">Privacy &amp; Cookie Policy</a>';
		}
		$h .= '</p></div>';
		$h .= '<div class="iwsl-cc-actions">';
		$h .= '<button type="button" class="iwsl-cc-btn iwsl-cc-manage" data-iwsl-action="manage">Manage preferences</button>';
		$h .= '<button type="button" class="iwsl-cc-btn iwsl-cc-reject" data-iwsl-action="reject">Reject all</button>';
		$h .= '<button type="button" class="iwsl-cc-btn iwsl-cc-accept" data-iwsl-action="accept">Accept all</button>';
		$h .= '</div></div>';

		// Preferences modal.
		$h .= '<div class="iwsl-cc-modal" role="dialog" aria-modal="true" aria-labelledby="iwsl-cc-modal-title" hidden>';
		$h .= '<div class="iwsl-cc-modal-card">';
		$h .= '<button type="button" class="iwsl-cc-x iwsl-cc-modal-close" data-iwsl-action="close-modal" aria-label="Close preferences">&times;</button>';
		$h .= '<h2 id="iwsl-cc-modal-title">Manage cookie preferences</h2>';
		$h .= '<div class="iwsl-cc-cats">';
		foreach ( $cat_labels as $key => $meta ) {
			$is_nec = 'necessary' === $key;
			if ( ! $is_nec && empty( $settings['categories'][ $key ] ) ) {
				continue; // category not used by this site.
			}
			$h .= '<div class="iwsl-cc-cat">';
			$h .= '<label class="iwsl-cc-cat-head"><span class="iwsl-cc-cat-name">' . self::esc_html_safe( $meta[0] ) . '</span>';
			$h .= '<input type="checkbox" class="iwsl-cc-toggle" data-cat="' . self::esc_attr_safe( $key ) . '"'
				. ( $is_nec ? ' checked disabled' : '' ) . '></label>';
			$h .= '<p class="iwsl-cc-cat-desc">' . self::esc_html_safe( $meta[1] ) . '</p>';
			$h .= '</div>';
		}
		$h .= '</div>';
		$h .= '<div class="iwsl-cc-modal-actions">';
		$h .= '<button type="button" class="iwsl-cc-btn iwsl-cc-reject" data-iwsl-action="reject">Reject all</button>';
		$h .= '<button type="button" class="iwsl-cc-btn iwsl-cc-save" data-iwsl-action="save">Save preferences</button>';
		$h .= '<button type="button" class="iwsl-cc-btn iwsl-cc-accept" data-iwsl-action="accept">Accept all</button>';
		$h .= '</div></div></div>';

		// Floating re-open handle.
		$h .= '<button type="button" class="iwsl-cc-handle" data-iwsl-action="reopen" aria-label="Cookie settings" title="Cookie settings" hidden>🍪</button>';

		$h .= '</div>';
		return $h;
	}

	/** The banner CSS with the validated accent injected as a custom property. */
	private function banner_css( string $accent ): string {
		$fg = self::readable_foreground( $accent );
		return ':root{--iwsl-cc-accent:' . $accent . '}'
			. '.iwsl-cc,.iwsl-cc *{box-sizing:border-box}'
			. '.iwsl-cc{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5}'
			. '.iwsl-cc[hidden],.iwsl-cc-modal[hidden],.iwsl-cc-handle[hidden]{display:none}'
			. '.iwsl-cc-banner{position:fixed;z-index:2147483000;left:0;right:0;bottom:0;display:flex;gap:18px;align-items:center;'
			. 'justify-content:space-between;flex-wrap:wrap;padding:18px 22px;background:#0b0f14;color:#e7edf3;'
			. 'border-top:1px solid rgba(255,255,255,.10);box-shadow:0 -12px 40px -18px rgba(0,0,0,.7)}'
			. '.iwsl-cc-box .iwsl-cc-banner{left:auto;right:20px;bottom:20px;max-width:420px;flex-direction:column;align-items:flex-start;'
			. 'border:1px solid rgba(255,255,255,.10);border-radius:16px}'
			. '.iwsl-cc-copy{flex:1 1 320px;min-width:260px}'
			. '.iwsl-cc h2{margin:0 0 6px;font-size:17px;font-weight:700;color:#fff}'
			. '.iwsl-cc p{margin:0;font-size:13.5px;color:#a9b6c4}'
			. '.iwsl-cc-policy{color:var(--iwsl-cc-accent);text-decoration:underline}'
			. '.iwsl-cc-actions{display:flex;gap:10px;flex-wrap:wrap}'
			. '.iwsl-cc-btn{cursor:pointer;font-size:13.5px;font-weight:650;padding:10px 16px;border-radius:10px;border:1px solid transparent;'
			. 'background:rgba(255,255,255,.08);color:#e7edf3}'
			. '.iwsl-cc-btn:hover{background:rgba(255,255,255,.14)}'
			. '.iwsl-cc-btn:focus-visible{outline:2px solid var(--iwsl-cc-accent);outline-offset:2px}'
			// Accept AND Reject share one filled-accent treatment: equal size, weight and
			// prominence (GDPR/consent — neither choice is nudged). Foreground is picked
			// by luminance so the label stays readable even on a pale accent.
			. '.iwsl-cc-accept,.iwsl-cc-reject{background:var(--iwsl-cc-accent);color:' . $fg . ';border-color:var(--iwsl-cc-accent)}'
			. '.iwsl-cc-manage{background:transparent;border-color:rgba(255,255,255,.22)}'
			. '.iwsl-cc-modal{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;'
			. 'padding:20px;background:rgba(4,7,11,.66)}'
			. '.iwsl-cc-modal-card{width:100%;max-width:560px;max-height:86vh;overflow:auto;background:#12171f;color:#e7edf3;'
			. 'border:1px solid rgba(255,255,255,.10);border-radius:18px;padding:26px}'
			. '.iwsl-cc-cats{margin:16px 0;display:flex;flex-direction:column;gap:12px}'
			. '.iwsl-cc-cat{border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px 16px}'
			. '.iwsl-cc-cat-head{display:flex;align-items:center;justify-content:space-between;font-weight:650;color:#fff}'
			. '.iwsl-cc-cat-desc{margin:6px 0 0;font-size:12.5px}'
			. '.iwsl-cc-toggle{width:18px;height:18px;accent-color:var(--iwsl-cc-accent)}'
			. '.iwsl-cc-modal-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end}'
			. '.iwsl-cc-handle{position:fixed;z-index:2147483000;left:18px;bottom:18px;width:46px;height:46px;border-radius:50%;'
			. 'border:1px solid rgba(255,255,255,.14);background:#0b0f14;color:#fff;font-size:20px;cursor:pointer;'
			. 'box-shadow:0 10px 30px -10px rgba(0,0,0,.6)}'
			// Close/dismiss "×" on the banner and the preferences modal.
			. '.iwsl-cc-modal-card{position:relative}'
			. '.iwsl-cc-x{position:absolute;top:12px;right:12px;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;'
			. 'background:transparent;border:0;border-radius:8px;font-size:22px;line-height:1;cursor:pointer;color:#a9b6c4}'
			. '.iwsl-cc-x:hover{background:rgba(255,255,255,.10);color:#fff}'
			. '.iwsl-cc-x:focus-visible{outline:2px solid var(--iwsl-cc-accent);outline-offset:2px}'
			. '.iwsl-cc-banner{padding-right:46px}'
			// Centered popup layout: a full-viewport blurred scrim behind a centered card.
			. '.iwsl-cc-scrim{display:none}'
			. '.iwsl-cc-center .iwsl-cc-scrim{position:fixed;inset:0;z-index:2147482999;background:rgba(4,7,11,.55);'
			. 'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}'
			. '.iwsl-cc-center.iwsl-cc-open .iwsl-cc-scrim{display:block}'
			. '.iwsl-cc-center .iwsl-cc-banner{left:50%;right:auto;top:50%;bottom:auto;transform:translate(-50%,-50%);'
			. 'width:calc(100% - 40px);max-width:480px;flex-direction:column;align-items:flex-start;'
			. 'border:1px solid rgba(255,255,255,.12);border-radius:18px;box-shadow:0 30px 80px -20px rgba(0,0,0,.75)}'
			. '@media (prefers-reduced-motion:reduce){.iwsl-cc-center .iwsl-cc-scrim{backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}}'
			. '@media (prefers-color-scheme:light){.iwsl-cc-banner{background:#fff;color:#1b2431;border-top-color:rgba(0,0,0,.08)}'
			. '.iwsl-cc-x{color:#516072}.iwsl-cc-x:hover{background:rgba(0,0,0,.06);color:#0b0f14}'
			. '.iwsl-cc-center .iwsl-cc-scrim{background:rgba(0,0,0,.32)}.iwsl-cc-center .iwsl-cc-banner{border-color:rgba(0,0,0,.10)}'
			. '.iwsl-cc-box .iwsl-cc-banner{border-color:rgba(0,0,0,.10)}.iwsl-cc h2{color:#0b0f14}.iwsl-cc p{color:#516072}'
			. '.iwsl-cc-btn{background:rgba(0,0,0,.06);color:#1b2431}.iwsl-cc-btn:hover{background:rgba(0,0,0,.10)}'
			. '.iwsl-cc-modal-card{background:#fff;color:#1b2431}.iwsl-cc-cat{border-color:rgba(0,0,0,.08)}'
			. '.iwsl-cc-cat-head{color:#0b0f14}.iwsl-cc-handle{background:#fff;color:#1b2431;border-color:rgba(0,0,0,.12)}}';
	}

	/**
	 * The self-contained runtime: reads the JSON config, restores blocked scripts on
	 * consent (clone-and-replace so they execute), pushes Consent Mode updates,
	 * persists to a first-party cookie + localStorage, and drives an accessible
	 * banner/modal (focus trap, Esc, ARIA). No external asset, no eval.
	 */
	private function runtime_script(): string {
		// A single static IIFE — no server data is interpolated (config comes from the
		// JSON <script>), so it needs no escaping and is safe under a strict CSP.
		return '<script>(function(){'
			. 'var cfgEl=document.getElementById("iwsl-consent-config");if(!cfgEl)return;'
			. 'var CFG;try{CFG=JSON.parse(cfgEl.textContent||"{}");}catch(e){return;}'
			. 'var root=document.getElementById("iwsl-cc");if(!root)return;'
			. 'var banner=root.querySelector(".iwsl-cc-banner"),modal=root.querySelector(".iwsl-cc-modal"),handle=root.querySelector(".iwsl-cc-handle");'
			. 'var ALL=["preferences","statistics","marketing"];'
			. 'function read(){try{var m=document.cookie.match(new RegExp("(?:^|; )"+CFG.cookie+"=([^;]*)"));if(m)return JSON.parse(decodeURIComponent(m[1]));}catch(e){}'
			. 'try{var ls=localStorage.getItem(CFG.cookie);if(ls)return JSON.parse(ls);}catch(e){}return null;}'
			. 'function write(cats,method){var v={v:CFG.version,c:cats,m:method,t:Math.floor(Date.now()/1000)};var s=JSON.stringify(v);'
			. 'try{document.cookie=CFG.cookie+"="+encodeURIComponent(s)+";path=/;max-age=15552000;samesite=Lax"+(location.protocol==="https:"?";secure":"");}catch(e){}'
			. 'try{localStorage.setItem(CFG.cookie,s);}catch(e){}}'
			. 'function granted(cats){var g={necessary:true};ALL.forEach(function(c){g[c]=cats.indexOf(c)>-1;});return g;}'
			. 'function unblock(cat){document.querySelectorAll(\'script[data-iwsl-consent="\'+cat+\'"]\').forEach(function(old){'
			. 'var s=document.createElement("script");for(var i=0;i<old.attributes.length;i++){var a=old.attributes[i];var n=a.name;'
			. 'if(n==="type"||n==="data-iwsl-consent"||n==="data-iwsl-blocked")continue;if(n==="data-iwsl-src"){s.setAttribute("src",a.value);continue;}'
			. 's.setAttribute(n,a.value);}if(!old.getAttribute("data-iwsl-src"))s.text=old.textContent;old.parentNode.replaceChild(s,old);});'
			. 'document.querySelectorAll(\'iframe[data-iwsl-consent="\'+cat+\'"]\').forEach(function(f){var src=f.getAttribute("data-iwsl-src");'
			. 'if(src){f.setAttribute("src",src);f.removeAttribute("data-iwsl-src");}});}'
			. 'function consentMode(g){if(!CFG.consentMode)return;window.dataLayer=window.dataLayer||[];function gt(){dataLayer.push(arguments);}'
			. 'gt("consent","update",{ad_storage:g.marketing?"granted":"denied",ad_user_data:g.marketing?"granted":"denied",'
			. 'ad_personalization:g.marketing?"granted":"denied",analytics_storage:g.statistics?"granted":"denied",'
			. 'functionality_storage:"granted",personalization_storage:g.preferences?"granted":"denied",security_storage:"granted"});}'
			. 'function apply(cats){var g=granted(cats);ALL.forEach(function(c){if(g[c])unblock(c);});consentMode(g);}'
			. 'function save(cats,method){apply(cats);write(cats,method);hide();if(handle)handle.hidden=false;}'
			. 'function show(){root.hidden=false;root.classList.add("iwsl-cc-open");if(banner)banner.style.display="";if(handle)handle.hidden=true;'
			. 'if(banner){var fa=banner.querySelector(".iwsl-cc-btn");if(fa){try{fa.focus();}catch(e){}}}}'
			. 'function hide(){root.classList.remove("iwsl-cc-open");if(modal)modal.hidden=true;if(banner)banner.style.display="none";}'
			. 'function openModal(){if(!modal)return;var st=read();var have=st&&st.c?st.c:defaults();'
			. 'modal.querySelectorAll(".iwsl-cc-toggle").forEach(function(t){var c=t.getAttribute("data-cat");if(c!=="necessary")t.checked=have.indexOf(c)>-1;});'
			. 'modal.hidden=false;root.hidden=false;var f=modal.querySelector(".iwsl-cc-toggle:not([disabled]),.iwsl-cc-btn");if(f)f.focus();}'
			. 'function chosen(){var out=["necessary"];if(!modal)return out;modal.querySelectorAll(".iwsl-cc-toggle").forEach(function(t){'
			. 'var c=t.getAttribute("data-cat");if(c!=="necessary"&&t.checked)out.push(c);});return out;}'
			. 'function defaults(){var d=CFG.defaults||{};var out=["necessary"];ALL.forEach(function(c){if(d[c])out.push(c);});'
			. 'if(CFG.respectGpc&&navigator.globalPrivacyControl){out=out.filter(function(c){return c!=="marketing";});}'
			. 'if(CFG.respectDnt&&(navigator.doNotTrack==="1"||window.doNotTrack==="1")){out=out.filter(function(c){return c==="necessary"||c==="preferences";});}return out;}'
			. 'root.addEventListener("click",function(e){var b=e.target.closest("[data-iwsl-action]");if(!b)return;var a=b.getAttribute("data-iwsl-action");'
			. 'if(a==="accept")save(["necessary"].concat(ALL),"accept_all");'
			. 'else if(a==="reject")save(["necessary"],"reject_all");'
			. 'else if(a==="save")save(chosen(),"custom");'
			. 'else if(a==="manage")openModal();'
			. 'else if(a==="close-modal"){if(modal)modal.hidden=true;var mb=banner&&banner.querySelector(".iwsl-cc-manage");if(mb)mb.focus();}'
			. 'else if(a==="dismiss"){hide();if(handle)handle.hidden=false;}'
			. 'else if(a==="reopen"){show();}});'
			. 'root.addEventListener("keydown",function(e){if(e.key==="Escape"){if(modal&&!modal.hidden){modal.hidden=true;var mb=banner&&banner.querySelector(".iwsl-cc-manage");if(mb)mb.focus();}else if(banner&&banner.style.display!=="none"){hide();if(handle)handle.hidden=false;}}'
			. 'if(e.key==="Tab"&&modal&&!modal.hidden){var f=modal.querySelectorAll("button,input:not([disabled]),a[href]");if(!f.length)return;'
			. 'var first=f[0],last=f[f.length-1];if(e.shiftKey&&document.activeElement===first){last.focus();e.preventDefault();}'
			. 'else if(!e.shiftKey&&document.activeElement===last){first.focus();e.preventDefault();}}});'
			. 'var st=read();if(!CFG.preview&&st&&st.v===CFG.version){apply(st.c||["necessary"]);root.hidden=false;if(banner)banner.style.display="none";if(handle)handle.hidden=false;}'
			. 'else if(CFG.model==="none"){save(["necessary"].concat(ALL),"implied");}'
			. 'else if(CFG.model==="opt-out"||CFG.model==="info"){apply(defaults());show();}'
			. 'else{apply(["necessary"]);show();}'
			. '})();</script>';
	}

	// ── injection helpers ────────────────────────────────────────────────────────

	/** Insert $snippet right after the opening <head …> tag; fallback prepend. */
	private static function inject_after_head( string $html, string $snippet ): string {
		if ( preg_match( '#<head\b[^>]*>#i', $html, $m, PREG_OFFSET_CAPTURE ) ) {
			$at = (int) $m[0][1] + strlen( $m[0][0] );
			return substr( $html, 0, $at ) . $snippet . substr( $html, $at );
		}
		return $snippet . $html;
	}

	/** Insert $snippet right before </body>; fallback append. */
	private static function inject_before_body_end( string $html, string $snippet ): string {
		$pos = stripos( $html, '</body>' );
		if ( false !== $pos ) {
			return substr( $html, 0, $pos ) . $snippet . substr( $html, $pos );
		}
		return $html . $snippet;
	}

	// ── consent-log helpers ──────────────────────────────────────────────────────

	/** Whether the most recent record for $anon already matches this version+categories. */
	private function already_logged( string $anon, int $version, array $categories ): bool {
		$log  = $this->log_entries();
		$want = array_values( array_intersect( IWSL_Consent_Classifier::CATEGORIES, $categories ) );
		for ( $i = count( $log ) - 1; $i >= 0; $i-- ) {
			if ( $log[ $i ]['id'] === IWSL_Consent_Classifier::build_record( 0, $anon, array(), 'ZZ', 1, 'custom' )['id'] ) {
				return (int) $log[ $i ]['ver'] === $version && $log[ $i ]['cats'] === $want;
			}
		}
		return false;
	}

	/** The per-site anonymization salt, generated once and stored. */
	private function salt(): string {
		$salt = $this->store->get( self::SALT_KEY );
		if ( is_string( $salt ) && '' !== $salt ) {
			return $salt;
		}
		$salt = self::random_salt();
		$this->store->set( self::SALT_KEY, $salt );
		return $salt;
	}

	/** A 32-hex random salt (cryptographic when available). */
	private static function random_salt(): string {
		if ( function_exists( 'random_bytes' ) ) {
			try {
				return bin2hex( random_bytes( 16 ) );
			} catch ( \Exception $e ) {
				// fall through to the deterministic fallback below.
			}
		}
		return substr( hash( 'sha256', uniqid( 'iwsl', true ) ), 0, 32 );
	}

	/** Read one request cookie by name from the injected server map's Cookie header. */
	private function read_cookie( string $name ): string {
		$header = isset( $this->server['HTTP_COOKIE'] ) && is_string( $this->server['HTTP_COOKIE'] )
			? $this->server['HTTP_COOKIE'] : '';
		if ( '' === $header ) {
			return '';
		}
		foreach ( explode( ';', $header ) as $pair ) {
			$eq = strpos( $pair, '=' );
			if ( false === $eq ) {
				continue;
			}
			if ( trim( substr( $pair, 0, $eq ) ) === $name ) {
				return urldecode( trim( substr( $pair, $eq + 1 ) ) );
			}
		}
		return '';
	}

	private function now_seconds(): int {
		return (int) floor( ( $this->now_ms )() / 1000 );
	}

	/**
	 * Whether THIS request is an administrator's banner preview
	 * (?iwsl_cc_preview=1). Read from the injected server map's query string so
	 * the engine stays pure/testable. Preview only changes what that admin's own
	 * browser renders — the gate and the enabled switch still apply in full.
	 */
	private function is_preview(): bool {
		$qs = isset( $this->server['QUERY_STRING'] ) && is_string( $this->server['QUERY_STRING'] )
			? $this->server['QUERY_STRING'] : '';
		if ( '' === $qs && isset( $this->server['REQUEST_URI'] ) && is_string( $this->server['REQUEST_URI'] ) ) {
			$qs = (string) parse_url( $this->server['REQUEST_URI'], PHP_URL_QUERY );
		}
		if ( '' === $qs ) {
			return false;
		}
		parse_str( $qs, $vars );
		return isset( $vars[ self::PREVIEW_PARAM ] ) && '1' === (string) $vars[ self::PREVIEW_PARAM ];
	}

	/**
	 * Whether this is an anonymous front-end HTML render (never admin/REST/cron/
	 * AJAX/login/feed/embed/trackback/robots/XML-RPC/JSON/XML/customizer). A
	 * logged-in user is excluded UNLESS an administrator is explicitly previewing
	 * the banner (?iwsl_cc_preview=1) — that was the owner's "I can't tell if it
	 * even works" gap: logged-in test views never showed the banner.
	 */
	private static function default_is_front(): callable {
		return static function (): bool {
			if ( function_exists( 'is_admin' ) && is_admin() ) {
				return false;
			}
			if ( function_exists( 'wp_doing_cron' ) && wp_doing_cron() ) {
				return false;
			}
			if ( function_exists( 'wp_doing_ajax' ) && wp_doing_ajax() ) {
				return false;
			}
			if ( defined( 'REST_REQUEST' ) && REST_REQUEST ) {
				return false;
			}
			if ( defined( 'XMLRPC_REQUEST' ) && XMLRPC_REQUEST ) {
				return false;
			}
			if ( isset( $GLOBALS['pagenow'] ) && 'wp-login.php' === $GLOBALS['pagenow'] ) {
				return false;
			}
			// Non-HTML front-end responses: injecting banner markup would corrupt them.
			if ( function_exists( 'is_feed' ) && is_feed() ) {
				return false;
			}
			if ( function_exists( 'is_embed' ) && is_embed() ) {
				return false;
			}
			if ( function_exists( 'is_trackback' ) && is_trackback() ) {
				return false;
			}
			if ( function_exists( 'is_robots' ) && is_robots() ) {
				return false;
			}
			if ( function_exists( 'wp_is_json_request' ) && wp_is_json_request() ) {
				return false;
			}
			if ( function_exists( 'wp_is_xml_request' ) && wp_is_xml_request() ) {
				return false;
			}
			if ( function_exists( 'is_customize_preview' ) && is_customize_preview() ) {
				return false;
			}
			// Logged-in users see the site untouched — consent UI targets the public.
			// Exception: an administrator explicitly previewing the banner.
			if ( function_exists( 'is_user_logged_in' ) && is_user_logged_in() ) {
				$wants_preview = isset( $_GET[ self::PREVIEW_PARAM ] ) && '1' === (string) $_GET[ self::PREVIEW_PARAM ]; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
				if ( ! ( $wants_preview && function_exists( 'current_user_can' ) && current_user_can( 'manage_options' ) ) ) {
					return false;
				}
			}
			return true;
		};
	}

	// ── admin-post handlers (LAYER 2: cap + nonce + gate, PRG) ───────────────────

	/**
	 * `admin_post_iwsl_cookie_consent_save`. Capability + nonce, re-check the gate,
	 * then save_settings() (whose first statement is the authoritative LAYER 3 gate).
	 * POST-redirect-GET back to the Plus page with a per-user result transient.
	 */
	public function handle_save(): void {
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'manage_options' ) ) {
			$this->deny();
			return;
		}
		if ( function_exists( 'check_admin_referer' ) ) {
			check_admin_referer( self::SAVE_NONCE );
		}

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->store_result( array( 'ok' => false, 'reason' => 'entitlement-locked' ) );
			$this->redirect_back();
			return;
		}

		$input = $this->read_post();
		$result = $this->save_settings( $input );
		$this->store_result( $result );
		$this->redirect_back();
	}

	/**
	 * `admin_post_iwsl_cookie_consent_clear_log`. Capability + nonce + gated clear(),
	 * a per-user result transient, and a PRG redirect back to the Plus page.
	 */
	public function handle_clear_log(): void {
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'manage_options' ) ) {
			$this->deny();
			return;
		}
		if ( function_exists( 'check_admin_referer' ) ) {
			check_admin_referer( self::CLEARLOG_NONCE );
		}
		$result = $this->clear_log();
		$this->store_result( $result );
		$this->redirect_back();
	}

	/** Read + sanitize the settings POST payload (unslashed). @return array<string,mixed> */
	private function read_post(): array {
		$text = static function ( string $key ): string {
			if ( ! isset( $_POST[ $key ] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Missing
				return '';
			}
			$raw = function_exists( 'wp_unslash' ) ? wp_unslash( $_POST[ $key ] ) : $_POST[ $key ]; // phpcs:ignore WordPress.Security.NonceVerification.Missing, WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
			return is_string( $raw ) ? $raw : '';
		};

		$categories = array();
		foreach ( array( 'preferences', 'statistics', 'marketing' ) as $cat ) {
			$categories[ $cat ] = isset( $_POST['iwsl_cc_cat'][ $cat ] ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		}

		$overrides = array();
		if ( isset( $_POST['iwsl_cc_vendor'] ) && is_array( $_POST['iwsl_cc_vendor'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Missing
			foreach ( $_POST['iwsl_cc_vendor'] as $vendor => $category ) { // phpcs:ignore WordPress.Security.NonceVerification.Missing, WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
				$v = is_string( $vendor ) ? preg_replace( '/[^a-z0-9_]/', '', strtolower( $vendor ) ) : '';
				$c = is_string( $category ) ? preg_replace( '/[^a-z]/', '', strtolower( $category ) ) : '';
				if ( '' !== $v && '' !== $c ) {
					$overrides[ $v ] = $c;
				}
			}
		}

		return array(
			'enabled'          => isset( $_POST['iwsl_cc_enabled'] ), // phpcs:ignore WordPress.Security.NonceVerification.Missing
			'banner_layout'    => in_array( $text( 'iwsl_cc_layout' ), array( 'box', 'center' ), true ) ? $text( 'iwsl_cc_layout' ) : 'bar',
			'default_model'    => $text( 'iwsl_cc_model' ),
			'consent_mode'     => isset( $_POST['iwsl_cc_consent_mode'] ), // phpcs:ignore WordPress.Security.NonceVerification.Missing
			'respect_gpc'      => isset( $_POST['iwsl_cc_gpc'] ), // phpcs:ignore WordPress.Security.NonceVerification.Missing
			'respect_dnt'      => isset( $_POST['iwsl_cc_dnt'] ), // phpcs:ignore WordPress.Security.NonceVerification.Missing
			'policy_version'   => (int) $text( 'iwsl_cc_version' ),
			'title'            => $text( 'iwsl_cc_title' ),
			'message'          => $text( 'iwsl_cc_message' ),
			'policy_url'       => $text( 'iwsl_cc_policy_url' ),
			'accent'           => $text( 'iwsl_cc_accent' ),
			'categories'       => $categories,
			'vendor_overrides' => $overrides,
		);
	}

	// ── render (LAYER 1: locked notice or the full settings UI) ──────────────────

	/**
	 * The admin section. Locked → a notice listing the gate reasons (no UI, no
	 * banner). Unlocked → the full settings form (status, region model, categories,
	 * appearance, Consent Mode, vendor-signature map), the blocked-vendor list and
	 * the consent-record log table. Every dynamic fragment is escaped.
	 */
	public function render_section(): void {
		if ( ! function_exists( 'esc_html' ) && ! function_exists( 'htmlspecialchars' ) ) {
			return;
		}
		$gate = $this->entitlements->evaluate( self::FEATURE );

		echo '<h2>' . self::esc_html_safe( 'Cookie Consent & Privacy Compliance' ) . '</h2>';
		echo '<p class="description" style="max-width:720px;">'
			. self::esc_html_safe( 'A self-contained, geo-aware consent platform: it blocks known third-party trackers before consent (GDPR prior-blocking), honors CCPA/GPC/DNT, emits Google Consent Mode v2, and keeps a privacy-safe consent log — all on-server, no external service.' )
			. '</p>';

		if ( empty( $gate['unlocked'] ) ) {
			$this->render_locked_notice( $gate );
			return;
		}

		$this->render_result_notice();
		$settings = $this->settings();
		$this->render_form( $settings );

		echo '<details class="iwsl-adv"><summary>' . self::esc_html_safe( 'Advanced settings' ) . '</summary><div class="iwsl-adv__body">';
		$this->render_signature_table( $settings );
		$this->render_log_table();
		echo '</div></details>';
	}

	/** The locked-state notice, listing each gate reason in friendly language. */
	private function render_locked_notice( array $gate ): void {
		$messages = array(
			'not-linked'      => 'This site is not linked to the InfraWeaver console. Enroll the connector first.',
			'heartbeat-stale' => 'The signed heartbeat is stale — the console has not verified a signed command recently.',
			'requires-plus'   => 'Cookie Consent requires the Ultimate plan — assign it from the console.',
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>'
			. self::esc_html_safe( '🔒 Cookie Consent is locked.' ) . '</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) ( $gate['reasons'] ?? array() ) as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . self::esc_html_safe( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	/** Render (then clear) the current user's PRG result transient. */
	private function render_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key    = self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		if ( ! empty( $result['ok'] ) ) {
			echo '<div class="notice notice-success" style="margin-top:12px;padding:12px;"><p>'
				. self::esc_html_safe( 'Consent settings saved.' ) . '</p></div>';
		} else {
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p>'
				. self::esc_html_safe( 'Could not save: ' . (string) ( $result['reason'] ?? 'unknown' ) ) . '</p></div>';
		}
	}

	/** The nonce-protected settings form. */
	private function render_form( array $s ): void {
		$action = function_exists( 'admin_url' ) ? admin_url( 'admin-post.php' ) : 'admin-post.php';
		echo '<form method="post" action="' . self::esc_url_safe( (string) $action ) . '" style="margin-top:16px;max-width:760px;">';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::SAVE_NONCE );
		}
		echo '<input type="hidden" name="action" value="' . self::esc_attr_safe( self::SAVE_ACTION ) . '">';
		echo '<table class="form-table" role="presentation"><tbody>';

		$this->row_checkbox( 'iwsl_cc_enabled', 'Status', 'Enable the consent banner + prior-blocking on the front end', ! empty( $s['enabled'] ), 'Turns the cookie notice on for visitors.' );

		echo '<tr><th scope="row">' . self::esc_html_safe( 'Default legal model' ) . ' ' . iwsl_field_help( 'How visitors are treated before choosing: ask first, or allow by default.' ) . '</th><td>';
		echo '<select name="iwsl_cc_model">';
		foreach ( array(
			IWSL_Consent_Classifier::MODEL_OPT_IN  => 'Opt-in (GDPR — block until consent)',
			IWSL_Consent_Classifier::MODEL_OPT_OUT => 'Opt-out (CCPA — on until rejected)',
			IWSL_Consent_Classifier::MODEL_INFO    => 'Info only (implied consent)',
			IWSL_Consent_Classifier::MODEL_NONE    => 'None (no banner)',
		) as $val => $label ) {
			echo '<option value="' . self::esc_attr_safe( $val ) . '"' . ( $s['default_model'] === $val ? ' selected' : '' ) . '>' . self::esc_html_safe( $label ) . '</option>';
		}
		echo '</select><p class="description">' . self::esc_html_safe( 'Applied to visitors outside the EU/EEA/UK (always opt-in) and the US (always opt-out).' ) . '</p></td></tr>';

		echo '<tr><th scope="row">' . self::esc_html_safe( 'Categories used' ) . ' ' . iwsl_field_help( 'Which kinds of cookies visitors can allow or refuse.' ) . '</th><td>';
		foreach ( array( 'preferences' => 'Preferences', 'statistics' => 'Statistics', 'marketing' => 'Marketing' ) as $cat => $label ) {
			echo '<label style="margin-right:16px;"><input type="checkbox" name="iwsl_cc_cat[' . self::esc_attr_safe( $cat ) . ']" value="1"'
				. ( ! empty( $s['categories'][ $cat ] ) ? ' checked' : '' ) . '> ' . self::esc_html_safe( $label ) . '</label>';
		}
		echo '<p class="description">' . self::esc_html_safe( 'Necessary cookies are always shown and cannot be rejected.' ) . '</p></td></tr>';

		$this->row_checkbox( 'iwsl_cc_consent_mode', 'Google Consent Mode v2', 'Emit gtag consent default/update signals', ! empty( $s['consent_mode'] ), 'Tells Google tools whether the visitor agreed to tracking.' );
		$this->row_checkbox( 'iwsl_cc_gpc', 'Global Privacy Control', 'Honor the Sec-GPC "do not sell/share" browser signal', ! empty( $s['respect_gpc'] ), 'Respects a browser’s built-in “do not sell my data” setting.' );
		$this->row_checkbox( 'iwsl_cc_dnt', 'Do Not Track', 'Honor the legacy DNT browser signal', ! empty( $s['respect_dnt'] ), 'Respects a browser’s older “do not track me” request.' );

		echo '<tr><th scope="row">' . self::esc_html_safe( 'Banner layout' ) . ' ' . iwsl_field_help( 'Full-width bar, a small corner box, or a centered popup that blurs the page.' ) . '</th><td>';
		$layouts = array(
			'bar'    => 'Bar (full width)',
			'box'    => 'Box (corner card)',
			'center' => 'Center popup (blur the page)',
		);
		echo '<select name="iwsl_cc_layout">';
		foreach ( $layouts as $val => $label ) {
			echo '<option value="' . self::esc_attr_safe( $val ) . '"' . ( (string) $s['banner_layout'] === $val ? ' selected' : '' ) . '>' . self::esc_html_safe( $label ) . '</option>';
		}
		echo '</select></td></tr>';

		$this->row_text( 'iwsl_cc_title', 'Banner title', (string) $s['title'], 'We value your privacy', 'The heading shown at the top of the cookie notice.' );
		echo '<tr><th scope="row"><label for="iwsl_cc_message">' . self::esc_html_safe( 'Banner message' ) . '</label> ' . iwsl_field_help( 'The message shown to visitors in the cookie notice.' ) . '</th><td>'
			. '<textarea id="iwsl_cc_message" name="iwsl_cc_message" class="large-text" rows="3">' . self::esc_textarea_safe( (string) $s['message'] ) . '</textarea></td></tr>';
		$this->row_text( 'iwsl_cc_policy_url', 'Privacy / cookie policy URL', (string) $s['policy_url'], '/privacy-policy', 'Link to your privacy page shown inside the notice.' );
		echo '<tr><th scope="row"><label for="iwsl_cc_accent">' . self::esc_html_safe( 'Accent color' ) . '</label> ' . iwsl_field_help( 'The button and highlight color of your cookie notice.' ) . '</th><td>'
			. '<input type="text" id="iwsl_cc_accent" name="iwsl_cc_accent" value="' . self::esc_attr_safe( (string) $s['accent'] ) . '" placeholder="#2a6df0" style="width:120px;"></td></tr>';
		echo '<tr><th scope="row"><label for="iwsl_cc_version">' . self::esc_html_safe( 'Policy version' ) . '</label> ' . iwsl_field_help( 'Raise this number to ask every visitor again after a policy change.' ) . '</th><td>'
			. '<input type="number" min="1" id="iwsl_cc_version" name="iwsl_cc_version" value="' . self::esc_attr_safe( (string) $s['policy_version'] ) . '" style="width:90px;">'
			. '<p class="description">' . self::esc_html_safe( 'Increment to re-prompt every visitor after a policy change.' ) . '</p></td></tr>';

		echo '</tbody></table>';
		echo '<p><button type="submit" class="button button-primary">' . self::esc_html_safe( 'Save consent settings' ) . '</button></p>';
		echo '</form>';
	}

	/** The read-only detected-tracker registry (what prior-blocking covers), with per-vendor category override selects (submitted with the main form is not possible — informational here). */
	private function render_signature_table( array $settings ): void {
		$sigs = $this->effective_signatures( $settings );
		echo '<h3 style="margin-top:26px;">' . self::esc_html_safe( 'Tracker signatures blocked before consent' ) . '</h3>';
		echo '<div style="overflow-x:auto;"><table class="widefat striped" style="max-width:760px;"><thead><tr>';
		echo '<th>' . self::esc_html_safe( 'Vendor' ) . '</th><th>' . self::esc_html_safe( 'Category' ) . '</th><th>' . self::esc_html_safe( 'Matched hosts' ) . '</th></tr></thead><tbody>';
		foreach ( $sigs as $sig ) {
			$hosts = isset( $sig['hosts'] ) && is_array( $sig['hosts'] ) ? implode( ', ', array_map( 'strval', $sig['hosts'] ) ) : '';
			echo '<tr><td>' . self::esc_html_safe( (string) ( $sig['label'] ?? '' ) ) . '</td>'
				. '<td>' . self::esc_html_safe( (string) ( $sig['category'] ?? '' ) ) . '</td>'
				. '<td><code>' . self::esc_html_safe( $hosts ) . '</code></td></tr>';
		}
		echo '</tbody></table></div>';
	}

	/** The consent-record log table + the gated "Clear log" button. */
	private function render_log_table(): void {
		$rows = array_slice( array_reverse( $this->log_entries() ), 0, self::MAX_DISPLAY );
		echo '<h3 style="margin-top:26px;">' . self::esc_html_safe( 'Consent records (proof of consent)' ) . '</h3>';
		if ( array() === $rows ) {
			echo '<p>' . self::esc_html_safe( 'No consent recorded yet.' ) . '</p>';
		} else {
			echo '<div style="overflow-x:auto;"><table class="widefat striped" style="max-width:760px;"><thead><tr>';
			echo '<th>' . self::esc_html_safe( 'When' ) . '</th><th>' . self::esc_html_safe( 'Visitor (hashed)' ) . '</th>'
				. '<th>' . self::esc_html_safe( 'Categories' ) . '</th><th>' . self::esc_html_safe( 'Region' ) . '</th>'
				. '<th>' . self::esc_html_safe( 'Policy' ) . '</th><th>' . self::esc_html_safe( 'Method' ) . '</th></tr></thead><tbody>';
			foreach ( $rows as $row ) {
				echo '<tr><td>' . self::esc_html_safe( self::format_time( (int) $row['at'] ) ) . '</td>'
					. '<td><code>' . self::esc_html_safe( substr( (string) $row['id'], 0, 12 ) ) . '…</code></td>'
					. '<td>' . self::esc_html_safe( implode( ', ', array_map( 'strval', $row['cats'] ) ) ) . '</td>'
					. '<td>' . self::esc_html_safe( (string) $row['region'] ) . '</td>'
					. '<td>v' . self::esc_html_safe( (string) $row['ver'] ) . '</td>'
					. '<td>' . self::esc_html_safe( (string) $row['method'] ) . '</td></tr>';
			}
			echo '</tbody></table></div>';
		}

		$action = function_exists( 'admin_url' ) ? admin_url( 'admin-post.php' ) : 'admin-post.php';
		echo '<form method="post" action="' . self::esc_url_safe( (string) $action ) . '" style="margin-top:10px;">';
		echo '<input type="hidden" name="action" value="' . self::esc_attr_safe( self::CLEARLOG_ACTION ) . '">';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::CLEARLOG_NONCE );
		}
		echo '<button type="submit" class="button button-secondary">' . self::esc_html_safe( 'Clear consent log' ) . '</button>';
		echo '</form>';
	}

	// ── small render helpers ─────────────────────────────────────────────────────

	private function row_checkbox( string $name, string $label, string $help, bool $checked, string $tip = '' ): void {
		echo '<tr><th scope="row">' . self::esc_html_safe( $label ) . ' ' . iwsl_field_help( $tip ) . '</th><td><label><input type="checkbox" name="' . self::esc_attr_safe( $name ) . '" value="1"'
			. ( $checked ? ' checked' : '' ) . '> ' . self::esc_html_safe( $help ) . '</label></td></tr>';
	}

	private function row_text( string $name, string $label, string $value, string $placeholder, string $tip = '' ): void {
		echo '<tr><th scope="row"><label for="' . self::esc_attr_safe( $name ) . '">' . self::esc_html_safe( $label ) . '</label> ' . iwsl_field_help( $tip ) . '</th><td>'
			. '<input type="text" id="' . self::esc_attr_safe( $name ) . '" name="' . self::esc_attr_safe( $name ) . '" class="regular-text" value="'
			. self::esc_attr_safe( $value ) . '" placeholder="' . self::esc_attr_safe( $placeholder ) . '"></td></tr>';
	}

	// ── PRG + escaping utilities ─────────────────────────────────────────────────

	private function store_result( array $result ): void {
		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id(), $result, self::RESULT_TTL );
		}
	}

	private function deny(): void {
		if ( function_exists( 'wp_die' ) ) {
			wp_die( self::esc_html_safe( 'You do not have permission to run this action.' ) );
		}
	}

	private function redirect_back(): void {
		$url = 'admin.php?page=' . self::PAGE_SLUG;
		if ( function_exists( 'admin_url' ) ) {
			$url = admin_url( $url );
		}
		if ( function_exists( 'wp_safe_redirect' ) ) {
			wp_safe_redirect( $url );
		}
		exit;
	}

	/** JSON encode safe for embedding inside a <script> element (no </script> breakout). */
	private static function json( $value ): string {
		if ( function_exists( 'wp_json_encode' ) ) {
			$out = wp_json_encode( $value, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT );
		} else {
			$out = json_encode( $value, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT );
		}
		return is_string( $out ) ? $out : '{}';
	}

	private static function format_time( int $unix ): string {
		if ( $unix <= 0 ) {
			return '—';
		}
		if ( function_exists( 'wp_date' ) ) {
			$f = wp_date( 'Y-m-d H:i', $unix );
			if ( is_string( $f ) && '' !== $f ) {
				return $f;
			}
		}
		return gmdate( 'Y-m-d H:i', $unix );
	}

	private static function esc_html_safe( string $value ): string {
		return function_exists( 'esc_html' ) ? esc_html( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	private static function esc_attr_safe( string $value ): string {
		return function_exists( 'esc_attr' ) ? esc_attr( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	private static function esc_url_safe( string $value ): string {
		return function_exists( 'esc_url' ) ? esc_url( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	private static function esc_textarea_safe( string $value ): string {
		return function_exists( 'esc_textarea' ) ? esc_textarea( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}
}
