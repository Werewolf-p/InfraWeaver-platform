<?php
/**
 * One-Click Duplicate (gate flag `duplicate_post`): the IWSL_Duplicate_Post engine.
 *
 * Runs under the zero-dependency harness. The engine's core, duplicate(), accepts
 * an already-resolved post object, so the WordPress-poisoned readers (get_post /
 * get_post_meta / get_post_field) are never touched — the test drives the engine
 * with plain stdClass fixtures. Only the WRITE surface the engine actually calls is
 * stubbed against in-memory registries: wp_insert_post, the taxonomy trio,
 * get_post_custom / add_post_meta, plus current_user_can + wp_slash /
 * maybe_unserialize. None of these collide with the other suites' stubs.
 *
 * The gate fixtures reuse the entitlement store so a single flip re-locks instantly.
 */

// ── in-memory WordPress stubs (harness only; write surface only) ──────────────

$GLOBALS['iwsl_dp_posts']         = array(); // new id => inserted post object
$GLOBALS['iwsl_dp_next_id']       = 1000;
$GLOBALS['iwsl_dp_taxonomies']    = array(); // post_type => [ tax names ]
$GLOBALS['iwsl_dp_terms']         = array(); // "sourceId|tax" => [ term ids ]
$GLOBALS['iwsl_dp_set_terms']     = array(); // new id => [ tax => ids set ]
$GLOBALS['iwsl_dp_custom']        = array(); // source id => [ key => [ values ] ]
$GLOBALS['iwsl_dp_meta']          = array(); // new id => [ key => [ values added ] ]
$GLOBALS['iwsl_dp_can']           = true;    // current_user_can toggle
$GLOBALS['iwsl_dp_insert_return'] = null;    // when set, wp_insert_post returns it (e.g. 0)

function iwsl_dp_reset(): void {
	$GLOBALS['iwsl_dp_posts']         = array();
	$GLOBALS['iwsl_dp_next_id']       = 1000;
	$GLOBALS['iwsl_dp_taxonomies']    = array();
	$GLOBALS['iwsl_dp_terms']         = array();
	$GLOBALS['iwsl_dp_set_terms']     = array();
	$GLOBALS['iwsl_dp_custom']        = array();
	$GLOBALS['iwsl_dp_meta']          = array();
	$GLOBALS['iwsl_dp_can']           = true;
	$GLOBALS['iwsl_dp_insert_return'] = null;
}

if ( ! function_exists( 'wp_insert_post' ) ) {
	function wp_insert_post( $postarr, $wp_error = false ) {
		if ( null !== $GLOBALS['iwsl_dp_insert_return'] ) {
			return $GLOBALS['iwsl_dp_insert_return'];
		}
		$id                              = ++$GLOBALS['iwsl_dp_next_id'];
		$GLOBALS['iwsl_dp_posts'][ $id ] = (object) $postarr;
		return $id;
	}
}
if ( ! function_exists( 'get_object_taxonomies' ) ) {
	function get_object_taxonomies( $type, $output = 'names' ) {
		return $GLOBALS['iwsl_dp_taxonomies'][ (string) $type ] ?? array();
	}
}
if ( ! function_exists( 'wp_get_object_terms' ) ) {
	function wp_get_object_terms( $id, $tax, $args = array() ) {
		return $GLOBALS['iwsl_dp_terms'][ $id . '|' . $tax ] ?? array();
	}
}
if ( ! function_exists( 'wp_set_object_terms' ) ) {
	function wp_set_object_terms( $id, $terms, $tax, $append = false ) {
		$GLOBALS['iwsl_dp_set_terms'][ $id ][ $tax ] = $terms;
		return $terms;
	}
}
if ( ! function_exists( 'get_post_custom' ) ) {
	function get_post_custom( $id ) {
		return $GLOBALS['iwsl_dp_custom'][ $id ] ?? array();
	}
}
if ( ! function_exists( 'add_post_meta' ) ) {
	function add_post_meta( $id, $key, $value, $unique = false ) {
		$GLOBALS['iwsl_dp_meta'][ $id ][ $key ][] = $value;
		return true;
	}
}
if ( ! function_exists( 'current_user_can' ) ) {
	function current_user_can( $cap, ...$args ) {
		return ! empty( $GLOBALS['iwsl_dp_can'] );
	}
}
if ( ! function_exists( 'wp_slash' ) ) {
	function wp_slash( $value ) {
		return $value; // identity — keeps fixture assertions byte-exact.
	}
}
if ( ! function_exists( 'maybe_unserialize' ) ) {
	function maybe_unserialize( $value ) {
		if ( is_string( $value ) ) {
			$un = @unserialize( $value ); // phpcs:ignore
			if ( false !== $un || 'b:0;' === $value ) {
				return $un;
			}
		}
		return $value;
	}
}

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Unlocked gate: active + fresh heartbeat + duplicate_post flag. */
function iwsl_dp_unlocked_entitlements( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 ); // 1 min ago — fresh
	$store->set( 'entitlements', array( 'plus' => true, 'duplicate_post' => true ) );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** A source post object with sensible defaults, overridable per field. */
