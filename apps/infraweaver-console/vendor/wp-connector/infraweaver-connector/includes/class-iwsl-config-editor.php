<?php
/**
 * The "Config" editor engine: a SECURE editor for a HARD-CODED ALLOW-LIST of
 * WordPress constants and PHP-FPM ini limits. This is the payload behind the
 * Config admin tab, kept separate from the admin surface (IWSL_Admin) so the
 * validation + file-write logic can be reasoned about — and tested — in
 * isolation, mirroring IWSL_Page_Cache's wp-config editor.
 *
 * SECURITY MODEL. There is NO way to write an arbitrary key or arbitrary PHP.
 * Only the keys in self::allowlist() are ever considered; a submitted key that
 * is not in that list is rejected (never written). Every allowed key carries a
 * per-key TYPE + VALIDATOR — a memory/size string must match ^\d+[KMG]?$, an int
 * must be numeric and within its range, a bool is coerced from a checkbox. A
 * value that fails its validator is REJECTED (reported in `skipped`), not
 * written. The `define()` name is never taken from input — it is the hard-coded
 * allow-list key. No eval, no include, no raw file passthrough.
 *
 * WRITE TARGETS (both managed, marker-delimited, idempotent, removable).
 *   1. wp-config.php constants → written inside a managed block bounded by
 *      `// BEGIN InfraWeaver Config` … `// END InfraWeaver Config`, inserted right
 *      after the opening <?php (before wp-settings.php loads). Re-applying strips
 *      the existing block and re-inserts, so the block never duplicates.
 *   2. PHP ini limits → written to whichever per-directory mechanism the RUNNING
 *      SAPI actually honors (see php_limits_mechanism()). Apache mod_php
 *      (`apache2handler`) IGNORES `.user.ini` entirely — that file is a
 *      CGI/FastCGI feature — but honors `php_value` in `.htaccess`, so under
 *      mod_php a `# BEGIN InfraWeaver Config` block of `php_value` directives is
 *      written to `.htaccess` (prepended ABOVE WordPress's own markers, guarded by
 *      `<IfModule mod_php*.c>`). Every FastCGI/FPM SAPI instead reads a
 *      `; BEGIN InfraWeaver Config` block in a managed `.user.ini` in ABSPATH.
 *      Picking the wrong file is the whole difference between the limit changing
 *      and silently doing nothing — which is the bug this class exists to avoid.
 *
 * FAIL-SAFE. Every write path is best-effort and non-fatal. If a target is not
 * writable, NOTHING destructive happens: the keys for that target are reported
 * in `skipped` (reason `*-unwritable`) with a clear `manual_step`, and apply()
 * still returns ok=true — exactly mirroring IWSL_Page_Cache's non-writable
 * wp-config behavior. Writes are atomic (temp + rename) and back the original up
 * to a `.iwsl.bak` sibling first.
 *
 * HARNESS-SAFE. The class reads only core-PHP primitives (defined/constant/
 * ini_get + filesystem), takes an injected base path (ABSPATH) and wp-config
 * path, and needs no WordPress runtime — so it constructs and runs under the
 * zero-dependency test harness exactly as it does inside WordPress.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Config_Editor {

	/** Managed-block markers in wp-config.php (PHP line comments). */
	const WPCONFIG_BEGIN = '// BEGIN InfraWeaver Config';
	const WPCONFIG_END   = '// END InfraWeaver Config';

	/** Managed-block markers in .user.ini (ini line comments). */
	const USERINI_BEGIN = '; BEGIN InfraWeaver Config';
	const USERINI_END   = '; END InfraWeaver Config';

	/** The managed FastCGI/FPM per-directory ini file, relative to ABSPATH. */
	const USER_INI = '.user.ini';

	/** Managed-block markers in .htaccess (Apache line comments). */
	const HTACCESS_BEGIN = '# BEGIN InfraWeaver Config';
	const HTACCESS_END   = '# END InfraWeaver Config';

	/** The managed Apache per-directory config, relative to ABSPATH (mod_php). */
	const HTACCESS = '.htaccess';

	/** @var string ABSPATH (WordPress root); base for the .user.ini / .htaccess. */
	private $abspath;

	/** @var string wp-config.php path (ABSPATH.'wp-config.php'). */
	private $config_path;

	/** @var string PHP SAPI name; decides the PHP-limits mechanism (mod_php→.htaccess, FastCGI→.user.ini). */
	private $sapi;

	/**
	 * @param string|null $abspath     WordPress root; defaults ABSPATH. Injectable in the harness.
	 * @param string|null $config_path wp-config path; defaults ABSPATH.'wp-config.php'. Injectable.
	 * @param string|null $sapi        PHP SAPI name; defaults php_sapi_name(). Injectable so the harness can
	 *                                 exercise both the mod_php (.htaccess) and FastCGI (.user.ini) paths.
	 */
	public function __construct( ?string $abspath = null, ?string $config_path = null, ?string $sapi = null ) {
		$this->abspath     = null !== $abspath ? $abspath : self::default_abspath();
		$this->config_path = null !== $config_path ? $config_path : self::default_config_path();
		$this->sapi        = null !== $sapi ? $sapi : (string) php_sapi_name();
	}

	// ── the allow-list (the ONLY keys that can ever be written) ─────────────────

	/**
	 * The hard-coded allow-list. Each entry: human `label`, `group`
	 * (`wpconfig` → a define() in wp-config.php, `userini` → a directive in
	 * .user.ini), a `type` driving the validator + serializer, and (for ints) an
	 * inclusive `min`. Nothing outside this map is ever written.
	 *
	 * @return array<string,array{label:string,group:string,type:string,min?:int}>
	 */
	public static function allowlist(): array {
		return array(
			// wp-config.php constants.
			'WP_MEMORY_LIMIT'     => array( 'label' => 'Memory limit', 'group' => 'wpconfig', 'type' => 'size' ),
			'WP_MAX_MEMORY_LIMIT' => array( 'label' => 'Max memory limit (admin)', 'group' => 'wpconfig', 'type' => 'size' ),
			'WP_POST_REVISIONS'   => array( 'label' => 'Post revisions', 'group' => 'wpconfig', 'type' => 'int_or_false', 'min' => 0 ),
			'EMPTY_TRASH_DAYS'    => array( 'label' => 'Empty trash after (days)', 'group' => 'wpconfig', 'type' => 'int', 'min' => 0 ),
			'AUTOSAVE_INTERVAL'   => array( 'label' => 'Autosave interval (seconds)', 'group' => 'wpconfig', 'type' => 'int', 'min' => 10 ),
			'WP_DEBUG'            => array( 'label' => 'Debug mode', 'group' => 'wpconfig', 'type' => 'bool' ),
			'WP_DEBUG_LOG'        => array( 'label' => 'Debug logging', 'group' => 'wpconfig', 'type' => 'bool' ),
			'WP_DEBUG_DISPLAY'    => array( 'label' => 'Display debug errors', 'group' => 'wpconfig', 'type' => 'bool' ),
			'DISALLOW_FILE_EDIT'  => array( 'label' => 'Disallow theme/plugin file editing', 'group' => 'wpconfig', 'type' => 'bool' ),
			// PHP ini limits (.user.ini).
			'upload_max_filesize' => array( 'label' => 'Max upload file size', 'group' => 'userini', 'type' => 'size' ),
			'post_max_size'       => array( 'label' => 'Max POST size', 'group' => 'userini', 'type' => 'size' ),
			'max_execution_time'  => array( 'label' => 'Max execution time (seconds)', 'group' => 'userini', 'type' => 'int', 'min' => 0 ),
		);
	}

	// ── read the effective current values (for form pre-fill / display) ─────────

	/**
	 * The effective current value of every allow-listed key: wp-config constants
	 * via defined()/constant(), ini limits via ini_get(). Bools return a real
	 * bool; sizes/ints a string; an undefined constant returns '' (or false for a
	 * bool). Side-effect free.
	 *
	 * @return array<string,mixed>
	 */
	public function current(): array {
		$out = array();
		foreach ( self::allowlist() as $key => $spec ) {
			if ( 'userini' === $spec['group'] ) {
				$val         = ini_get( $key );
				$out[ $key ] = ( false === $val ) ? '' : (string) $val;
				continue;
			}
			if ( defined( $key ) ) {
				$out[ $key ] = constant( $key );
			} else {
				$out[ $key ] = ( 'bool' === $spec['type'] ) ? false : '';
			}
		}
		return $out;
	}

	// ── apply: validate every key, write the two managed blocks fail-safe ───────

	/**
	 * Validate every submitted key against the allow-list + its validator, then
	 * write the valid wp-config constants (managed block, only if wp-config
	 * writable) and the valid PHP limits (to whichever file the running SAPI
	 * honors — `.htaccess` under mod_php, `.user.ini` under FastCGI/FPM — only if
	 * that target is writable). A key that is unknown or fails validation is
	 * REJECTED into `skipped`, never written. An unwritable target is non-fatal:
	 * its keys are reported in `skipped` with an `*-unwritable` reason and a
	 * `manual_step`, and ok stays true. On a successful PHP-limits write the result
	 * carries `php_limits_mechanism`, the live `effective` ini_get() values (which
	 * only refresh on the NEXT request), and an honest `notes` entry saying so.
	 * Returns a fresh immutable result (no input mutation).
	 *
	 * @param array $input Map of allow-list key => raw submitted value.
	 * @return array{ok:bool,applied:array<int,string>,skipped:array<string,string>,wp_config_writable:bool,user_ini_writable:bool,php_limits_mechanism:string,php_limits_writable:bool,effective?:array<string,string>,notes?:array<int,string>,manual_step?:string}
	 */
	public function apply( array $input ): array {
		$applied         = array();
		$skipped         = array();
		$wpconfig_values = array(); // KEY => formatted define() value literal.
		$wpconfig_keys   = array();
		$userini_values  = array(); // key => formatted ini value literal.
		$userini_keys    = array();

		$allow = self::allowlist();
		foreach ( $input as $key => $raw ) {
			$key = (string) $key;
			if ( ! isset( $allow[ $key ] ) ) {
				$skipped[ $key ] = 'not-allowed';
				continue;
			}
			$spec = $allow[ $key ];
			$v    = self::validate_value( $spec, $raw );
			if ( empty( $v['ok'] ) ) {
				$skipped[ $key ] = (string) $v['reason'];
				continue;
			}
			if ( 'userini' === $spec['group'] ) {
				$userini_values[ $key ] = self::format_ini_value( (string) $spec['type'], $v['value'] );
				$userini_keys[]         = $key;
			} else {
				$wpconfig_values[ $key ] = self::format_define_value( (string) $spec['type'], $v['value'] );
				$wpconfig_keys[]         = $key;
			}
		}

		$wp_writable     = $this->wp_config_writable();
		$ini_writable    = $this->user_ini_writable();
		$mechanism       = $this->php_limits_mechanism();
		$limits_writable = $this->php_limits_writable();
		$manual          = array();
		$notes           = array();
		$effective       = array();

		if ( ! empty( $wpconfig_keys ) ) {
			if ( $wp_writable && $this->write_wpconfig_block( $wpconfig_values ) ) {
				foreach ( $wpconfig_keys as $k ) {
					$applied[] = $k;
				}
			} else {
				$reason = $wp_writable ? 'wp-config-write-failed' : 'wp-config-unwritable';
				foreach ( $wpconfig_keys as $k ) {
					$skipped[ $k ] = $reason;
				}
				$manual[] = $this->wp_config_manual_step();
			}
		}

		if ( ! empty( $userini_keys ) ) {
			$wrote = false;
			if ( $limits_writable ) {
				$wrote = ( 'htaccess' === $mechanism )
					? $this->write_htaccess_block( $userini_values )
					: $this->write_userini_block( $userini_values );
			}
			if ( $wrote ) {
				foreach ( $userini_keys as $k ) {
					$applied[]       = $k;
					$live            = ini_get( $k );
					$effective[ $k ] = ( false === $live ) ? '' : (string) $live;
				}
				$notes[] = $this->php_limits_effect_note( $mechanism );
			} else {
				$reason = $this->php_limits_skip_reason( $mechanism, $limits_writable );
				foreach ( $userini_keys as $k ) {
					$skipped[ $k ] = $reason;
				}
				$manual[] = $this->php_limits_manual_step( $mechanism );
			}
		}

		$result = array(
			'ok'                   => true,
			'applied'              => $applied,
			'skipped'              => $skipped,
			'wp_config_writable'   => $wp_writable,
			'user_ini_writable'    => $ini_writable,
			'php_limits_mechanism' => $mechanism,
			'php_limits_writable'  => $limits_writable,
		);
		if ( ! empty( $effective ) ) {
			$result['effective'] = $effective;
		}
		if ( ! empty( $notes ) ) {
			$result['notes'] = $notes;
		}
		if ( ! empty( $manual ) ) {
			$result['manual_step'] = implode( ' ', $manual );
		}
		return $result;
	}

	// ── validators (one per type; reject on any deviation) ──────────────────────

	/**
	 * Validate a raw value against a spec. Returns { ok, value } on success or
	 * { ok:false, reason } on rejection. A bool never rejects (a checkbox is
	 * inherently boolean); every other type rejects anything that does not match.
	 *
	 * @param array $spec An allow-list entry.
	 * @param mixed $raw  The submitted value.
	 * @return array{ok:bool,value?:mixed,reason?:string}
	 */
	private static function validate_value( array $spec, $raw ): array {
		$type = (string) $spec['type'];
		switch ( $type ) {
			case 'bool':
				return array( 'ok' => true, 'value' => self::to_bool( $raw ) );
			case 'size':
				$s = is_scalar( $raw ) ? trim( (string) $raw ) : '';
				if ( 1 === preg_match( '/^\d+[KMG]?$/i', $s ) ) {
					return array( 'ok' => true, 'value' => strtoupper( $s ) );
				}
				return array( 'ok' => false, 'reason' => 'invalid-size' );
			case 'int':
				return self::validate_int( $raw, isset( $spec['min'] ) ? (int) $spec['min'] : 0 );
			case 'int_or_false':
				if ( false === $raw || '' === $raw || ( is_string( $raw ) && 'false' === strtolower( trim( $raw ) ) ) ) {
					return array( 'ok' => true, 'value' => false );
				}
				return self::validate_int( $raw, isset( $spec['min'] ) ? (int) $spec['min'] : 0 );
		}
		return array( 'ok' => false, 'reason' => 'unknown-type' );
	}

	/** A non-negative integer within [$min, ∞). Uses is_numeric + a digit shape + range. */
	private static function validate_int( $raw, int $min ): array {
		if ( ! is_scalar( $raw ) ) {
			return array( 'ok' => false, 'reason' => 'invalid-int' );
		}
		$s = trim( (string) $raw );
		if ( ! is_numeric( $s ) || 1 !== preg_match( '/^\d+$/', $s ) ) {
			return array( 'ok' => false, 'reason' => 'invalid-int' );
		}
		$n = (int) $s;
		if ( $n < $min ) {
			return array( 'ok' => false, 'reason' => 'below-min' );
		}
		return array( 'ok' => true, 'value' => $n );
	}

	/** Coerce a checkbox value to a bool: only 1/on/true/yes are truthy. */
	private static function to_bool( $raw ): bool {
		if ( is_bool( $raw ) ) {
			return $raw;
		}
		if ( is_int( $raw ) ) {
			return 0 !== $raw;
		}
		$s = strtolower( trim( (string) $raw ) );
		return in_array( $s, array( '1', 'on', 'true', 'yes' ), true );
	}

	// ── serializers (validated value → file literal) ───────────────────────────

	/** Serialize a validated value into a define() value literal. */
	private static function format_define_value( string $type, $value ): string {
		switch ( $type ) {
			case 'bool':
				return $value ? 'true' : 'false';
			case 'int':
				return (string) (int) $value;
			case 'int_or_false':
				return false === $value ? 'false' : (string) (int) $value;
			default: // size / string.
				return "'" . str_replace( array( '\\', "'" ), array( '\\\\', "\\'" ), (string) $value ) . "'";
		}
	}

	/** Serialize a validated value into a .user.ini directive value. */
	private static function format_ini_value( string $type, $value ): string {
		if ( 'int' === $type || 'int_or_false' === $type ) {
			return false === $value ? '0' : (string) (int) $value;
		}
		return (string) $value; // size string, already validated to ^\d+[KMG]?$.
	}

	// ── wp-config.php managed block (strip-then-insert; atomic; backed up) ──────

	/**
	 * Replace the managed wp-config block with the given define()s. Reads the file,
	 * strips any existing InfraWeaver block, inserts the fresh block right after the
	 * opening <?php (fallback: before the "stop editing" marker), then writes
	 * atomically with a .iwsl.bak backup. Every fs op is @-guarded; returns false
	 * (never fatals) on any failure.
	 */
	private function write_wpconfig_block( array $values ): bool {
		$path = $this->config_path;
		if ( '' === $path || ! is_file( $path ) || ! is_readable( $path ) ) {
			return false;
		}
		$contents = @file_get_contents( $path );
		if ( false === $contents ) {
			return false;
		}
		$stripped = self::strip_block( $contents, self::WPCONFIG_BEGIN, self::WPCONFIG_END );
		$block    = self::build_wpconfig_block( $values );
		$new      = self::insert_wpconfig_block( $stripped, $block );
		if ( null === $new ) {
			return false;
		}
		return $this->write_atomic( $path, $contents, $new, true );
	}

	/** Build the wp-config managed block (BEGIN + one define per key + END + \n). */
	private static function build_wpconfig_block( array $values ): string {
		$lines = array( self::WPCONFIG_BEGIN );
		foreach ( $values as $key => $literal ) {
			// $key is a hard-coded allow-list constant name; $literal is serialized.
			$lines[] = "define( '" . $key . "', " . $literal . " );";
		}
		$lines[] = self::WPCONFIG_END;
		return implode( "\n", $lines ) . "\n";
	}

	/** Insert the block after the opening <?php line (fallback: before stop-editing). Null if no anchor. */
	private static function insert_wpconfig_block( string $contents, string $block ): ?string {
		if ( preg_match( '/^(<\?php[^\n]*\n)/', $contents, $m ) ) {
			$at = strlen( $m[1] );
			return substr( $contents, 0, $at ) . $block . substr( $contents, $at );
		}
		$marker = "/* That's all, stop editing!";
		$pos    = strpos( $contents, $marker );
		if ( false !== $pos ) {
			return substr( $contents, 0, $pos ) . $block . substr( $contents, $pos );
		}
		$pos = strpos( $contents, '<?php' );
		if ( false !== $pos ) {
			$at = $pos + strlen( '<?php' );
			return substr( $contents, 0, $at ) . "\n" . $block . substr( $contents, $at );
		}
		return null;
	}

	// ── .user.ini managed block (strip-then-append; atomic; backed up) ─────────

	/**
	 * Replace the managed .user.ini block with the given directives. Creates the
	 * file if absent (backing up only when it already existed). Strips any existing
	 * InfraWeaver block, then appends the fresh block at the end so unrelated ini
	 * directives are preserved. Non-fatal on any failure.
	 */
	private function write_userini_block( array $values ): bool {
		$path = $this->user_ini_path();
		if ( '' === $path ) {
			return false;
		}
		$existing = '';
		$had_file = is_file( $path );
		if ( $had_file ) {
			if ( ! is_readable( $path ) ) {
				return false;
			}
			$raw = @file_get_contents( $path );
			if ( false === $raw ) {
				return false;
			}
			$existing = $raw;
		}
		$stripped = self::strip_block( $existing, self::USERINI_BEGIN, self::USERINI_END );
		$block    = self::build_userini_block( $values );
		$sep      = ( '' !== $stripped && "\n" !== substr( $stripped, -1 ) ) ? "\n" : '';
		$new      = $stripped . $sep . $block;
		return $this->write_atomic( $path, $existing, $new, $had_file );
	}

	/** Build the .user.ini managed block (BEGIN + one directive per key + END + \n). */
	private static function build_userini_block( array $values ): string {
		$lines = array( self::USERINI_BEGIN );
		foreach ( $values as $key => $literal ) {
			$lines[] = $key . ' = ' . $literal;
		}
		$lines[] = self::USERINI_END;
		return implode( "\n", $lines ) . "\n";
	}

	// ── .htaccess managed block (mod_php php_value; strip-then-prepend; atomic) ──

	/**
	 * Replace the managed .htaccess block with `php_value` directives (mod_php).
	 * Creates the file if absent (backing up only when it already existed). The
	 * block is PREPENDED at the very top so it always sits OUTSIDE WordPress's own
	 * `# BEGIN WordPress` … `# END WordPress` markers (which WP rewrites in place),
	 * and each directive is wrapped in `<IfModule mod_php*.c>` so a server without
	 * mod_php loaded never chokes on it. Non-fatal on any failure.
	 */
	private function write_htaccess_block( array $values ): bool {
		$path = $this->htaccess_path();
		if ( '' === $path ) {
			return false;
		}
		$existing = '';
		$had_file = is_file( $path );
		if ( $had_file ) {
			if ( ! is_readable( $path ) ) {
				return false;
			}
			$raw = @file_get_contents( $path );
			if ( false === $raw ) {
				return false;
			}
			$existing = $raw;
		}
		$stripped = self::strip_block( $existing, self::HTACCESS_BEGIN, self::HTACCESS_END );
		$block    = self::build_htaccess_block( $values );
		$sep      = ( '' !== $stripped ) ? "\n" : '';
		$new      = $block . $sep . $stripped;
		return $this->write_atomic( $path, $existing, $new, $had_file );
	}

	/**
	 * Build the .htaccess managed block: BEGIN, then the `php_value` directives
	 * guarded by BOTH historic mod_php module tokens (`mod_php.c`, `mod_php7.c`) so
	 * exactly one guard matches on any given build, then END. Every allow-listed
	 * ini key is size/int, so `php_value` (not `php_flag`) is always correct.
	 */
	private static function build_htaccess_block( array $values ): string {
		$lines = array( self::HTACCESS_BEGIN );
		foreach ( array( 'mod_php.c', 'mod_php7.c' ) as $module ) {
			$lines[] = '<IfModule ' . $module . '>';
			foreach ( $values as $key => $literal ) {
				$lines[] = 'php_value ' . $key . ' ' . $literal;
			}
			$lines[] = '</IfModule>';
		}
		$lines[] = self::HTACCESS_END;
		return implode( "\n", $lines ) . "\n";
	}

	// ── shared block + write helpers ────────────────────────────────────────────

	/** Remove the managed block (BEGIN…END + its own trailing newline). Idempotent. */
	private static function strip_block( string $contents, string $begin, string $end ): string {
		$pattern = '/' . preg_quote( $begin, '/' ) . '.*?' . preg_quote( $end, '/' ) . '\n?/s';
		$out     = preg_replace( $pattern, '', $contents );
		return null === $out ? $contents : $out;
	}

	/** Back up the original to .iwsl.bak (when requested), then write $new via temp + rename. */
	private function write_atomic( string $path, string $original, string $new, bool $backup ): bool {
		if ( $backup ) {
			$bak = $path . '.iwsl.bak';
			if ( false === @file_put_contents( $bak, $original ) ) {
				return false;
			}
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

	/** Unlink a path only if it is a real (non-symlink) file. */
	private function safe_unlink( string $path ): bool {
		if ( is_link( $path ) || is_file( $path ) ) {
			return @unlink( $path );
		}
		return false;
	}

	// ── writability + manual-step reporting ─────────────────────────────────────

	/** Whether wp-config.php (or its dir, if the file is absent) is writable. */
	public function wp_config_writable(): bool {
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

	/** Whether the managed .user.ini (or ABSPATH, if the file is absent) is writable. */
	public function user_ini_writable(): bool {
		$path = $this->user_ini_path();
		if ( '' === $path ) {
			return false;
		}
		if ( is_file( $path ) ) {
			return is_writable( $path );
		}
		$dir = rtrim( $this->abspath, '/\\' );
		return '' !== $dir && is_dir( $dir ) && is_writable( $dir );
	}

	/** The path to the managed .user.ini, or '' when no ABSPATH is known. */
	private function user_ini_path(): string {
		if ( '' === $this->abspath ) {
			return '';
		}
		return rtrim( $this->abspath, '/\\' ) . '/' . self::USER_INI;
	}

	private function wp_config_manual_step(): string {
		return 'wp-config.php is not writable — add the InfraWeaver Config define() block near the top of wp-config.php by hand to apply these constants.';
	}

	private function user_ini_manual_step(): string {
		return 'We could not raise your upload and memory limits automatically because a server file is read-only — ask your host or developer to make this change. Technical detail: The .user.ini in the WordPress root is not writable — add the InfraWeaver Config block there by hand to apply the PHP limits.';
	}

	// ── PHP-limits mechanism: mod_php (.htaccess) vs FastCGI/FPM (.user.ini) ─────

	/**
	 * Which per-directory file actually controls PHP limits for the RUNNING SAPI.
	 * Apache mod_php (`apache2handler`) IGNORES `.user.ini` — that file is a
	 * CGI/FastCGI feature — but honors `php_value` in `.htaccess`. Every other SAPI
	 * (php-fpm, php-cgi, LiteSpeed, CLI, …) either reads `.user.ini` or would FATAL
	 * on a `php_value` in `.htaccess` if it sits behind Apache, so they all keep the
	 * safe `.user.ini` path. `apache2handler` is thus the ONLY SAPI switched to
	 * `.htaccess` — precisely the case where `.user.ini` silently does nothing.
	 *
	 * @return string 'htaccess' | 'user_ini'
	 */
	public function php_limits_mechanism(): string {
		return ( 'apache2handler' === $this->sapi ) ? 'htaccess' : 'user_ini';
	}

	/** Whether the resolved PHP-limits target (.htaccess or .user.ini) is writable. */
	public function php_limits_writable(): bool {
		return ( 'htaccess' === $this->php_limits_mechanism() )
			? $this->htaccess_writable()
			: $this->user_ini_writable();
	}

	/** Whether the managed .htaccess (or ABSPATH, if the file is absent) is writable. */
	public function htaccess_writable(): bool {
		$path = $this->htaccess_path();
		if ( '' === $path ) {
			return false;
		}
		if ( is_file( $path ) ) {
			return is_writable( $path );
		}
		$dir = rtrim( $this->abspath, '/\\' );
		return '' !== $dir && is_dir( $dir ) && is_writable( $dir );
	}

	/** The path to the managed .htaccess, or '' when no ABSPATH is known. */
	private function htaccess_path(): string {
		if ( '' === $this->abspath ) {
			return '';
		}
		return rtrim( $this->abspath, '/\\' ) . '/' . self::HTACCESS;
	}

	/**
	 * The PHP limits currently CONFIGURED by the managed block (what we last wrote),
	 * read back from the active mechanism's file. Distinct from current() — which
	 * reports the live effective ini_get() — so a caller can show "configured 64M,
	 * effective still 2M (pending next request)" and never silently lie. Missing
	 * keys report ''. Side-effect free.
	 *
	 * @return array<string,string>
	 */
	public function configured_php_limits(): array {
		$out = array();
		foreach ( self::allowlist() as $key => $spec ) {
			if ( 'userini' === $spec['group'] ) {
				$out[ $key ] = '';
			}
		}
		$mechanism = $this->php_limits_mechanism();
		$path      = ( 'htaccess' === $mechanism ) ? $this->htaccess_path() : $this->user_ini_path();
		if ( '' === $path || ! is_file( $path ) || ! is_readable( $path ) ) {
			return $out;
		}
		$raw = @file_get_contents( $path );
		if ( false === $raw ) {
			return $out;
		}
		foreach ( $out as $key => $ignored ) {
			$q = preg_quote( $key, '/' );
			if ( 'htaccess' === $mechanism ) {
				if ( 1 === preg_match( '/php_value\s+' . $q . '\s+(\S+)/i', $raw, $m ) ) {
					$out[ $key ] = $m[1];
				}
			} elseif ( 1 === preg_match( '/^\s*' . $q . '\s*=\s*(\S+)/mi', $raw, $m ) ) {
				$out[ $key ] = $m[1];
			}
		}
		return $out;
	}

	/** An honest note about WHEN — and whether — a just-written PHP limit takes effect. */
	private function php_limits_effect_note( string $mechanism ): string {
		if ( 'htaccess' === $mechanism ) {
			return 'Your new upload and memory limits are saved and will apply the next time the site is loaded — nothing else to do. Technical detail for your host: PHP limits were written to .htaccess (Apache mod_php) and take effect on the NEXT request. This needs the site to permit php_value overrides (AllowOverride Options or All); a front web server that caps the request body (nginx client_max_body_size / Apache LimitRequestBody) still applies on top.';
		}
		return 'Your new upload and memory limits are saved and will apply within a few minutes as the server re-reads its settings — nothing else to do. Technical detail for your host: PHP limits were written to .user.ini (FastCGI/PHP-FPM) and take effect on the NEXT request — and up to user_ini.cache_ttl (' . (string) ini_get( 'user_ini.cache_ttl' ) . 's) later while FPM re-reads the file. A php.ini / pool php_admin_value pin or a front web-server body cap, if present, still overrides this.';
	}

	/** Skip reason for a PHP-limits write that could not happen (mechanism-accurate). */
	private function php_limits_skip_reason( string $mechanism, bool $writable ): string {
		if ( 'htaccess' === $mechanism ) {
			return $writable ? 'htaccess-write-failed' : 'htaccess-unwritable';
		}
		return $writable ? 'user-ini-write-failed' : 'user-ini-unwritable';
	}

	/** Manual-remediation hint for an unwritable PHP-limits target (mechanism-accurate). */
	private function php_limits_manual_step( string $mechanism ): string {
		if ( 'htaccess' === $mechanism ) {
			return 'We could not raise your upload and memory limits automatically because a server file is read-only — ask your host or developer to make this change. Technical detail: The .htaccess in the WordPress root is not writable — add a `php_value upload_max_filesize …` block (Apache mod_php) there by hand to apply the PHP limits.';
		}
		return $this->user_ini_manual_step();
	}

	// ── defaults (WordPress-derived, guarded for the harness) ──────────────────

	/** ABSPATH under WordPress, '' outside it. */
	private static function default_abspath(): string {
		return defined( 'ABSPATH' ) ? (string) ABSPATH : '';
	}

	/** ABSPATH.'wp-config.php' under WordPress, '' outside it. */
	private static function default_config_path(): string {
		if ( defined( 'ABSPATH' ) ) {
			return rtrim( (string) ABSPATH, '/\\' ) . '/wp-config.php';
		}
		return '';
	}
}
