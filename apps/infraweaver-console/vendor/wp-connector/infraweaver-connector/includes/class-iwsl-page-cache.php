<?php
/**
 * Controller for the gated "Page Cache" feature — a safe-by-default full-page
 * cache. This is the payload behind the `page_cache` entitlement, kept separate
 * from the gate (IWSL_Entitlements) and from the serve/store engine (the pure
 * helpers in iwsl-page-cache-helpers.php + the drop-in template) so each can be
 * reasoned about — and tested — in isolation, mirroring IWSL_Media_Optimizer and
 * IWSL_Redirects.
 *
 * WHY PRESENCE-BASED GATING. WordPress serves a page cache through its native
 * mechanism: `define('WP_CACHE', true)` in wp-config.php plus a
 * wp-content/advanced-cache.php drop-in that core includes VERY EARLY — before
 * plugins load. Because the drop-in runs before IWSL_Entitlements exists, it
 * cannot call evaluate() per request. The gate is therefore enforced by the
 * drop-in's EXISTENCE: enable() writes the drop-in + sets WP_CACHE ONLY while
 * entitled (STATEMENT 1 is the authoritative gate), and maybe_revoke() removes
 * the drop-in + strips WP_CACHE the moment the flag is revoked. The drop-in
 * carries a signature header so the plugin only ever removes ITS OWN drop-in,
 * never a competing cache plugin's.
 *
 * TRUST MODEL. Console-authoritative: the `page_cache` flag is written ONLY by
 * the dual-signed `entitlements.set` runner (§7). There is deliberately no
 * self-set path, REST route, AJAX endpoint, cron, or nopriv surface here, and no
 * new signed command — this is a purely-local admin action plus passive purge
 * hooks. RESIDUAL RISK: a site owner with direct DB write access can flip the
 * local flag, exactly the accepted `plus` threat model, bounded by heartbeat
 * staleness — evaluate() requires state==active AND a fresh signed contact
 * within HEARTBEAT_FRESH_MS (2h), so an unmanaged site re-locks and
 * maybe_revoke() tears the cache down on the next admin/signed contact.
 *
 * SAFETY. No exec/shell_exec/proc_open — in-process only. Cache files live ONLY
 * under wp-content/cache/iwsl (realpath-contained), are named by a sha1 digest
 * (no attacker bytes in filenames), written temp-then-rename (atomic), and served
 * only to ANONYMOUS visitors (the drop-in bypasses on any login/session/cart
 * cookie). The wp-config edit is idempotent, backed up (.iwsl.bak), atomic, and
 * removes only OUR exact marker line; a non-writable wp-config never fatals —
 * status()/enable() report the manual step instead. WordPress calls are
 * function_exists-guarded so the controller runs under the no-WP harness with an
 * injected content dir, config path and clock.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Page_Cache {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'page_cache';

	/** Signature string every IWSL drop-in carries in its first 512 bytes. */
	const SIGNATURE = 'signature: iwsl-page-cache';

	/** Cache subdirectory under the content dir. */
	const CACHE_SUBDIR = 'cache/iwsl';

	/** Default freshness TTL for a stored page (seconds). */
	const DEFAULT_TTL_S = 3600;

	/** Hard cap on distinct cached entries — bounds disk + directory size. */
	const MAX_ENTRIES = 2000;

	/** The exact wp-config line we insert/remove — carries our marker comment. */
	const WPCONFIG_MARKER = "define( 'WP_CACHE', true ); // iwsl-page-cache";

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var string Content dir (WP_CONTENT_DIR); realpath containment root. */
	private $content_dir;

	/** @var string wp-config.php path (ABSPATH.'wp-config.php'). */
	private $config_path;

	/** @var callable():int current unix ms. */
	private $now_ms;

	/** @var int Freshness TTL (seconds). */
	private $ttl;

	/** @var int Max distinct cached entries. */
	private $max_entries;

	/** @var string Lowercased home host baked into the drop-in, '' outside WP. */
	private $home_host;

	/**
	 * @param IWSL_Entitlements $entitlements The gate.
	 * @param string|null       $content_dir  Content dir; defaults WP_CONTENT_DIR. Injectable in the harness.
	 * @param string|null       $config_path  wp-config path; defaults ABSPATH.'wp-config.php'. Injectable.
	 * @param callable|null     $now_ms       Clock, mirrors IWSL_Entitlements.
	 * @param array|null        $config       Optional { ttl:int, max_entries:int } overrides.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		?string $content_dir = null,
		?string $config_path = null,
		?callable $now_ms = null,
		?array $config = null
	) {
		$this->entitlements = $entitlements;
		$this->content_dir  = null !== $content_dir ? $content_dir : self::default_content_dir();
		$this->config_path  = null !== $config_path ? $config_path : self::default_config_path();
		$this->now_ms       = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};

		$this->ttl         = self::DEFAULT_TTL_S;
		$this->max_entries = self::MAX_ENTRIES;
		if ( is_array( $config ) ) {
			if ( isset( $config['ttl'] ) && (int) $config['ttl'] > 0 ) {
				$this->ttl = (int) $config['ttl'];
			}
			if ( isset( $config['max_entries'] ) && (int) $config['max_entries'] > 0 ) {
				$this->max_entries = (int) $config['max_entries'];
			}
		}

		$this->home_host = self::default_home_host();
	}

	/** Register purge hooks (self-gated) + the admin_init revocation check. */
	public function register(): void {
		if ( ! function_exists( 'add_action' ) ) {
			return;
		}
		$purge = array( $this, 'on_content_change' );
		$hooks = array(
			'save_post',
			'post_updated',
			'transition_post_status',
			'comment_post',
			'edit_comment',
			'wp_set_comment_status',
			'switch_theme',
			'activated_plugin',
			'deactivated_plugin',
			'update_option_permalink_structure',
		);
		foreach ( $hooks as $hook ) {
			add_action( $hook, $purge );
		}
		// admin_init covers wp-admin navigation; the plugin bootstrap also calls
		// maybe_revoke() once per request to cover the signed-command path.
		add_action( 'admin_init', array( $this, 'maybe_revoke' ) );
	}

	// ── the presence gate: grant / revoke ──────────────────────────────────────

	/**
	 * Turn the page cache on. STATEMENT 1 is the authoritative entitlement gate —
	 * nothing below it runs for a locked site, so no drop-in is ever written
	 * without a live entitlement. Refuses to overwrite a FOREIGN advanced-cache.php
	 * (another cache plugin). Writes our drop-in atomically, creates the contained
	 * cache dir, and best-effort sets WP_CACHE in wp-config; a non-writable
	 * wp-config is NOT fatal — the drop-in stays inert (WP won't load it) and the
	 * summary carries the manual step.
	 *
	 * @return array Immutable summary { ok, reason?, gate?, wp_config_written:bool, manual_step? }.
	 */
	public function enable(): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		if ( $this->dropin_exists() && ! $this->dropin_is_ours() ) {
			return array( 'ok' => false, 'reason' => 'dropin-conflict' );
		}

		if ( ! $this->ensure_cache_dir() ) {
			return array( 'ok' => false, 'reason' => 'cache-dir-failed' );
		}

		if ( ! $this->write_dropin_atomic() ) {
			return array( 'ok' => false, 'reason' => 'dropin-write-failed' );
		}

		$wp  = $this->set_wp_cache( true );
		$out = array(
			'ok'                => true,
			'wp_config_written' => ! empty( $wp['written'] ),
		);
		if ( ! empty( $wp['manual_step'] ) ) {
			$out['manual_step'] = (string) $wp['manual_step'];
		}
		return $out;
	}

	/**
	 * Turn the page cache off: remove OUR drop-in (signature-verified — a foreign
	 * drop-in is reported and never touched), strip our WP_CACHE marker line, and
	 * purge the cache dir.
	 *
	 * @return array { ok:bool, reason?:string, removed:bool, purged:int }
	 */
	public function disable(): array {
		if ( $this->dropin_exists() && ! $this->dropin_is_ours() ) {
			return array( 'ok' => false, 'reason' => 'foreign-dropin', 'removed' => false, 'purged' => 0 );
		}

		$removed = false;
		if ( $this->dropin_exists() ) {
			$removed = $this->safe_unlink( $this->dropin_path() );
		}

		$this->set_wp_cache( false );
		$purge = $this->purge_all();

		return array(
			'ok'      => true,
			'removed' => $removed,
			'purged'  => (int) ( $purge['purged'] ?? 0 ),
		);
	}

	/**
	 * The presence-gate enforcer. Cheap: the common case is one is_file() (via
	 * dropin_is_ours). If OUR drop-in is present but the entitlement is no longer
	 * unlocked (revoked / not-linked / stale heartbeat), tear the whole cache
	 * down. A foreign drop-in is never touched. Never calls evaluate() unless our
	 * drop-in is actually present.
	 */
	public function maybe_revoke(): void {
		if ( ! $this->dropin_is_ours() ) {
			return;
		}
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( ! empty( $gate['unlocked'] ) ) {
			return;
		}
		$this->disable();
	}

	// ── purge ──────────────────────────────────────────────────────────────────

	/**
	 * The purge-on-content-change callback. STATEMENT 1 self-gates on is_enabled()
	 * so a locked/disabled site pays nothing (purging is harmless, so presence-
	 * gating suffices here — no evaluate() cost on every save). Purge-everything is
	 * v1's simplest and safest strategy.
	 */
	public function on_content_change(): void {
		if ( ! $this->is_enabled() ) {
			return;
		}
		$this->purge_all();
	}

	/**
	 * Remove every cached page + orphaned temp file under the CONTAINED cache dir.
	 * Iterates only *.html / *.iwsltmp directly in that dir (no recursion), never
	 * follows a symlink, and re-checks realpath containment on each entry before
	 * unlinking.
	 *
	 * @return array { ok:bool, purged:int }
	 */
	public function purge_all(): array {
		$real = $this->contained_dir();
		if ( false === $real ) {
			return array( 'ok' => true, 'purged' => 0 );
		}

		$purged = 0;
		foreach ( array( '*.html', '*.iwsltmp' ) as $pattern ) {
			$files = glob( $real . '/' . $pattern );
			if ( ! is_array( $files ) ) {
				continue;
			}
			foreach ( $files as $file ) {
				if ( is_link( $file ) ) {
					continue; // never follow a symlink out of the contained dir.
				}
				if ( ! is_file( $file ) ) {
					continue;
				}
				if ( ! $this->contained( $file ) ) {
					continue;
				}
				if ( @unlink( $file ) ) {
					$purged++;
				}
			}
		}
		return array( 'ok' => true, 'purged' => $purged );
	}

	// ── status ─────────────────────────────────────────────────────────────────

	/**
	 * A read-only snapshot for the admin panel. Side-effect free.
	 *
	 * @return array { enabled, dropin_present, dropin_is_ours, wp_cache_defined,
	 *                 wp_config_writable, entries, total_bytes, ttl }
	 */
	public function status(): array {
		$entries = 0;
		$bytes   = 0;
		$real    = $this->contained_dir();
		if ( false !== $real ) {
			$files = glob( $real . '/*.html' );
			if ( is_array( $files ) ) {
				foreach ( $files as $file ) {
					if ( is_link( $file ) || ! is_file( $file ) ) {
						continue;
					}
					$entries++;
					$size = @filesize( $file );
					if ( false !== $size ) {
						$bytes += (int) $size;
					}
				}
			}
		}

		return array(
			'enabled'            => $this->is_enabled(),
			'dropin_present'     => $this->dropin_exists(),
			'dropin_is_ours'     => $this->dropin_is_ours(),
			'wp_cache_defined'   => $this->wp_cache_in_config(),
			'wp_config_writable' => $this->config_writable(),
			'entries'            => $entries,
			'total_bytes'        => $bytes,
			'ttl'                => $this->ttl,
		);
	}

	/** True when our drop-in is installed AND WP_CACHE is defined true at runtime. */
	public function is_enabled(): bool {
		return $this->dropin_exists()
			&& $this->dropin_is_ours()
			&& defined( 'WP_CACHE' ) && WP_CACHE;
	}

	// ── drop-in file management ─────────────────────────────────────────────────

	/** Path to the advanced-cache.php drop-in in the content dir. */
	private function dropin_path(): string {
		return rtrim( $this->content_dir, '/' ) . '/advanced-cache.php';
	}

	/** Whether an advanced-cache.php exists at all (any owner). */
	private function dropin_exists(): bool {
		return is_file( $this->dropin_path() );
	}

	/**
	 * Whether the installed drop-in is OURS — carries our signature in the first
	 * 512 bytes. A symlinked or unreadable drop-in is treated as not-ours (never
	 * touched). Returns false when no drop-in is present.
	 */
	private function dropin_is_ours(): bool {
		$path = $this->dropin_path();
		if ( is_link( $path ) || ! is_file( $path ) ) {
			return false;
		}
		$fp = @fopen( $path, 'rb' );
		if ( false === $fp ) {
			return false;
		}
		$head = (string) @fread( $fp, 512 );
		@fclose( $fp );
		return false !== strpos( $head, self::SIGNATURE );
	}

	/**
	 * Render the bundled template with the baked values, then write it to the
	 * drop-in path via a temp sibling + rename (atomic). Every fs op is guarded.
	 */
	private function write_dropin_atomic(): bool {
		$template = $this->template();
		if ( '' === $template ) {
			return false;
		}
		$rendered = $this->render_template( $template );

		$dest = $this->dropin_path();
		$tmp  = $dest . '.' . getmypid() . '.iwsltmp';

		$fp = @fopen( $tmp, 'wb' );
		if ( false === $fp ) {
			return false;
		}
		$written = @fwrite( $fp, $rendered );
		@fclose( $fp );
		if ( false === $written ) {
			$this->safe_unlink( $tmp );
			return false;
		}
		if ( ! @rename( $tmp, $dest ) ) {
			$this->safe_unlink( $tmp );
			return false;
		}
		return true;
	}

	/** Read the bundled drop-in template, or '' if unreadable. */
	private function template(): string {
		$path = __DIR__ . '/advanced-cache.tpl.php';
		if ( ! is_file( $path ) ) {
			return '';
		}
		$raw = @file_get_contents( $path );
		return is_string( $raw ) ? $raw : '';
	}

	/** Substitute the five baked values into the template. */
	private function render_template( string $template ): string {
		$helpers_path = __DIR__ . '/iwsl-page-cache-helpers.php';
		return strtr(
			$template,
			array(
				'%%IWSL_PC_HELPERS_PATH%%' => self::php_str( $helpers_path ),
				'%%IWSL_PC_CACHE_DIR%%'    => self::php_str( $this->cache_dir() ),
				'%%IWSL_PC_HOST%%'         => self::php_str( $this->home_host ),
				'%%IWSL_PC_TTL%%'          => (string) (int) $this->ttl,
				'%%IWSL_PC_MAX_ENTRIES%%'  => (string) (int) $this->max_entries,
			)
		);
	}

	/** Escape a value for a single-quoted PHP string literal in the template. */
	private static function php_str( string $value ): string {
		return str_replace( array( '\\', "'" ), array( '\\\\', "\\'" ), $value );
	}

	// ── wp-config editor (idempotent, backed up, atomic, surgical) ─────────────

	/**
	 * Safely toggle the WP_CACHE define in wp-config.php.
	 *
	 * On:  if ANY WP_CACHE define already exists, leave the file untouched
	 *      (idempotent, never fights another plugin's define); else insert our
	 *      marker line right after the opening <?php (fallback: before the
	 *      "That's all, stop editing!" marker), backing up to .iwsl.bak and
	 *      writing atomically. Not writable → { written:false, manual_step }.
	 * Off: delete ONLY our exact marker line, never a define we didn't write.
	 *
	 * Never fatals: every fs op is @-guarded and result-checked.
	 *
	 * @return array { written:bool, manual_step?:string, already?:bool }
	 */
	private function set_wp_cache( bool $on ): array {
		$path = $this->config_path;
		if ( '' === $path || ! is_file( $path ) || ! is_readable( $path ) ) {
			return array( 'written' => false, 'manual_step' => $this->manual_step() );
		}
		$contents = @file_get_contents( $path );
		if ( false === $contents ) {
			return array( 'written' => false, 'manual_step' => $this->manual_step() );
		}

		if ( $on ) {
			if ( preg_match( '/define\s*\(\s*[\'"]WP_CACHE[\'"]/', $contents ) ) {
				return array( 'written' => false, 'already' => true );
			}
			if ( ! $this->config_writable() ) {
				return array( 'written' => false, 'manual_step' => $this->manual_step() );
			}
			$new = $this->insert_wp_cache_line( $contents );
			if ( null === $new ) {
				return array( 'written' => false, 'manual_step' => $this->manual_step() );
			}
			return $this->write_config_atomic( $path, $contents, $new )
				? array( 'written' => true )
				: array( 'written' => false, 'manual_step' => $this->manual_step() );
		}

		// Off: strip only our exact marker line.
		if ( false === strpos( $contents, self::WPCONFIG_MARKER ) ) {
			return array( 'written' => false );
		}
		if ( ! $this->config_writable() ) {
			return array( 'written' => false );
		}
		$new = $this->remove_wp_cache_line( $contents );
		return $this->write_config_atomic( $path, $contents, $new )
			? array( 'written' => true )
			: array( 'written' => false );
	}

	/** Insert our marker line after the opening <?php (fallback: before stop-editing). Null if no anchor. */
	private function insert_wp_cache_line( string $contents ): ?string {
		$line = self::WPCONFIG_MARKER . "\n";

		if ( preg_match( '/^(<\?php[^\n]*\n)/', $contents, $m ) ) {
			$at = strlen( $m[1] );
			return substr( $contents, 0, $at ) . $line . substr( $contents, $at );
		}

		$marker = "/* That's all, stop editing!";
		$pos    = strpos( $contents, $marker );
		if ( false !== $pos ) {
			return substr( $contents, 0, $pos ) . $line . substr( $contents, $pos );
		}

		$pos = strpos( $contents, '<?php' );
		if ( false !== $pos ) {
			$at = $pos + strlen( '<?php' );
			return substr( $contents, 0, $at ) . "\n" . $line . substr( $contents, $at );
		}

		return null;
	}

	/** Remove the FIRST occurrence of our exact marker line, nothing else. */
	private function remove_wp_cache_line( string $contents ): string {
		$needle = self::WPCONFIG_MARKER . "\n";
		if ( false !== strpos( $contents, $needle ) ) {
			return self::str_replace_first( $needle, '', $contents );
		}
		return self::str_replace_first( self::WPCONFIG_MARKER, '', $contents );
	}

	/** Replace only the first occurrence of $search in $subject. */
	private static function str_replace_first( string $search, string $replace, string $subject ): string {
		$pos = strpos( $subject, $search );
		if ( false === $pos ) {
			return $subject;
		}
		return substr( $subject, 0, $pos ) . $replace . substr( $subject, $pos + strlen( $search ) );
	}

	/** Back up the original to .iwsl.bak, then write $new via temp + rename (atomic). */
	private function write_config_atomic( string $path, string $original, string $new ): bool {
		$bak = $path . '.iwsl.bak';
		if ( false === @file_put_contents( $bak, $original ) ) {
			return false;
		}
		$tmp = $path . '.' . getmypid() . '.iwsltmp';
		if ( false === @file_put_contents( $tmp, $new ) ) {
			$this->safe_unlink( $tmp );
			return false;
		}
		if ( ! @rename( $tmp, $path ) ) {
			$this->safe_unlink( $tmp );
			return false;
		}
		return true;
	}

	/** Whether wp-config carries a WP_CACHE = true define (any owner). */
	private function wp_cache_in_config(): bool {
		$path = $this->config_path;
		if ( '' === $path || ! is_file( $path ) || ! is_readable( $path ) ) {
			return false;
		}
		$contents = @file_get_contents( $path );
		if ( false === $contents ) {
			return false;
		}
		return (bool) preg_match( '/define\s*\(\s*[\'"]WP_CACHE[\'"]\s*,\s*true/i', $contents );
	}

	/** Whether wp-config.php (or its dir, if the file is absent) is writable. */
	private function config_writable(): bool {
		$path = $this->config_path;
		if ( '' === $path ) {
			return false;
		}
		if ( is_file( $path ) ) {
			return is_writable( $path );
		}
		$dir = dirname( $path );
		return is_dir( $dir ) && is_writable( $dir );
	}

	/** The manual instruction shown when we cannot edit wp-config ourselves. */
	private function manual_step(): string {
		return "Add define( 'WP_CACHE', true ); near the top of wp-config.php to activate the page cache.";
	}

	// ── cache dir + containment ────────────────────────────────────────────────

	/** The cache directory: content_dir/cache/iwsl. */
	private function cache_dir(): string {
		return rtrim( $this->content_dir, '/' ) . '/' . self::CACHE_SUBDIR;
	}

	/** realpath of the cache dir, or false when it does not exist. @return string|false */
	private function contained_dir() {
		$dir = $this->cache_dir();
		return realpath( $dir );
	}

	/** Create the contained cache dir if needed; refuse on containment failure. */
	private function ensure_cache_dir(): bool {
		$dir = $this->cache_dir();
		if ( ! is_dir( $dir ) && ! @mkdir( $dir, 0755, true ) && ! is_dir( $dir ) ) {
			return false;
		}
		return $this->dir_contained_in_content( $dir );
	}

	/** Whether $dir resolves strictly inside the content dir. */
	private function dir_contained_in_content( string $dir ): bool {
		$real_content = '' === $this->content_dir ? false : realpath( $this->content_dir );
		$real_dir     = realpath( $dir );
		if ( false === $real_content || false === $real_dir ) {
			return false;
		}
		return 0 === strpos( $real_dir . '/', rtrim( $real_content, '/' ) . '/' );
	}

	/** Whether a resolved file path sits inside the cache dir (realpath prefix). */
	private function contained( string $path ): bool {
		$real_base = $this->contained_dir();
		if ( false === $real_base ) {
			return false;
		}
		$real = realpath( $path );
		if ( false === $real ) {
			return false;
		}
		return 0 === strpos( $real, rtrim( $real_base, '/' ) . '/' );
	}

	/** Unlink a path only if it is a real (non-symlink) file. Returns success. */
	private function safe_unlink( string $path ): bool {
		if ( is_link( $path ) ) {
			return @unlink( $path );
		}
		if ( is_file( $path ) ) {
			return @unlink( $path );
		}
		return false;
	}

	// ── defaults (WordPress-derived, guarded for the harness) ──────────────────

	/** WP_CONTENT_DIR under WordPress, '' outside it. */
	private static function default_content_dir(): string {
		if ( defined( 'WP_CONTENT_DIR' ) ) {
			return (string) WP_CONTENT_DIR;
		}
		return '';
	}

	/** ABSPATH.'wp-config.php' under WordPress, '' outside it. */
	private static function default_config_path(): string {
		if ( defined( 'ABSPATH' ) ) {
			return rtrim( (string) ABSPATH, '/\\' ) . '/wp-config.php';
		}
		return '';
	}

	/** Lowercased home host from home_url(), '' outside WordPress. */
	private static function default_home_host(): string {
		if ( function_exists( 'home_url' ) ) {
			$home = home_url();
			if ( is_string( $home ) && '' !== $home ) {
				$parts = function_exists( 'wp_parse_url' ) ? wp_parse_url( $home ) : parse_url( $home );
				if ( is_array( $parts ) && isset( $parts['host'] ) && is_string( $parts['host'] ) ) {
					return strtolower( $parts['host'] );
				}
			}
		}
		return '';
	}
}