function iwsl_dp_post( int $id, array $over = array() ): object {
	return (object) array_merge(
		array(
			'ID'             => $id,
			'post_title'     => 'Hello World',
			'post_content'   => 'Body content.',
			'post_excerpt'   => 'Short excerpt.',
			'post_type'      => 'post',
			'post_status'    => 'publish',
			'post_parent'    => 0,
			'menu_order'     => 0,
			'comment_status' => 'open',
			'ping_status'    => 'open',
		),
		$over
	);
}

$DP_NOW = 12000000;

// ── 1. Gate blocks: duplicate_post flag ABSENT → locked, no insert ────────────

iwsl_dp_reset();
$store = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $DP_NOW - 60000 );
$store->set( 'entitlements', array( 'plus' => true ) ); // duplicate_post absent
$ent = new IWSL_Entitlements( $store, static function () use ( $DP_NOW ): int {
	return $DP_NOW; } );
$dp = new IWSL_Duplicate_Post( $ent );
$r  = $dp->duplicate( iwsl_dp_post( 5 ) );
iwsl_assert_same( false, $r['ok'], 'gate blocks (absent flag): ok=false' );
iwsl_assert_same( 'entitlement-locked', $r['reason'], 'gate blocks (absent flag): entitlement-locked' );
iwsl_assert_same( 0, count( $GLOBALS['iwsl_dp_posts'] ), 'gate blocks (absent flag): NO post inserted' );

// ── 2. Gate blocks: state != active → locked, no insert ───────────────────────

iwsl_dp_reset();
$store = new IWSL_Memory_Store();
$store->set( 'state', 'pending' );
$store->set( 'last_verified_at', $DP_NOW - 60000 );
$store->set( 'entitlements', array( 'duplicate_post' => true ) );
$ent = new IWSL_Entitlements( $store, static function () use ( $DP_NOW ): int {
	return $DP_NOW; } );
$dp = new IWSL_Duplicate_Post( $ent );
$r  = $dp->duplicate( iwsl_dp_post( 5 ) );
iwsl_assert_same( 'entitlement-locked', $r['reason'], 'gate blocks (not active): entitlement-locked despite flag' );
iwsl_assert_same( 0, count( $GLOBALS['iwsl_dp_posts'] ), 'gate blocks (not active): NO post inserted' );

// ── 3. Gate blocks: stale heartbeat → locked, no insert ───────────────────────

iwsl_dp_reset();
$store = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $DP_NOW - 10800000 ); // 3h — stale
$store->set( 'entitlements', array( 'duplicate_post' => true ) );
$ent = new IWSL_Entitlements( $store, static function () use ( $DP_NOW ): int {
	return $DP_NOW; } );
$dp = new IWSL_Duplicate_Post( $ent );
$r  = $dp->duplicate( iwsl_dp_post( 5 ) );
iwsl_assert_same( 'entitlement-locked', $r['reason'], 'gate blocks (stale heartbeat): entitlement-locked despite flag' );
iwsl_assert_same( 0, count( $GLOBALS['iwsl_dp_posts'] ), 'gate blocks (stale heartbeat): NO post inserted' );

