<?php
/**
 * Config editor (IWSL_Config_Editor): the SECURE allow-list editor for wp-config
 * constants + PHP .user.ini limits.
 *
 * Runs under the zero-dependency harness: the editor takes an injected ABSPATH
 * (a temp dir) and an injected wp-config path (a temp file), so its LOCAL
 * validation, allow-list and managed-block logic are authoritative — exactly as
 * outside WordPress. Every filesystem write here goes to a fresh temp dir; no
 * real wp-config is ever touched.
 */

// ── fixtures ──────────────────────────────────────────────────────────────────

function iwsl_cfg_tempdir(): string {
	$dir = sys_get_temp_dir() . '/iwsl-cfg-' . bin2hex( random_bytes( 6 ) );
	mkdir( $dir, 0700, true );
	return $dir;
}

/** Write a realistic minimal wp-config.php and return its path. */
function iwsl_cfg_write_config( string $dir ): string {
	$path = $dir . '/wp-config.php';
	$body = "<?php\n"
		. "\$table_prefix = 'wp_';\n"
		. "define( 'DB_NAME', 'wp' );\n"
		. "/* That's all, stop editing! Happy publishing. */\n"
		. "require_once ABSPATH . 'wp-settings.php';\n";
	file_put_contents( $path, $body );
	return $path;
}

// ── 1. Allow-list: an unknown key is rejected, never written ───────────────────

$dir = iwsl_cfg_tempdir();
$cfg = iwsl_cfg_write_config( $dir );
$ed  = new IWSL_Config_Editor( $dir . '/', $cfg );

$r = $ed->apply( array( 'EVIL_KEY' => 'anything', 'WP_MEMORY_LIMIT' => '256M' ) );
iwsl_assert_same( true, $r['ok'], 'allow-list: apply ok' );
iwsl_assert( isset( $r['skipped']['EVIL_KEY'] ) && 'not-allowed' === $r['skipped']['EVIL_KEY'], 'allow-list: unknown key rejected as not-allowed' );
iwsl_assert( ! in_array( 'EVIL_KEY', $r['applied'], true ), 'allow-list: unknown key never applied' );
iwsl_assert( in_array( 'WP_MEMORY_LIMIT', $r['applied'], true ), 'allow-list: valid sibling still applied' );
$after = (string) file_get_contents( $cfg );
iwsl_assert( false === strpos( $after, 'EVIL_KEY' ), 'allow-list: unknown key never written to wp-config' );

// ── 2. Size validator: 256M valid; "256; evil" rejected (never written) ────────

$r = $ed->apply( array( 'WP_MEMORY_LIMIT' => '256M' ) );
iwsl_assert( in_array( 'WP_MEMORY_LIMIT', $r['applied'], true ), 'size: 256M is valid → applied' );
$after = (string) file_get_contents( $cfg );
iwsl_assert( false !== strpos( $after, "define( 'WP_MEMORY_LIMIT', '256M' );" ), 'size: 256M written as a quoted define literal' );

$r = $ed->apply( array( 'WP_MEMORY_LIMIT' => '256; evil' ) );
iwsl_assert( isset( $r['skipped']['WP_MEMORY_LIMIT'] ) && 'invalid-size' === $r['skipped']['WP_MEMORY_LIMIT'], 'size: "256; evil" rejected as invalid-size' );
iwsl_assert( ! in_array( 'WP_MEMORY_LIMIT', $r['applied'], true ), 'size: invalid value not applied' );
$after = (string) file_get_contents( $cfg );
iwsl_assert( false === strpos( $after, 'evil' ), 'size: malicious value never reaches wp-config' );

// lowercase suffix normalizes to uppercase.
$r = $ed->apply( array( 'WP_MEMORY_LIMIT' => '128m' ) );
$after = (string) file_get_contents( $cfg );
iwsl_assert( false !== strpos( $after, "define( 'WP_MEMORY_LIMIT', '128M' );" ), 'size: "128m" normalized to 128M' );

// ── 3. Bool coercion: 1/on → true, 0/absent → false ────────────────────────────

