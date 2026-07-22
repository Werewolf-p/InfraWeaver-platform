<?php
/**
 * Generic engine behind the gated "Lazy-Load Media" feature (flag `lazy_load`,
 * Pro tier). A passive output augmenter: it appends `loading="lazy"` +
 * `decoding="async"` to `<img>` tags — and, when enabled, `loading="lazy"` to
 * `<iframe>` tags — that the author did not already annotate, so below-the-fold
 * media defers until it scrolls into view. It ADDS attributes only, never
 * removes or reorders an existing one, and skips a tag the moment it already
 * carries a `loading` attribute (author intent wins).
 *
 * LCP PROTECTION. The first N images in a document are almost always the
 * largest-contentful-paint candidate; lazy-loading them REGRESSES LCP. So the
 * augmenter leaves the first `skip_images` `<img>` tags byte-identical (default
 * 1) and only defers the rest. Iframes are never LCP and are handled wholesale.
 *
 * TRUST MODEL. Console-authoritative, mirroring IWSL_Redirects / IWSL_Page_Cache:
 * the `lazy_load` flag is written ONLY by the dual-signed `entitlements.set`
 * runner (§7). No self-set path, REST route, AJAX endpoint, cron or nopriv
 * surface. The gate is re-checked at every layer — the admin page, the admin-post
 * settings handler (LAYER 2), and here as STATEMENT 1 of every hook callback and
 * every state-changing method. RESIDUAL RISK is the accepted `plus` model: a
 * direct-DB flip unlocks locally but re-locks within HEARTBEAT_FRESH_MS (2h)
 * because evaluate() requires state==active AND a fresh signed heartbeat.
 *
 * SAFETY. In-process only — no exec/shell_exec/proc_open, no network. String
 * transforms are append-only regex passes that never rewrite an existing
 * attribute, and any regex backtrack/error falls back to the untouched input.
 * WordPress calls are function_exists-guarded so the engine loads and its pure
 * transform runs under the zero-dependency test harness with an injected store.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Lazy_Load {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'lazy_load';

	/** IWSL_Store option key holding the settings array. */
	const OPTION_KEY = 'lazy_load';

	/** admin-post action + nonce for the settings save (wired by IWSL_Admin). */
	const SETTINGS_ACTION = 'iwsl_lazy_load_settings';
	const SETTINGS_NONCE  = 'iwsl_lazy_load_settings';

	/** Per-user PRG result transient prefix (append the user id). */
	const RESULT_PREFIX = 'iwsl_lazyload_result_';

	/** Default number of leading images left eager to protect LCP. */
	const DEFAULT_SKIP = 1;
	/** Upper bound on the skip-first-N control. */
	const MAX_SKIP = 20;

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store settings live here under OPTION_KEY. */
	private $store;

	/**
	 * @param IWSL_Entitlements $entitlements The gate.
	 * @param IWSL_Store|null   $store        Settings store; production injects IWSL_WP_Store.
	 */
	public function __construct( IWSL_Entitlements $entitlements, ?IWSL_Store $store = null ) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : new IWSL_WP_Store();
	}

	/** Wire the passive front-end filters. Guarded so the harness can call it harmlessly. */
	public function register(): void {
		if ( ! function_exists( 'add_filter' ) ) {
			return;
		}
		// Priority 20 — after most content filters have produced final markup.
		add_filter( 'the_content', array( $this, 'filter_the_content' ), 20 );
		add_filter( 'post_thumbnail_html', array( $this, 'filter_post_thumbnail_html' ), 20 );
	}

	// ── settings (reads safe on every render) ──────────────────────────────────

	/**
	 * The validated settings, defaulted for a fresh site. `enabled` defaults true
	 * so the feature works the moment the flag is granted.
	 *
	 * @return array{ enabled:bool, lazy_iframes:bool, skip_images:int }
	 */
	public function settings(): array {
		$raw = $this->store->get( self::OPTION_KEY, array() );
		if ( ! is_array( $raw ) ) {
			$raw = array();
		}
		return array(
			'enabled'      => array_key_exists( 'enabled', $raw ) ? (bool) $raw['enabled'] : true,
			'lazy_iframes' => array_key_exists( 'lazy_iframes', $raw ) ? (bool) $raw['lazy_iframes'] : true,
			'skip_images'  => self::clamp_skip( isset( $raw['skip_images'] ) ? (int) $raw['skip_images'] : self::DEFAULT_SKIP ),
		);
	}

	/**
	 * Persist settings from the admin-post payload. STATEMENT 1 is the authoritative
	 * entitlement gate — nothing below runs for a locked site. Every field is
	 * validated/clamped at the boundary; the stored array is a fresh immutable copy.
	 *
	 * @param array $input Raw request fields (enabled, lazy_iframes, skip_images).
	 * @return array{ ok:bool, reason?:string, settings?:array, gate?:array }
	 */
	public function update_settings( array $input ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		$settings = array(
			'enabled'      => ! empty( $input['enabled'] ),
			'lazy_iframes' => ! empty( $input['lazy_iframes'] ),
			'skip_images'  => self::clamp_skip( isset( $input['skip_images'] ) ? (int) $input['skip_images'] : self::DEFAULT_SKIP ),
		);
		$this->store->set( self::OPTION_KEY, $settings );
		if ( class_exists( 'IWSL_Teardown' ) ) {
			IWSL_Teardown::flush_page_cache(); // a settings change invalidates any cached HTML.
		}

		return array( 'ok' => true, 'settings' => $settings );
	}

	/**
	 * Teardown for an uninstall/unlink sweep: delete this feature's settings
	 * option key entirely, so a fresh read falls back to settings()' defaults
	 * (enabled, lazy_iframes on, skip 1) rather than a stale persisted map.
	 * Idempotent + cheap: deleting an absent key is a single no-op store call.
	 *
	 * @return array{ ok:bool, deleted:bool }
	 */
	public function purge(): array {
		$had = null !== $this->store->get( self::OPTION_KEY, null );
		$this->store->delete( self::OPTION_KEY );
		return array( 'ok' => true, 'deleted' => $had );
	}

	// ── the passive filters (STATEMENT 1 is the authoritative gate) ────────────

	/**
	 * `the_content` callback. STATEMENT 1 is the gate: a revoked flag returns the
	 * content untouched, restoring default WordPress behaviour even if the outer
	 * layers are ever bypassed. Then the master toggle, then the append-only pass.
	 *
	 * @param mixed $content Post HTML (WordPress guarantees a string in practice).
	 * @return mixed The (possibly augmented) content, same type as given.
	 */
	public function filter_the_content( $content ) {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $content;
		}
		if ( ! is_string( $content ) || '' === $content ) {
			return $content;
		}
		$settings = $this->settings();
		if ( empty( $settings['enabled'] ) ) {
			return $content;
		}
		return self::add_lazy_attributes( $content, ! empty( $settings['lazy_iframes'] ), (int) $settings['skip_images'] );
	}

	/**
	 * `post_thumbnail_html` callback. Same gate discipline. A featured image is a
	 * single independent tag, so the skip-first-N budget does not apply here; the
	 * augmenter still respects any author-set (or core-set) loading attribute, so
	 * on modern WordPress — which already annotates thumbnails — this is a no-op.
	 *
	 * @param mixed $html The rendered featured-image markup.
	 * @return mixed
	 */
	public function filter_post_thumbnail_html( $html ) {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return $html;
		}
		if ( ! is_string( $html ) || '' === $html ) {
			return $html;
		}
		$settings = $this->settings();
		if ( empty( $settings['enabled'] ) ) {
			return $html;
		}
		return self::add_lazy_attributes( $html, false, 0 );
	}

	// ── the pure transform (public static so tests hit it directly) ────────────

	/**
	 * Append lazy attributes to `<img>` (and optionally `<iframe>`) tags. Pure and
	 * side-effect free: it only ever APPENDS attributes to tags that lack a
	 * `loading` attribute, leaving the first `$skip_images` images eager (LCP),
	 * and never mutates an existing attribute. A regex error yields the input
	 * unchanged — output is never corrupted.
	 */
	public static function add_lazy_attributes( string $html, bool $lazy_iframes, int $skip_images ): string {
		if ( '' === $html ) {
			return $html;
		}
		$skip = $skip_images > 0 ? $skip_images : 0;
		$seen = 0;

		$out = preg_replace_callback(
			'#<img\b[^>]*>#i',
			static function ( array $m ) use ( &$seen, $skip ): string {
				$seen++;
				if ( $seen <= $skip ) {
					return $m[0]; // protect the first N images (LCP candidates).
				}
				return self::augment_tag( $m[0], true );
			},
			$html
		);
		if ( ! is_string( $out ) ) {
			$out = $html;
		}

		if ( $lazy_iframes ) {
			$iframes = preg_replace_callback(
				'#<iframe\b[^>]*>#i',
				static function ( array $m ): string {
					return self::augment_tag( $m[0], false );
				},
				$out
			);
			if ( is_string( $iframes ) ) {
				$out = $iframes;
			}
		}
		return $out;
	}

	/**
	 * Append lazy (and, for images, async decoding) to one tag, unless it already
	 * declares a `loading` attribute — in which case the author's choice stands and
	 * the tag is returned byte-identical. `decoding` is only added when absent.
	 */
	private static function augment_tag( string $tag, bool $add_decoding ): string {
		// A leading whitespace anchor avoids false-matching value substrings such as
		// `data-loading="…"` (preceded by `-`, not whitespace) as a real attribute.
		if ( preg_match( '/\sloading\s*=/i', $tag ) ) {
			return $tag;
		}
		$additions = ' loading="lazy"';
		if ( $add_decoding && ! preg_match( '/\sdecoding\s*=/i', $tag ) ) {
			$additions .= ' decoding="async"';
		}
		return self::insert_before_close( $tag, $additions );
	}

	/** Insert additions just before the tag's closing bracket, preserving `/>`. */
	private static function insert_before_close( string $tag, string $additions ): string {
		if ( '/>' === substr( $tag, -2 ) ) {
			return substr( $tag, 0, -2 ) . $additions . ' />';
		}
		return substr( $tag, 0, -1 ) . $additions . '>';
	}

	/** Clamp the skip-first-N control into [0, MAX_SKIP]. */
	private static function clamp_skip( int $n ): int {
		if ( $n < 0 ) {
			return 0;
		}
		if ( $n > self::MAX_SKIP ) {
			return self::MAX_SKIP;
		}
		return $n;
	}

	// ── admin UI ───────────────────────────────────────────────────────────────

	/**
	 * Render the admin section: a locked notice listing the gate reasons when the
	 * feature is locked, otherwise the settings form + a short explanation. All
	 * WordPress output helpers are function_exists-guarded so the class stays
	 * loadable under the no-WP harness.
	 */
	public function render_section(): void {
		if ( ! function_exists( 'esc_html' ) || ! function_exists( 'esc_attr' ) ) {
			return;
		}

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->render_locked_notice( $gate );
			return;
		}

		$this->render_result_notice();

		$settings = $this->settings();
		$action   = function_exists( 'admin_url' ) ? admin_url( 'admin-post.php' ) : '';

		echo '<p class="description" style="max-width:640px;">'
			. esc_html__( 'Defers off-screen images and iframes until they scroll into view, so pages paint faster. Attributes are only added to media the author did not already annotate; the first images are left eager to protect Largest Contentful Paint.', 'infraweaver-connector' )
			. '</p>';

		echo '<form method="post" action="' . esc_url( $action ) . '" style="margin-top:12px;max-width:640px;">';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::SETTINGS_NONCE );
		}
		echo '<input type="hidden" name="action" value="' . esc_attr( self::SETTINGS_ACTION ) . '">';

		echo '<div class="iwsl-primary">';
		echo '<span class="iwsl-primary__meta">' . esc_html( ! empty( $settings['enabled'] )
			? __( 'Lazy-loading is on.', 'infraweaver-connector' )
			: __( 'Lazy-loading is off.', 'infraweaver-connector' ) ) . '</span>';
		echo '<label><input type="checkbox" name="enabled" value="1"' . ( ! empty( $settings['enabled'] ) ? ' checked' : '' ) . '> '
			. esc_html__( 'Defer off-screen images', 'infraweaver-connector' ) . iwsl_field_help( 'Waits to load images below the screen until you scroll to them.' ) . '</label> ';
		echo '<button type="submit" class="button button-primary">' . esc_html__( 'Save changes', 'infraweaver-connector' ) . '</button>';
		echo '</div>';

		echo '<details class="iwsl-adv"><summary>' . esc_html__( 'Advanced settings', 'infraweaver-connector' ) . '</summary><div class="iwsl-adv__body">';
		echo '<table class="form-table" role="presentation"><tbody>';

		echo '<tr><th scope="row">' . esc_html__( 'Iframes', 'infraweaver-connector' ) . '</th><td>';
		echo '<label><input type="checkbox" name="lazy_iframes" value="1"' . ( ! empty( $settings['lazy_iframes'] ) ? ' checked' : '' ) . '> '
			. esc_html__( 'Also lazy-load iframes (embeds, maps, videos)', 'infraweaver-connector' ) . iwsl_field_help( 'Also delay embeds like maps and videos until you scroll near.' ) . '</label>';
		echo '</td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-ll-skip">' . esc_html__( 'Skip first images', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'How many top images to load normally so the page top isn’t blank.' ) . '</th><td>';
		echo '<input type="number" id="iwsl-ll-skip" name="skip_images" min="0" max="' . esc_attr( (string) self::MAX_SKIP ) . '" value="' . esc_attr( (string) $settings['skip_images'] ) . '" class="small-text">';
		echo ' <span class="description">' . esc_html__( 'Leave this many leading images eager to protect LCP (default 1).', 'infraweaver-connector' ) . '</span>';
		echo '</td></tr>';

		echo '</tbody></table>';
		echo '</div></details>';
		echo '</form>';
	}

	/** The locked-state notice, listing each gate reason in friendly language. */
	private function render_locked_notice( array $gate ): void {
		$messages = array(
			'not-linked'      => __( 'This site is not linked to the console.', 'infraweaver-connector' ),
			'heartbeat-stale' => __( 'The console has not verified this site recently.', 'infraweaver-connector' ),
			'requires-plus'   => __( 'Lazy-Load Media requires a Pro plan.', 'infraweaver-connector' ),
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>'
			. esc_html__( '🔒 Lazy-Load Media is locked.', 'infraweaver-connector' )
			. '</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) ( $gate['reasons'] ?? array() ) as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	/** Render (then clear) the current user's PRG result transient. */
	private function render_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key    = self::RESULT_PREFIX . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		if ( ! empty( $result['ok'] ) ) {
			echo '<div class="notice notice-success" style="margin-top:12px;padding:12px;"><p>'
				. esc_html__( 'Settings saved.', 'infraweaver-connector' ) . '</p></div>';
		} else {
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p>'
				. esc_html( sprintf( 'Could not save: %s', (string) ( $result['reason'] ?? 'unknown' ) ) ) . '</p></div>';
		}
	}
}