// ── 4. Unlock → duplication proceeds (fields + taxonomies + meta) ─────────────

iwsl_dp_reset();
$GLOBALS['iwsl_dp_taxonomies']['post'] = array( 'category', 'post_tag' );
$GLOBALS['iwsl_dp_terms']['5|category'] = array( 3, 7 );
$GLOBALS['iwsl_dp_terms']['5|post_tag'] = array(); // empty → not counted as copied
$GLOBALS['iwsl_dp_custom'][5]           = array(
	'color'      => array( 'blue' ),
	'_edit_lock' => array( '123:1' ),          // internal — must be skipped
	'_edit_last' => array( '1' ),              // internal — must be skipped
	'sizes'      => array( serialize( array( 'a', 'b' ) ) ),
);
$dp = new IWSL_Duplicate_Post( iwsl_dp_unlocked_entitlements( $DP_NOW ) );
$r  = $dp->duplicate( iwsl_dp_post( 5, array( 'post_title' => 'Original', 'post_content' => 'The body', 'post_excerpt' => 'The excerpt' ) ) );

iwsl_assert_same( true, $r['ok'], 'unlock: duplication ok' );
iwsl_assert( isset( $r['new_id'] ) && $r['new_id'] > 0, 'unlock: a new id is reported' );
$new_id = (int) $r['new_id'];
iwsl_assert( isset( $GLOBALS['iwsl_dp_posts'][ $new_id ] ), 'unlock: the new draft exists in the registry' );
$new = $GLOBALS['iwsl_dp_posts'][ $new_id ];
iwsl_assert_same( 'Original (copy)', $new->post_title, 'unlock: title copied with " (copy)" suffix' );
iwsl_assert_same( 'draft', $new->post_status, 'unlock: new post is a draft' );
iwsl_assert_same( 'The body', $new->post_content, 'unlock: content copied' );
iwsl_assert_same( 'The excerpt', $new->post_excerpt, 'unlock: excerpt copied' );
iwsl_assert_same( 'post', $new->post_type, 'unlock: post_type copied' );
iwsl_assert_same( 5, $r['source_id'], 'unlock: source id reported (original id untouched)' );

iwsl_assert_same( 1, $r['terms_copied'], 'unlock: one taxonomy with terms copied (empty tag skipped)' );
iwsl_assert_same( array( 3, 7 ), $GLOBALS['iwsl_dp_set_terms'][ $new_id ]['category'], 'unlock: category term ids set on the copy' );
iwsl_assert( ! isset( $GLOBALS['iwsl_dp_set_terms'][ $new_id ]['post_tag'] ), 'unlock: empty taxonomy not set' );

iwsl_assert_same( 2, $r['meta_copied'], 'unlock: two custom fields copied (internal keys skipped)' );
iwsl_assert_same( array( 'blue' ), $GLOBALS['iwsl_dp_meta'][ $new_id ]['color'], 'unlock: scalar meta copied' );
iwsl_assert_same( array( 'a', 'b' ), $GLOBALS['iwsl_dp_meta'][ $new_id ]['sizes'][0], 'unlock: serialized meta unserialized before copy' );
iwsl_assert( ! isset( $GLOBALS['iwsl_dp_meta'][ $new_id ]['_edit_lock'] ), 'unlock: _edit_lock NOT copied' );
iwsl_assert( ! isset( $GLOBALS['iwsl_dp_meta'][ $new_id ]['_edit_last'] ), 'unlock: _edit_last NOT copied' );

// ── 5. Guard: non-duplicable sources refused, nothing inserted ────────────────