$dir2 = iwsl_cfg_tempdir();
$cfg2 = iwsl_cfg_write_config( $dir2 );
$ed2  = new IWSL_Config_Editor( $dir2 . '/', $cfg2 );

$r = $ed2->apply( array( 'WP_DEBUG' => '1', 'DISALLOW_FILE_EDIT' => '0' ) );
iwsl_assert( in_array( 'WP_DEBUG', $r['applied'], true ), 'bool: WP_DEBUG applied' );
iwsl_assert( in_array( 'DISALLOW_FILE_EDIT', $r['applied'], true ), 'bool: DISALLOW_FILE_EDIT applied' );
$after = (string) file_get_contents( $cfg2 );
iwsl_assert( false !== strpos( $after, "define( 'WP_DEBUG', true );" ), 'bool: "1" coerced to true' );
iwsl_assert( false !== strpos( $after, "define( 'DISALLOW_FILE_EDIT', false );" ), 'bool: "0" coerced to false' );

$r = $ed2->apply( array( 'WP_DEBUG_LOG' => 'on' ) );
$after = (string) file_get_contents( $cfg2 );
iwsl_assert( false !== strpos( $after, "define( 'WP_DEBUG_LOG', true );" ), 'bool: "on" coerced to true' );

// ── 4. Int range: AUTOSAVE_INTERVAL min=10 rejects 5; EMPTY_TRASH_DAYS accepts 0 ─

$r = $ed2->apply( array( 'AUTOSAVE_INTERVAL' => '5' ) );
iwsl_assert( isset( $r['skipped']['AUTOSAVE_INTERVAL'] ) && 'below-min' === $r['skipped']['AUTOSAVE_INTERVAL'], 'int: AUTOSAVE_INTERVAL below 10 rejected' );

$r = $ed2->apply( array( 'AUTOSAVE_INTERVAL' => 'abc' ) );
iwsl_assert( isset( $r['skipped']['AUTOSAVE_INTERVAL'] ) && 'invalid-int' === $r['skipped']['AUTOSAVE_INTERVAL'], 'int: non-numeric AUTOSAVE_INTERVAL rejected' );

$r = $ed2->apply( array( 'EMPTY_TRASH_DAYS' => '0' ) );
iwsl_assert( in_array( 'EMPTY_TRASH_DAYS', $r['applied'], true ), 'int: EMPTY_TRASH_DAYS 0 (min 0) accepted' );

// int_or_false: blank → false; a number → int.
$r = $ed2->apply( array( 'WP_POST_REVISIONS' => '' ) );
iwsl_assert( in_array( 'WP_POST_REVISIONS', $r['applied'], true ), 'int_or_false: blank coerces to false and applies' );
$after = (string) file_get_contents( $cfg2 );
iwsl_assert( false !== strpos( $after, "define( 'WP_POST_REVISIONS', false );" ), 'int_or_false: blank written as false' );
$r = $ed2->apply( array( 'WP_POST_REVISIONS' => '7' ) );
$after = (string) file_get_contents( $cfg2 );
iwsl_assert( false !== strpos( $after, "define( 'WP_POST_REVISIONS', 7 );" ), 'int_or_false: 7 written as an int literal' );

// ── 5. Managed marker block is idempotent (applying twice never duplicates) ─────

$dir3 = iwsl_cfg_tempdir();
$cfg3 = iwsl_cfg_write_config( $dir3 );
$ed3  = new IWSL_Config_Editor( $dir3 . '/', $cfg3 );
$in   = array(
	'WP_MEMORY_LIMIT'     => '256M',
	'WP_POST_REVISIONS'   => '5',
	'upload_max_filesize' => '64M',
	'post_max_size'       => '64M',
	'max_execution_time'  => '300',
);
$ed3->apply( $in );
$ed3->apply( $in ); // apply the SAME input twice.

