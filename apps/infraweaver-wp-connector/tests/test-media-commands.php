<?php
/**
 * The seven signed media.* commands: registry derivation, strict param validators
 * (the security boundary — stray keys / over-cap id-lists / out-of-vocabulary enums
 * are refused), the STATEMENT-1 locked-gate path for every runner, and the two
 * load-bearing invariants — media.folder mutates TERMS ONLY (attachments stay
 * byte-identical) and media.restore never deletes a local asset that was never
 * offloaded (the "never delete the last remaining copy" guard at the command layer).
 *
 * Runners are exercised through the real command registry via reflection (they are
 * private closures) with hand-built envelopes — no signed fixtures needed for the
 * gate/invariant behavior, which is what this suite pins.
 */

require_once __DIR__ . '/../includes/class-iwsl-store.php';
require_once __DIR__ . '/../includes/class-iwsl-entitlements.php';
require_once __DIR__ . '/../includes/class-iwsl-command-handler.php';
require_once __DIR__ . '/../includes/class-iwsl-feature-switches.php';
require_once __DIR__ . '/../includes/iwsl-ui-help.php';
require_once __DIR__ . '/../includes/class-iwsl-verifier.php';
require_once __DIR__ . '/../includes/class-iwsl-enrollment.php';
require_once __DIR__ . '/../includes/class-iwsl-rotation.php';
require_once __DIR__ . '/../includes/class-iwsl-responder.php';
require_once __DIR__ . '/../includes/class-iwsl-plugin.php';
require_once __DIR__ . '/../includes/class-iwsl-media-converter.php';
require_once __DIR__ . '/../includes/class-iwsl-webp-lossless-converter.php';
require_once __DIR__ . '/../includes/class-iwsl-media-optimizer.php';
require_once __DIR__ . '/../includes/class-iwsl-s3-client.php';
require_once __DIR__ . '/../includes/class-iwsl-media-offload.php';
require_once __DIR__ . '/../includes/class-iwsl-media-folders.php';
require_once __DIR__ . '/../includes/class-iwsl-media-library.php';
require_once __DIR__ . '/../includes/class-iwsl-media-protection.php';
require_once __DIR__ . '/../includes/class-iwsl-media-detail.php';
require_once __DIR__ . '/../includes/class-iwsl-media-editor.php';

$MC_NOW = 1900000000000;