iwsl_dp_reset();
$dp = new IWSL_Duplicate_Post( iwsl_dp_unlocked_entitlements( $DP_NOW ) );
iwsl_assert_same( 'unknown-post', $dp->duplicate( iwsl_dp_post( 9, array( 'post_type' => 'revision' ) ) )['reason'], 'guard: a revision is refused (unknown-post)' );
iwsl_assert_same( 'unknown-post', $dp->duplicate( (object) array( 'ID' => 0, 'post_type' => 'post' ) )['reason'], 'guard: id 0 refused (unknown-post)' );
iwsl_assert_same( 'unknown-post', $dp->duplicate( 'not-a-number' )['reason'], 'guard: non-numeric source refused (unknown-post)' );
iwsl_assert_same( 0, count( $GLOBALS['iwsl_dp_posts'] ), 'guard: nothing inserted for refused sources' );

// ── 6. Guard: capability denied → forbidden, nothing inserted ─────────────────

iwsl_dp_reset();
$GLOBALS['iwsl_dp_can'] = false;
$dp = new IWSL_Duplicate_Post( iwsl_dp_unlocked_entitlements( $DP_NOW ) );
$r  = $dp->duplicate( iwsl_dp_post( 5 ) );
iwsl_assert_same( 'forbidden', $r['reason'], 'guard: current_user_can(edit_post) denied → forbidden' );
iwsl_assert_same( 0, count( $GLOBALS['iwsl_dp_posts'] ), 'guard: nothing inserted when forbidden' );
$GLOBALS['iwsl_dp_can'] = true;

// ── 7. Guard: a failed insert is reported ─────────────────────────────────────

iwsl_dp_reset();
$GLOBALS['iwsl_dp_insert_return'] = 0; // wp_insert_post fails
$dp = new IWSL_Duplicate_Post( iwsl_dp_unlocked_entitlements( $DP_NOW ) );
$r  = $dp->duplicate( iwsl_dp_post( 5 ) );
iwsl_assert_same( 'insert-failed', $r['reason'], 'guard: wp_insert_post returning 0 → insert-failed' );
$GLOBALS['iwsl_dp_insert_return'] = null;

// ── 8. Revocation is instant (shared store, single flip re-locks) ─────────────

iwsl_dp_reset();
$store = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $DP_NOW - 60000 );
$store->set( 'entitlements', array( 'duplicate_post' => true ) );
$ent = new IWSL_Entitlements( $store, static function () use ( $DP_NOW ): int {
	return $DP_NOW; } );
$dp = new IWSL_Duplicate_Post( $ent );
iwsl_assert_same( true, $dp->duplicate( iwsl_dp_post( 5 ) )['ok'], 'revocation: unlocked duplication succeeds' );
$store->set( 'entitlements', array( 'duplicate_post' => false ) ); // console revokes the flag
$r = $dp->duplicate( iwsl_dp_post( 5 ) );
iwsl_assert_same( 'entitlement-locked', $r['reason'], 'revocation: identical call after revoke is entitlement-locked' );

// ── purge(): the stateless engine reports an empty footprint (uniform no-op) ───

$dp_pg = new IWSL_Duplicate_Post( iwsl_dp_unlocked_entitlements( $DP_NOW ) );
$pg    = $dp_pg->purge();
iwsl_assert_same( true, $pg['ok'], 'purge: ok=true' );
iwsl_assert_same( array(), $pg['options'], 'purge: no plugin option to remove (stateless)' );
iwsl_assert_same( array(), $pg['postmeta'], 'purge: no plugin post meta to remove (stateless)' );
iwsl_assert_same( array(), $pg['cron'], 'purge: no cron scheduled by this engine' );
iwsl_assert_same( $pg, $dp_pg->purge(), 'purge: idempotent (repeat call identical, no side effects)' );

// This suite installs $GLOBALS['iwsl_dp_*']; remove them so they never leak into
// another suite in the shared runner.
unset(
	$GLOBALS['iwsl_dp_posts'],
	$GLOBALS['iwsl_dp_next_id'],
	$GLOBALS['iwsl_dp_taxonomies'],
	$GLOBALS['iwsl_dp_terms'],
	$GLOBALS['iwsl_dp_set_terms'],
	$GLOBALS['iwsl_dp_custom'],
	$GLOBALS['iwsl_dp_meta'],
	$GLOBALS['iwsl_dp_can'],
	$GLOBALS['iwsl_dp_insert_return']
);