$after_cfg = (string) file_get_contents( $cfg3 );
iwsl_assert_same( 1, substr_count( $after_cfg, IWSL_Config_Editor::WPCONFIG_BEGIN ), 'idempotent: exactly one wp-config managed block after two applies' );
iwsl_assert_same( 1, substr_count( $after_cfg, IWSL_Config_Editor::WPCONFIG_END ), 'idempotent: exactly one wp-config END marker' );
iwsl_assert_same( 1, substr_count( $after_cfg, "define( 'WP_MEMORY_LIMIT', '256M' );" ), 'idempotent: WP_MEMORY_LIMIT define not duplicated' );
iwsl_assert_same( 1, substr_count( $after_cfg, "define( 'WP_POST_REVISIONS', 5 );" ), 'idempotent: WP_POST_REVISIONS define not duplicated' );
iwsl_assert( false !== strpos( $after_cfg, "\$table_prefix = 'wp_';" ), 'idempotent: original wp-config content preserved' );
iwsl_assert( false !== strpos( $after_cfg, 'stop editing' ), 'idempotent: stop-editing marker preserved' );
iwsl_assert( is_file( $cfg3 . '.iwsl.bak' ), 'idempotent: wp-config backup written' );

$ini_path = $dir3 . '/.user.ini';
iwsl_assert( is_file( $ini_path ), 'idempotent: .user.ini created' );
$after_ini = (string) file_get_contents( $ini_path );
iwsl_assert_same( 1, substr_count( $after_ini, IWSL_Config_Editor::USERINI_BEGIN ), 'idempotent: exactly one .user.ini managed block after two applies' );
iwsl_assert_same( 1, substr_count( $after_ini, 'upload_max_filesize = 64M' ), 'idempotent: upload_max_filesize not duplicated' );
iwsl_assert_same( 1, substr_count( $after_ini, 'post_max_size = 64M' ), 'idempotent: post_max_size not duplicated' );
iwsl_assert_same( 1, substr_count( $after_ini, 'max_execution_time = 300' ), 'idempotent: max_execution_time not duplicated' );

// ── 6. current(): reads effective values (ini via ini_get, constants via slot) ──

$cur = $ed3->current();
iwsl_assert( array_key_exists( 'upload_max_filesize', $cur ), 'current: exposes upload_max_filesize (ini)' );
iwsl_assert( array_key_exists( 'WP_MEMORY_LIMIT', $cur ), 'current: exposes WP_MEMORY_LIMIT (constant slot)' );
iwsl_assert_same( false, $cur['WP_DEBUG'], 'current: undefined bool constant reports false' );
iwsl_assert_same( '', $cur['WP_MAX_MEMORY_LIMIT'], 'current: undefined size constant reports empty string' );

// ── 7. Fail-safe: unwritable targets → nothing written, ok=true, manual_step ────

$dir4    = iwsl_cfg_tempdir();
$missing = $dir4 . '/no-such-subdir/wp-config.php'; // parent dir absent → unwritable
$ed4     = new IWSL_Config_Editor( $dir4 . '/no-such-subdir/', $missing );

$r = $ed4->apply( array( 'WP_MEMORY_LIMIT' => '256M', 'upload_max_filesize' => '64M' ) );
iwsl_assert_same( true, $r['ok'], 'fail-safe: apply still ok when both targets unwritable (no fatal)' );
iwsl_assert_same( false, $r['wp_config_writable'], 'fail-safe: wp_config_writable=false' );
iwsl_assert_same( false, $r['user_ini_writable'], 'fail-safe: user_ini_writable=false' );
iwsl_assert( empty( $r['applied'] ), 'fail-safe: nothing applied when unwritable' );
iwsl_assert( isset( $r['skipped']['WP_MEMORY_LIMIT'] ) && 'wp-config-unwritable' === $r['skipped']['WP_MEMORY_LIMIT'], 'fail-safe: wp-config key skipped as unwritable' );
iwsl_assert( isset( $r['skipped']['upload_max_filesize'] ) && 'user-ini-unwritable' === $r['skipped']['upload_max_filesize'], 'fail-safe: .user.ini key skipped as unwritable' );
iwsl_assert( isset( $r['manual_step'] ) && '' !== (string) $r['manual_step'], 'fail-safe: manual_step surfaced' );
iwsl_assert( ! is_file( $missing ), 'fail-safe: no wp-config written to an unwritable path' );
