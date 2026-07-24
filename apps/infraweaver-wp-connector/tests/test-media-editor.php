<?php
/**
 * IWSL_Media_Editor — the `media.edit` runner (Agent A). This suite pins the
 * CRITICAL security property first: the editor operates BY ATTACHMENT ID and refuses
 * any source whose realpath escapes the uploads base dir (`path-escape`) — even
 * though a request never names a path, a symlink planted in uploads is caught. It
 * also pins the offloaded refusal (editing would orphan the bucket copy), the
 * optimizer-marker invalidation on a successful edit, the op pipeline over an
 * injected WP_Image_Editor, and the strict op validator.
 *
 * Zero-dependency harness: an injected base_dir (real temp dir) + an injected editor
 * factory (a fake WP_Image_Editor), plus guarded $GLOBALS-backed meta fakes.
 */

require_once __DIR__ . '/../includes/class-iwsl-store.php';
require_once __DIR__ . '/../includes/class-iwsl-entitlements.php';
require_once __DIR__ . '/../includes/class-iwsl-media-editor.php';

// ── real filesystem: a contained base dir + an OUTSIDE file (the escape) ───────
$me_base    = sys_get_temp_dir() . '/iwsl_me_base_' . uniqid();
mkdir( $me_base, 0700, true );
$me_inside  = $me_base . '/photo.png';
file_put_contents( $me_inside, str_repeat( 'p', 512 ) );
$me_outside = tempnam( sys_get_temp_dir(), 'iwsl_me_out_' ); // NOT under $me_base.
file_put_contents( $me_outside, str_repeat( 'o', 64 ) );

// id → source path; id → offload meta; id → optimizer meta.
$GLOBALS['me_paths']        = array( 1 => $me_inside, 2 => $me_outside, 3 => $me_inside );
$GLOBALS['me_offload']      = array( 3 => array( 'key' => 'obj/photo.webp' ) );
$GLOBALS['me_optmeta']      = array( 1 => array( 'converter' => 'webp_lossless', 'bytes_in' => 900, 'bytes_out' => 500 ) );
$GLOBALS['me_meta_deletes'] = array();

if ( ! class_exists( 'ME_Fake_Error' ) ) {
	final class ME_Fake_Error {}
}
if ( ! function_exists( 'is_wp_error' ) ) {
	function is_wp_error( $t ) {
		return $t instanceof ME_Fake_Error;
	}
}
if ( ! function_exists( 'get_attached_file' ) ) {
	function get_attached_file( $id, $u = false ) {
		return (string) ( $GLOBALS['me_paths'][ (int) $id ] ?? '' );
	}
}
if ( ! function_exists( 'get_post_meta' ) ) {
	function get_post_meta( $id, $key, $single = false ) {
		if ( '_iwsl_offload' === $key ) {
			return $GLOBALS['me_offload'][ (int) $id ] ?? '';
		}
		if ( '_iwsl_media_optimizer' === $key ) {
			return $GLOBALS['me_optmeta'][ (int) $id ] ?? '';
		}
		return '';
	}
}
if ( ! function_exists( 'delete_post_meta' ) ) {
	function delete_post_meta( $id, $key ) {
		$GLOBALS['me_meta_deletes'][] = array( (int) $id, $key );
		return true;
	}
}

// ── a fake WP_Image_Editor recording its op calls ──────────────────────────────
if ( ! class_exists( 'ME_Fake_Editor' ) ) {
	final class ME_Fake_Editor {
		public $ops    = array();
		public $saved  = false;
		public $mode;
		public function __construct( string $mode ) {
			$this->mode = $mode;
		}
		private function result( string $op ) {
			return ( 'op_error' === $this->mode ) ? new ME_Fake_Error() : true;
		}
		public function rotate( $angle ) {
			$this->ops[] = array( 'rotate', $angle );
			return $this->result( 'rotate' );
		}
		public function flip( $h, $v ) {
			$this->ops[] = array( 'flip', $h, $v );
			return true;
		}
		public function crop( $x, $y, $w, $ht, $dw = null, $dh = null, $c = false ) {
			$this->ops[] = array( 'crop', $x, $y, $w, $ht );
			return true;
		}
		public function resize( $w, $h, $crop = false ) {
			$this->ops[] = array( 'resize', $w, $h );
			return true;
		}
		public function save( $path ) {
			$this->saved = true;
			return array( 'path' => $path );
		}
		public function get_size() {
			return array( 'width' => 640, 'height' => 480 );
		}
	}
}