/** @param array<string,bool> $flags */
function mc_plugin( int $now, array $flags ): IWSL_Plugin {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'site_id', 'mc-site' );
	$store->set( 'last_verified_at', $now - 60000 );
	$store->set( 'entitlements', array_merge( array( 'plus' => true ), $flags ) );
	return new IWSL_Plugin(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** The private command registry, method-keyed, via reflection. */
function mc_handlers(): array {
	$ref = new ReflectionMethod( 'IWSL_Plugin', 'command_handlers' );
	$ref->setAccessible( true );
	return $ref->invoke( null );
}

/** Build a signed-shaped envelope for a runner. */
function mc_env( string $method, array $params ): stdClass {
	$e         = new stdClass();
	$e->method = $method;
	$e->nonce  = 'n-' . $method;
	$e->params = (object) $params;
	return $e;
}

$V = 'IWSL_Media_Library';

// ── 1. registry derivation — the seven methods are on the signed allow-list ────

$allowed = IWSL_Plugin::allowed_methods();
foreach ( array( 'media.list', 'media.tree', 'media.status', 'media.optimize', 'media.offload', 'media.restore', 'media.folder' ) as $m ) {
	iwsl_assert( array_key_exists( $m, $allowed ), "registry: {$m} is on the verifier allow-list" );
}
$handlers = mc_handlers();
iwsl_assert_same( array( $V, 'validate_list_params' ), $handlers['media.list']->validator, 'registry: media.list bound to its validator' );
iwsl_assert_same( array( $V, 'validate_folder_params' ), $handlers['media.folder']->validator, 'registry: media.folder bound to its validator' );
iwsl_assert_same( null, $handlers['media.tree']->validator, 'registry: media.tree takes empty params (null validator)' );
iwsl_assert_same( null, $handlers['media.status']->validator, 'registry: media.status takes empty params (null validator)' );
// Read methods must never sign-with-current-kid and never wipe.
foreach ( array( 'media.list', 'media.tree', 'media.status', 'media.optimize', 'media.offload', 'media.restore', 'media.folder' ) as $m ) {
	iwsl_assert( ! $handlers[ $m ]->signs_with_current_kid && ! $handlers[ $m ]->wipes_after, "registry: {$m} neither signs-with-current nor wipes" );
}

// ── 2. validators — accept the canonical shape ────────────────────────────────

iwsl_assert( IWSL_Media_Library::validate_list_params( (object) array() ), 'list validator: empty params (all defaults) accepted' );
iwsl_assert(
	IWSL_Media_Library::validate_list_params(
		(object) array(
			'page' => 1, 'per_page' => 60, 'folder_id' => -1, 'search' => 'logo', 'mime_group' => 'image',
			'tag_ids' => array( 1, 2 ), 'orderby' => 'date', 'order' => 'desc',
			'optimization' => 'unoptimized', 'offload' => 'local', 'include_ids' => true,
		)
	),
	'list validator: full canonical params accepted'
);
iwsl_assert( IWSL_Media_Library::validate_optimize_params( (object) array( 'ids' => array( 1, 2 ) ) ), 'optimize validator: {ids} accepted' );
iwsl_assert( IWSL_Media_Library::validate_offload_params( (object) array( 'op' => 'offload', 'ids' => array( 1 ) ) ), 'offload validator: {op,ids} accepted' );
iwsl_assert( IWSL_Media_Library::validate_restore_params( (object) array( 'ids' => array( 1 ) ) ), 'restore validator: {ids} accepted' );
iwsl_assert( IWSL_Media_Library::validate_folder_params( (object) array( 'op' => 'create', 'name' => 'Products' ) ), 'folder validator: create accepted' );
iwsl_assert( IWSL_Media_Library::validate_folder_params( (object) array( 'op' => 'move', 'id' => 1, 'parent' => 0, 'order' => 3 ) ), 'folder validator: move (with order) accepted' );
iwsl_assert( IWSL_Media_Library::validate_folder_params( (object) array( 'op' => 'assign', 'ids' => array( 1, 2 ), 'folder_id' => 0 ) ), 'folder validator: assign accepted' );
iwsl_assert( IWSL_Media_Library::validate_folder_params( (object) array( 'op' => 'tag', 'ids' => array( 1 ), 'add' => array( 'hero' ), 'remove' => array( 5 ) ) ), 'folder validator: tag accepted' );
iwsl_assert( IWSL_Media_Library::validate_folder_params( (object) array( 'op' => 'tag_rename', 'id' => 3, 'name' => 'Paintings' ) ), 'folder validator: tag_rename accepted' );
iwsl_assert( IWSL_Media_Library::validate_folder_params( (object) array( 'op' => 'tag_delete', 'id' => 3 ) ), 'folder validator: tag_delete accepted' );
iwsl_assert( IWSL_Media_Library::validate_folder_params( (object) array( 'op' => 'tag_merge', 'from' => 3, 'into' => 4 ) ), 'folder validator: tag_merge accepted' );

// ── 3. validators — refuse strays, bad enums, over-cap, wrong types ────────────

iwsl_assert( ! IWSL_Media_Library::validate_list_params( (object) array( 'foo' => 1 ) ), 'list validator: stray key refused' );
iwsl_assert( ! IWSL_Media_Library::validate_list_params( (object) array( 'per_page' => 201 ) ), 'list validator: per_page over PER_PAGE_MAX refused' );
iwsl_assert( ! IWSL_Media_Library::validate_list_params( (object) array( 'page' => 0 ) ), 'list validator: page < 1 refused' );
iwsl_assert( ! IWSL_Media_Library::validate_list_params( (object) array( 'mime_group' => 'bogus' ) ), 'list validator: unknown mime_group refused' );
iwsl_assert( ! IWSL_Media_Library::validate_list_params( (object) array( 'optimization' => 'ineligible' ) ), 'list validator: display-only optimization value refused server-side' );
iwsl_assert( ! IWSL_Media_Library::validate_list_params( (object) array( 'tag_ids' => array( 'a' ) ) ), 'list validator: non-int tag id refused' );

iwsl_assert( ! IWSL_Media_Library::validate_optimize_params( (object) array() ), 'optimize validator: missing ids refused' );
iwsl_assert( ! IWSL_Media_Library::validate_optimize_params( (object) array( 'ids' => array() ) ), 'optimize validator: empty ids refused (bulk target)' );
iwsl_assert( ! IWSL_Media_Library::validate_optimize_params( (object) array( 'ids' => range( 1, 201 ) ) ), 'optimize validator: ids over REQUEST_MAX (200) refused' );
iwsl_assert( ! IWSL_Media_Library::validate_optimize_params( (object) array( 'ids' => array( 1 ), 'mode' => 'bogus' ) ), 'optimize validator: unknown mode refused' );
iwsl_assert( ! IWSL_Media_Library::validate_optimize_params( (object) array( 'ids' => array( 1 ), 'foo' => 1 ) ), 'optimize validator: stray key refused' );

iwsl_assert( ! IWSL_Media_Library::validate_offload_params( (object) array( 'op' => 'bogus', 'ids' => array( 1 ) ) ), 'offload validator: unknown op refused' );
iwsl_assert( ! IWSL_Media_Library::validate_offload_params( (object) array( 'op' => 'offload', 'ids' => range( 1, 51 ) ) ), 'offload validator: ids over BULK_MAX (50) refused' );
iwsl_assert( ! IWSL_Media_Library::validate_offload_params( (object) array( 'ids' => array( 1 ) ) ), 'offload validator: missing op refused' );

iwsl_assert( ! IWSL_Media_Library::validate_restore_params( (object) array( 'ids' => range( 1, 51 ) ) ), 'restore validator: ids over BULK_MAX (50) refused' );
iwsl_assert( ! IWSL_Media_Library::validate_restore_params( (object) array( 'ids' => array() ) ), 'restore validator: empty ids refused' );
iwsl_assert( ! IWSL_Media_Library::validate_restore_params( (object) array( 'ids' => array( 1 ), 'foo' => 1 ) ), 'restore validator: stray key refused' );

iwsl_assert( ! IWSL_Media_Library::validate_folder_params( (object) array( 'op' => 'bogus' ) ), 'folder validator: unknown op refused' );
iwsl_assert( ! IWSL_Media_Library::validate_folder_params( (object) array( 'op' => 'create', 'name' => 'X', 'id' => 1 ) ), 'folder validator: create with stray id refused' );
iwsl_assert( ! IWSL_Media_Library::validate_folder_params( (object) array( 'op' => 'delete' ) ), 'folder validator: delete without id refused' );
iwsl_assert( ! IWSL_Media_Library::validate_folder_params( (object) array( 'op' => 'assign', 'ids' => range( 1, 201 ), 'folder_id' => 0 ) ), 'folder validator: assign ids over cap refused' );
iwsl_assert( ! IWSL_Media_Library::validate_folder_params( (object) array( 'op' => 'tag', 'ids' => array( 1 ), 'add' => array( 5 ) ) ), 'folder validator: tag with non-string add refused' );
iwsl_assert( ! IWSL_Media_Library::validate_folder_params( (object) array( 'op' => 'tag_rename', 'id' => 3 ) ), 'folder validator: tag_rename without name refused' );
iwsl_assert( ! IWSL_Media_Library::validate_folder_params( (object) array( 'op' => 'tag_delete', 'id' => 3, 'name' => 'x' ) ), 'folder validator: tag_delete with stray key refused' );
iwsl_assert( ! IWSL_Media_Library::validate_folder_params( (object) array( 'op' => 'tag_merge', 'from' => 3, 'into' => 3 ) ), 'folder validator: tag_merge into itself refused' );
iwsl_assert( ! IWSL_Media_Library::validate_folder_params( (object) array( 'op' => 'tag_merge', 'from' => 3 ) ), 'folder validator: tag_merge without into refused' );

// ── 4. STATEMENT-1 gate — every runner returns a signed {locked,gate} when locked ─

$locked_plugin = mc_plugin( $MC_NOW, array() ); // linked + fresh heartbeat, NO media flags.
$locked_cases  = array(
	'media.list'     => array(),
	'media.tree'     => array(),
	'media.status'   => array(),
	'media.optimize' => array( 'ids' => array( 1 ) ),
	'media.offload'  => array( 'op' => 'offload', 'ids' => array( 1 ) ),
	'media.restore'  => array( 'ids' => array( 1 ) ),
	'media.folder'   => array( 'op' => 'delete', 'id' => 1 ),
);
$lh = mc_handlers();
foreach ( $locked_cases as $method => $params ) {
	list( $ok, $res ) = $lh[ $method ]->run( $locked_plugin, mc_env( $method, $params ) );
	iwsl_assert_same( true, $ok, "gate: {$method} answers ok (a lock is a valid signed answer)" );
	iwsl_assert_same( true, ! empty( $res['locked'] ), "gate: {$method} reports locked" );
	iwsl_assert( isset( $res['gate'] ) && is_array( $res['gate'] ), "gate: {$method} carries the gate reason for the console" );
}

// ── 5. INVARIANT — media.folder delete touches TERMS ONLY ──────────────────────
// Compact folder-term store + a SACRED attachment record that must be byte-identical
// after the delete, plus a canary asserting no attachment-delete function is called.

$GLOBALS['mc_terms']            = array();
$GLOBALS['mc_deleted_tax']      = array();   // taxonomy of every wp_delete_term call.
$GLOBALS['mc_attachment_delete_called'] = false;
$GLOBALS['mc_sacred_attachment'] = array( 'ID' => 4242, 'file' => '/uploads/keepme.png', 'bytes' => 123456, 'guid' => 'https://site/keepme.png' );

if ( ! class_exists( 'MC_Term' ) ) {
	final class MC_Term {
		public $term_id;
		public $name;
		public $slug;
		public $taxonomy;
		public $parent;
		public $count;
		public function __construct( int $id, string $name, string $tax, int $parent, int $count ) {
			$this->term_id  = $id;
			$this->name     = $name;
			$this->slug     = 'f-' . $id;
			$this->taxonomy = $tax;
			$this->parent   = $parent;
			$this->count    = $count;
		}
	}
}
if ( ! class_exists( 'MC_Fake_Error' ) ) {
	final class MC_Fake_Error {}
}
if ( ! function_exists( 'is_wp_error' ) ) {
	function is_wp_error( $t ) {
		return $t instanceof MC_Fake_Error;
	}
}
if ( ! function_exists( 'get_term' ) ) {
	function get_term( $id, $tax = '' ) {
		$t = $GLOBALS['mc_terms'][ (int) $id ] ?? null;
		if ( null === $t ) {
			return null;
		}
		if ( '' !== (string) $tax && $t->taxonomy !== (string) $tax ) {
			return null;
		}
		return $t;
	}
}
if ( ! function_exists( 'get_terms' ) ) {
	function get_terms( $args = array() ) {
		$tax = is_array( $args ) ? (string) ( $args['taxonomy'] ?? '' ) : '';
		$out = array();
		foreach ( $GLOBALS['mc_terms'] as $t ) {
			if ( '' === $tax || $t->taxonomy === $tax ) {
				$out[] = $t;
			}
		}
		return $out;
	}
}
if ( ! function_exists( 'wp_delete_term' ) ) {
	function wp_delete_term( $id, $tax = '' ) {
		$id = (int) $id;
		if ( ! isset( $GLOBALS['mc_terms'][ $id ] ) ) {
			return false;
		}
		$GLOBALS['mc_deleted_tax'][] = (string) $tax; // record: must always be the folder taxonomy.
		unset( $GLOBALS['mc_terms'][ $id ] );
		return true;
	}
}
if ( ! function_exists( 'wp_delete_attachment' ) ) {
	function wp_delete_attachment( $id, $force = false ) {
		$GLOBALS['mc_attachment_delete_called'] = true; // canary — must never fire.
		return false;
	}
}
if ( ! function_exists( 'get_term_meta' ) ) {
	function get_term_meta( $id, $key = '', $single = false ) {
		return $single ? '' : array();
	}
}
if ( ! function_exists( 'update_term_meta' ) ) {
	function update_term_meta( $id, $key, $value ) {
		return true;
	}
}

// Seed: Products(900) with a child Sub(901); one file filed in each.
$GLOBALS['mc_terms'] = array(
	900 => new MC_Term( 900, 'Products', 'iwsl_media_folder', 0, 1 ),
	901 => new MC_Term( 901, 'Sub', 'iwsl_media_folder', 900, 1 ),
);
$sacred_before = $GLOBALS['mc_sacred_attachment'];

$folder_plugin = mc_plugin( $MC_NOW, array( 'media_folders' => true ) );
$fh            = mc_handlers();
list( $fok, $fres ) = $fh['media.folder']->run( $folder_plugin, mc_env( 'media.folder', array( 'op' => 'delete', 'id' => 900 ) ) );

iwsl_assert_same( true, $fok, 'folder delete: runner answers ok' );
iwsl_assert_same( false, (bool) ( $fres['locked'] ?? true ), 'folder delete: not locked (media_folders granted)' );
iwsl_assert_same( true, (bool) ( $fres['result']['ok'] ?? false ), 'folder delete: delegated delete_folder succeeded' );
iwsl_assert_same( 2, (int) ( $fres['result']['folders_removed'] ?? 0 ), 'folder delete: folder + descendant removed (terms)' );
iwsl_assert( array() !== $GLOBALS['mc_deleted_tax'], 'folder delete: wp_delete_term was actually exercised' );
$only_folder_tax = array( 'iwsl_media_folder' ) === array_values( array_unique( $GLOBALS['mc_deleted_tax'] ) );
iwsl_assert( $only_folder_tax, 'INVARIANT: every deletion targeted the folder TAXONOMY, never an attachment' );
iwsl_assert_same( false, $GLOBALS['mc_attachment_delete_called'], 'INVARIANT: no attachment-delete function was ever called' );
iwsl_assert_same( $sacred_before, $GLOBALS['mc_sacred_attachment'], 'INVARIANT: the attachment record is byte-identical after a folder delete' );

// ── 5b. INVARIANT — media.folder tag_delete is a TERMS-ONLY tag-vocabulary op ───
// A NEW op on the SAME signed method: it must delete a tag TERM (not a folder, never
// an attachment). Seed a tag term, run the runner arm, and re-assert the fences.
$GLOBALS['mc_terms'][950]     = new MC_Term( 950, 'oldtag', 'iwsl_media_tag', 0, 3 );
$GLOBALS['mc_deleted_tax']    = array();
$sacred_before_tag           = $GLOBALS['mc_sacred_attachment'];
list( $tok, $tres ) = $fh['media.folder']->run( $folder_plugin, mc_env( 'media.folder', array( 'op' => 'tag_delete', 'id' => 950 ) ) );
iwsl_assert_same( true, $tok, 'tag_delete runner: answers ok' );
iwsl_assert_same( 'tag_delete', (string) ( $tres['op'] ?? '' ), 'tag_delete runner: op echoed back' );
iwsl_assert_same( true, (bool) ( $tres['result']['ok'] ?? false ), 'tag_delete runner: delegated delete_tag succeeded' );
iwsl_assert_same( array( 'iwsl_media_tag' ), array_values( array_unique( $GLOBALS['mc_deleted_tax'] ) ), 'INVARIANT: tag_delete removed a TAG TERM, never an attachment' );
iwsl_assert_same( false, $GLOBALS['mc_attachment_delete_called'], 'INVARIANT: tag_delete never called an attachment-delete function' );
iwsl_assert_same( $sacred_before_tag, $GLOBALS['mc_sacred_attachment'], 'INVARIANT: attachment record byte-identical after tag_delete' );

// ── 6. INVARIANT — media.restore never deletes a never-offloaded local copy ────
// With no _iwsl_offload meta, is_offloaded() is false, so the runner classifies the
// asset 'not-offloaded' and takes NO deletion path (the last local copy is safe).

if ( ! function_exists( 'get_post_meta' ) ) {
	function get_post_meta( $id, $key = '', $single = false ) {
		return $single ? '' : array(); // nothing offloaded → is_offloaded() false.
	}
}
$restore_plugin = mc_plugin( $MC_NOW, array( 'image_optimization' => true ) );
$rh             = mc_handlers();
list( $rok, $rres ) = $rh['media.restore']->run( $restore_plugin, mc_env( 'media.restore', array( 'ids' => array( 55, 56 ) ) ) );
iwsl_assert_same( true, $rok, 'restore: runner answers ok' );
iwsl_assert_same( false, (bool) ( $rres['locked'] ?? true ), 'restore: not locked (image_optimization granted)' );
iwsl_assert_same( 2, (int) $rres['summary']['total'], 'restore: both ids processed' );
iwsl_assert_same( 0, (int) $rres['summary']['ok'], 'restore: nothing restored (nothing was offloaded)' );
iwsl_assert_same( 'not-offloaded', (string) $rres['results'][0]['reason'], 'INVARIANT: a never-offloaded asset is a safe no-op, not a deletion' );

// ── 7. media VIEWER surface (Agent A) — registry + gate + confirm fence ────────
// The six click-to-open viewer methods are on the signed allow-list, bound to their
// strict validators, and — like every media runner — answer a signed { locked, gate }
// on a tier that does not grant them. media.delete's confirm fence lives at the
// command layer too (the registry binds it to a validator that refuses anything but
// a literal confirm:true), so a destructive command can never dispatch unconfirmed.

$viewer_methods = array( 'media.get', 'media.updateMeta', 'media.edit', 'media.protect', 'media.delete', 'media.usage' );
$allowed_v      = IWSL_Plugin::allowed_methods();
foreach ( $viewer_methods as $m ) {
	iwsl_assert( array_key_exists( $m, $allowed_v ), "registry: {$m} is on the verifier allow-list" );
}
$vh = mc_handlers();
iwsl_assert_same( array( 'IWSL_Media_Detail', 'validate_get_params' ), $vh['media.get']->validator, 'registry: media.get bound to its validator' );
iwsl_assert_same( array( 'IWSL_Media_Detail', 'validate_update_params' ), $vh['media.updateMeta']->validator, 'registry: media.updateMeta bound to its validator' );
iwsl_assert_same( array( 'IWSL_Media_Editor', 'validate_params' ), $vh['media.edit']->validator, 'registry: media.edit bound to the editor validator' );
iwsl_assert_same( array( 'IWSL_Media_Protection', 'validate_protect_params' ), $vh['media.protect']->validator, 'registry: media.protect bound to the protection validator' );
iwsl_assert_same( array( 'IWSL_Media_Detail', 'validate_delete_params' ), $vh['media.delete']->validator, 'registry: media.delete bound to the CONFIRM-fenced validator' );
iwsl_assert_same( array( 'IWSL_Media_Detail', 'validate_usage_params' ), $vh['media.usage']->validator, 'registry: media.usage bound to its validator' );
foreach ( $viewer_methods as $m ) {
	iwsl_assert( ! $vh[ $m ]->signs_with_current_kid && ! $vh[ $m ]->wipes_after, "registry: {$m} neither signs-with-current nor wipes" );
}

// The confirm fence AT THE COMMAND LAYER: the validator the registry bound refuses
// an unconfirmed delete before any runner (or attachment) is ever reached.
$del_validator = $vh['media.delete']->validator;
iwsl_assert( is_callable( $del_validator ), 'confirm-fence: media.delete carries a callable validator' );
iwsl_assert( true === call_user_func( $del_validator, (object) array( 'id' => 9, 'confirm' => true ) ), 'confirm-fence: media.delete validator accepts confirm:true' );
iwsl_assert( false === call_user_func( $del_validator, (object) array( 'id' => 9 ) ), 'confirm-fence: media.delete validator REFUSES a confirm-less delete' );
iwsl_assert( false === call_user_func( $del_validator, (object) array( 'id' => 9, 'confirm' => false ) ), 'confirm-fence: media.delete validator REFUSES confirm:false' );

// STATEMENT-1 gate — a no-media-flag site answers a signed lock for every viewer method.
$viewer_locked_cases = array(
	'media.get'        => array( 'id' => 5 ),
	'media.updateMeta' => array( 'id' => 5, 'expect_modified' => 't', 'alt' => 'x' ),
	'media.edit'       => array( 'id' => 5, 'ops' => array( (object) array( 'type' => 'rotate', 'angle' => 90 ) ) ),
	'media.protect'    => array( 'ids' => array( 5 ), 'protected' => true ),
	'media.delete'     => array( 'id' => 5, 'confirm' => true ),
	'media.usage'      => array( 'id' => 5 ),
);
$vlp = mc_plugin( $MC_NOW, array() ); // linked + fresh heartbeat, NO media flags.
$vlh = mc_handlers();
foreach ( $viewer_locked_cases as $method => $params ) {
	list( $vok, $vres ) = $vlh[ $method ]->run( $vlp, mc_env( $method, $params ) );
	iwsl_assert_same( true, $vok, "gate: {$method} answers ok (a lock is a valid signed answer)" );
	iwsl_assert_same( true, ! empty( $vres['locked'] ), "gate: {$method} reports locked on a no-tier site" );
	iwsl_assert( isset( $vres['gate'] ) && is_array( $vres['gate'] ), "gate: {$method} carries the gate reason for the console" );
}