/** Editor factory keyed off a global mode: 'ok' | 'op_error' | 'unavailable'. */
$me_factory = static function ( string $path ) {
	$mode = $GLOBALS['me_editor_mode'] ?? 'ok';
	if ( 'unavailable' === $mode ) {
		return new ME_Fake_Error();
	}
	return new ME_Fake_Editor( 'op_error' === $mode ? 'op_error' : 'ok' );
};

$ME_NOW = 1900000000000;
function me_ent( int $now, array $flags ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 );
	$store->set( 'entitlements', array_merge( array( 'plus' => true ), $flags ) );
	return new IWSL_Entitlements( $store, static function () use ( $now ): int {
		return $now;
	} );
}

function me_editor( string $base, callable $factory, array $flags ): IWSL_Media_Editor {
	global $ME_NOW;
	return new IWSL_Media_Editor( me_ent( $ME_NOW, $flags ), $base, $factory );
}

$rotate_op = array( array( 'type' => 'rotate', 'angle' => 90 ) );

// ── 1. CRITICAL — path escape refused, editor NEVER constructed ────────────────
$GLOBALS['me_editor_mode'] = 'ok';
$GLOBALS['me_meta_deletes'] = array();
$escape_factory_calls = 0;
$spy_factory = static function ( string $path ) use ( &$escape_factory_calls, $me_factory ) {
	++$escape_factory_calls;
	return $me_factory( $path );
};
$editor  = me_editor( $me_base, $spy_factory, array( 'image_optimization' => true ) );
$escaped = $editor->edit( 2, $rotate_op ); // id 2 → $me_outside, outside the base.
iwsl_assert_same( false, (bool) $escaped['ok'], 'CRITICAL: an out-of-base source is refused' );
iwsl_assert_same( 'path-escape', $escaped['reason'], 'CRITICAL: refusal reason is path-escape (containment gauntlet)' );
iwsl_assert_same( 0, $escape_factory_calls, 'CRITICAL: the image editor was NEVER constructed for an escaping path' );

// ── 2. offloaded asset refused (would orphan the bucket copy) ──────────────────
$off_factory_calls = 0;
$off_spy = static function ( string $path ) use ( &$off_factory_calls, $me_factory ) {
	++$off_factory_calls;
	return $me_factory( $path );
};
$editor2 = me_editor( $me_base, $off_spy, array( 'image_optimization' => true ) );
$offres  = $editor2->edit( 3, $rotate_op ); // id 3 is inside the base BUT offloaded.
iwsl_assert_same( false, (bool) $offres['ok'], 'offload: an offloaded asset edit is refused' );
iwsl_assert_same( 'offloaded-refused', $offres['reason'], 'offload: reason is offloaded-refused (restore first)' );
iwsl_assert_same( 0, $off_factory_calls, 'offload: refused before the editor is constructed' );

// ── 3. success — ops applied, marker cleared, dims returned ────────────────────
$GLOBALS['me_meta_deletes'] = array();
$editor3 = me_editor( $me_base, $me_factory, array( 'image_optimization' => true ) );
$ok      = $editor3->edit( 1, array(
	array( 'type' => 'rotate', 'angle' => 90 ),
	array( 'type' => 'flip', 'axis' => 'horizontal' ),
	array( 'type' => 'crop', 'x' => 0, 'y' => 0, 'width' => 100, 'height' => 100 ),
	array( 'type' => 'scale', 'width' => 640, 'height' => 480 ),
), 'all', false );
iwsl_assert_same( true, (bool) $ok['ok'], 'edit: contained image with valid ops succeeds' );
iwsl_assert_same( true, $ok['edited'], 'edit: reports edited' );
iwsl_assert_same( 640, $ok['width'], 'edit: width from the editor get_size()' );
iwsl_assert_same( 480, $ok['height'], 'edit: height from the editor get_size()' );
iwsl_assert_same( true, $ok['optimizer_cleared'], 'edit: optimizer marker cleared (derivative now stale)' );
iwsl_assert_same( array( array( 1, '_iwsl_media_optimizer' ) ), $GLOBALS['me_meta_deletes'], 'edit: delete_post_meta cleared exactly the optimizer marker' );

// ── 4. editor unavailable + op failure ─────────────────────────────────────────
$GLOBALS['me_editor_mode'] = 'unavailable';
$unavail = me_editor( $me_base, $me_factory, array( 'image_optimization' => true ) )->edit( 1, $rotate_op );
iwsl_assert_same( 'editor-unavailable', $unavail['reason'], 'edit: WP_Error editor → editor-unavailable' );

$GLOBALS['me_editor_mode'] = 'op_error';
$opfail = me_editor( $me_base, $me_factory, array( 'image_optimization' => true ) )->edit( 1, $rotate_op );
iwsl_assert_same( 'op-failed:rotate', $opfail['reason'], 'edit: a failing op is reported op-failed:<type>' );
$GLOBALS['me_editor_mode'] = 'ok';

// ── 5. locked tier → locked envelope ───────────────────────────────────────────
$locked = me_editor( $me_base, $me_factory, array() )->edit( 1, $rotate_op );
iwsl_assert_same( true, (bool) ( $locked['locked'] ?? false ), 'edit: no image_optimization → locked' );
iwsl_assert( isset( $locked['gate'] ), 'edit: locked envelope carries gate' );

// ── 6. validators ──────────────────────────────────────────────────────────────
$E = 'IWSL_Media_Editor';
iwsl_assert( $E::validate_params( (object) array( 'id' => 1, 'ops' => array( (object) array( 'type' => 'rotate', 'angle' => 90 ) ) ) ), 'edit validator: rotate 90 accepted' );
iwsl_assert( $E::validate_params( (object) array( 'id' => 1, 'ops' => array( (object) array( 'type' => 'flip', 'axis' => 'vertical' ) ), 'target' => 'thumbnail', 'regenerate' => true ) ), 'edit validator: flip+target+regenerate accepted' );
iwsl_assert( $E::validate_params( (object) array( 'id' => 1, 'ops' => array( (object) array( 'type' => 'crop', 'x' => 1, 'y' => 2, 'width' => 3, 'height' => 4 ) ) ) ), 'edit validator: crop accepted' );
iwsl_assert( ! $E::validate_params( (object) array( 'id' => 1, 'ops' => array( (object) array( 'type' => 'rotate', 'angle' => 45 ) ) ) ), 'edit validator: non-90 angle refused' );
iwsl_assert( ! $E::validate_params( (object) array( 'id' => 1, 'ops' => array( (object) array( 'type' => 'rotate', 'angle' => 0 ) ) ) ), 'edit validator: zero-angle rotate refused (a no-op)' );
iwsl_assert( ! $E::validate_params( (object) array( 'id' => 1, 'ops' => array( (object) array( 'type' => 'crop', 'x' => 0, 'y' => 0, 'width' => 0, 'height' => 1 ) ) ) ), 'edit validator: crop width 0 refused' );
iwsl_assert( ! $E::validate_params( (object) array( 'id' => 1, 'ops' => array( (object) array( 'type' => 'flip', 'axis' => 'diagonal' ) ) ) ), 'edit validator: bad flip axis refused' );
iwsl_assert( ! $E::validate_params( (object) array( 'id' => 1, 'ops' => array() ) ), 'edit validator: empty ops refused' );
iwsl_assert( ! $E::validate_params( (object) array( 'id' => 1, 'ops' => array_fill( 0, 11, (object) array( 'type' => 'rotate', 'angle' => 90 ) ) ) ), 'edit validator: ops over EDIT_OPS_MAX (10) refused' );
iwsl_assert( ! $E::validate_params( (object) array( 'id' => 1, 'ops' => array( (object) array( 'type' => 'rotate', 'angle' => 90 ) ), 'target' => 'bogus' ) ), 'edit validator: bad target refused' );
iwsl_assert( ! $E::validate_params( (object) array( 'id' => 1, 'ops' => array( (object) array( 'type' => 'rotate', 'angle' => 90, 'extra' => 1 ) ) ) ), 'edit validator: stray op key refused' );
iwsl_assert( ! $E::validate_params( (object) array( 'id' => 0, 'ops' => array( (object) array( 'type' => 'rotate', 'angle' => 90 ) ) ) ), 'edit validator: id < 1 refused' );

// Dimension ceiling (alloc-DoS guard): crop/scale edges capped at MAX_DIMENSION (16383px).
iwsl_assert( $E::validate_params( (object) array( 'id' => 1, 'ops' => array( (object) array( 'type' => 'scale', 'width' => 16383, 'height' => 16383 ) ) ) ), 'edit validator: scale at the 16383 ceiling accepted' );
iwsl_assert( ! $E::validate_params( (object) array( 'id' => 1, 'ops' => array( (object) array( 'type' => 'scale', 'width' => 16384, 'height' => 100 ) ) ) ), 'edit validator: scale width over 16383 refused (alloc-DoS)' );
iwsl_assert( ! $E::validate_params( (object) array( 'id' => 1, 'ops' => array( (object) array( 'type' => 'crop', 'x' => 0, 'y' => 0, 'width' => 100, 'height' => 999999 ) ) ) ), 'edit validator: crop height over 16383 refused (alloc-DoS)' );

@unlink( $me_inside );
@unlink( $me_outside );
@rmdir( $me_base );
