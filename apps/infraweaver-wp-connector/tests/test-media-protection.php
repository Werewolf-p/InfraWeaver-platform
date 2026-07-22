<?php
/**
 * Media Protection (gate flag `media_protection`): the per-attachment opt-in
 * copy-deterrent engine (IWSL_Media_Protection).
 *
 * Runs under the zero-dependency harness. This suite defines its own guarded
 * postmeta stubs (backed by $GLOBALS['iwsl_mp_meta']) so the meta-driven
 * protected-check, the save filter, and the content pass are all exercised
 * end-to-end. The gate is proved to BLOCK before any decoration runs, and every
 * pure transform is hit directly.
 */

require_once __DIR__ . '/../includes/class-iwsl-media-protection.php';

// ── suite-local WP stubs (guarded; child-process isolation makes this safe) ───

$GLOBALS['iwsl_mp_meta'] = array();

if ( ! function_exists( 'get_post_meta' ) ) {
	function get_post_meta( int $post_id, string $key = '', bool $single = false ) {
		return $GLOBALS['iwsl_mp_meta'][ $post_id ][ $key ] ?? '';
	}
}
if ( ! function_exists( 'update_post_meta' ) ) {
	function update_post_meta( int $post_id, string $key, $value ): bool {
		$GLOBALS['iwsl_mp_meta'][ $post_id ][ $key ] = $value;
		return true;
	}
}
if ( ! function_exists( 'delete_post_meta' ) ) {
	function delete_post_meta( int $post_id, string $key ): bool {
		unset( $GLOBALS['iwsl_mp_meta'][ $post_id ][ $key ] );
		return true;
	}
}

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Unlocked gate: active + fresh heartbeat + media_protection flag. */
function iwsl_mp_unlocked_entitlements( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 ); // 1 min ago — fresh
	$store->set( 'entitlements', array( 'plus' => true, 'media_protection' => true ) );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** A gate seeded with an explicit state + flag map (for the blocked cases). */
function iwsl_mp_entitlements( int $now, string $state, array $flags, int $last_offset = 60000 ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', $state );
	$store->set( 'last_verified_at', $now - $last_offset );
	$store->set( 'entitlements', $flags );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

$MP_NOW = 20000000;

// Attachment 11 is marked protected; 12 is not.
update_post_meta( 11, IWSL_Media_Protection::META_KEY, '1' );

// ── 1. Pure meta interpretation + the protected-check ─────────────────────────

iwsl_assert_same( true, IWSL_Media_Protection::meta_marks_protected( '1' ), "meta: '1' marks protected" );
iwsl_assert_same( true, IWSL_Media_Protection::meta_marks_protected( 1 ), 'meta: int 1 marks protected' );
iwsl_assert_same( false, IWSL_Media_Protection::meta_marks_protected( '' ), 'meta: empty string (absent) is unprotected' );
iwsl_assert_same( false, IWSL_Media_Protection::meta_marks_protected( '0' ), "meta: '0' is unprotected" );
iwsl_assert_same( false, IWSL_Media_Protection::meta_marks_protected( null ), 'meta: null is unprotected' );

$mp = new IWSL_Media_Protection( iwsl_mp_unlocked_entitlements( $MP_NOW ), new IWSL_Memory_Store() );
iwsl_assert_same( true, $mp->is_protected( 11 ), 'is_protected: marked attachment 11 → true' );
iwsl_assert_same( false, $mp->is_protected( 12 ), 'is_protected: unmarked attachment 12 → false' );
iwsl_assert_same( false, $mp->is_protected( 0 ), 'is_protected: id 0 → false' );

// ── 2. add_protected_class (attribute-array injection, immutable) ─────────────

$in  = array( 'src' => '/a.jpg' );
$out = IWSL_Media_Protection::add_protected_class( $in );
iwsl_assert_same( 'iwsl-protected', $out['class'], 'attrs: class added when absent' );
iwsl_assert_same( 'false', $out['draggable'], 'attrs: draggable=false added' );
iwsl_assert_same( 'return false', $out['oncontextmenu'], 'attrs: oncontextmenu added' );
iwsl_assert_same( array( 'src' => '/a.jpg' ), $in, 'attrs: input array not mutated (immutable)' );

$out2 = IWSL_Media_Protection::add_protected_class( array( 'class' => 'size-full wp-image-11' ) );
iwsl_assert_same( 'size-full wp-image-11 iwsl-protected', $out2['class'], 'attrs: appended to existing class' );

$out3 = IWSL_Media_Protection::add_protected_class( $out2 );
iwsl_assert_same( 1, substr_count( $out3['class'], 'iwsl-protected' ), 'attrs: idempotent — class token never duplicated' );

$out4 = IWSL_Media_Protection::add_protected_class( array( 'draggable' => 'true' ) );
iwsl_assert_same( 'true', $out4['draggable'], 'attrs: author-set draggable respected' );

// ── 3. protect_img_tag (tag-string decoration) ────────────────────────────────

$t1 = IWSL_Media_Protection::protect_img_tag( '<img src="/a.jpg">' );
iwsl_assert( false !== strpos( $t1, 'class="iwsl-protected"' ), 'tag: class attribute added when absent' );
iwsl_assert( false !== strpos( $t1, 'draggable="false"' ), 'tag: draggable=false added' );
iwsl_assert( false !== strpos( $t1, 'oncontextmenu="return false"' ), 'tag: oncontextmenu added' );

$t2 = IWSL_Media_Protection::protect_img_tag( '<img class="size-full wp-image-11" src="/a.jpg">' );
iwsl_assert( false !== strpos( $t2, 'class="size-full wp-image-11 iwsl-protected"' ), 'tag: appended inside double-quoted class' );

$t3 = IWSL_Media_Protection::protect_img_tag( "<img class='wp-image-11' src='/a.jpg'>" );
iwsl_assert( false !== strpos( $t3, "class='wp-image-11 iwsl-protected'" ), 'tag: appended inside single-quoted class' );

iwsl_assert_same( $t2, IWSL_Media_Protection::protect_img_tag( $t2 ), 'tag: idempotent — already-protected tag byte-identical' );

$t4 = IWSL_Media_Protection::protect_img_tag( '<img src="/z.jpg" />' );
iwsl_assert_same( ' />', substr( $t4, -3 ), 'tag: self-closing /> preserved' );

// ── 4. attachment-id extraction from content markup ───────────────────────────

iwsl_assert_same( 42, IWSL_Media_Protection::attachment_id_from_img_tag( '<img class="alignnone wp-image-42" src="/x.jpg">' ), 'id: wp-image-42 → 42' );
iwsl_assert_same( 0, IWSL_Media_Protection::attachment_id_from_img_tag( '<img src="/x.jpg">' ), 'id: no wp-image class → 0' );
iwsl_assert_same( 0, IWSL_Media_Protection::attachment_id_from_img_tag( '<img class="wp-image-42abc">' ), 'id: mangled wp-image token rejected' );

$ids = IWSL_Media_Protection::extract_attachment_ids( '<img class="wp-image-11"><img class="wp-image-12"><img class="wp-image-11">' );
iwsl_assert_same( array( 11, 12 ), $ids, 'ids: unique, first-seen order' );
iwsl_assert_same( array(), IWSL_Media_Protection::extract_attachment_ids( '<p>no images</p>' ), 'ids: none → empty array' );

// ── 5. content_references_protected ───────────────────────────────────────────

$mp_check = static function ( int $id ): bool {
	return 11 === $id;
};
iwsl_assert_same( true, IWSL_Media_Protection::content_references_protected( '<img class="wp-image-11">', $mp_check ), 'refs: protected id present → true' );
iwsl_assert_same( false, IWSL_Media_Protection::content_references_protected( '<img class="wp-image-12">', $mp_check ), 'refs: only unprotected ids → false' );
iwsl_assert_same( false, IWSL_Media_Protection::content_references_protected( '', $mp_check ), 'refs: empty html → false' );

// ── 6. overlay builder ────────────────────────────────────────────────────────

$wrapped = IWSL_Media_Protection::wrap_with_overlay( '<img class="iwsl-protected" src="/a.jpg">' );
iwsl_assert( false !== strpos( $wrapped, 'class="iwsl-protected-wrap"' ), 'overlay: wrap span present' );
iwsl_assert( false !== strpos( $wrapped, 'iwsl-protected-shield' ), 'overlay: shield element present' );
iwsl_assert( false !== strpos( $wrapped, IWSL_Media_Protection::BLANK_GIF ), 'overlay: shield is the 1x1 transparent gif' );
iwsl_assert( false !== strpos( $wrapped, 'draggable="false"' ), 'overlay: shield itself not draggable' );

// ── 7. protect_content (the pure content pass) ────────────────────────────────

$content = '<p><img class="size-full wp-image-11" src="/a.jpg" alt="a"><img class="wp-image-12" src="/b.jpg"></p>';
$res     = IWSL_Media_Protection::protect_content( $content, $mp_check );
iwsl_assert_same( 1, $res['count'], 'content: exactly the one protected image counted' );
iwsl_assert_same( 1, substr_count( $res['html'], 'iwsl-protected-wrap' ), 'content: exactly one overlay wrap' );
iwsl_assert( false !== strpos( $res['html'], 'wp-image-11 iwsl-protected' ), 'content: protected img gained the class' );
iwsl_assert( false !== strpos( $res['html'], '<img class="wp-image-12" src="/b.jpg">' ), 'content: unprotected img byte-identical' );

// Idempotent: a second pass changes nothing and never re-wraps.
$res2 = IWSL_Media_Protection::protect_content( $res['html'], $mp_check );
iwsl_assert_same( $res['html'], $res2['html'], 'content: second pass byte-identical (idempotent)' );
iwsl_assert_same( 1, $res2['count'], 'content: second pass still counts the protected image' );
iwsl_assert_same( 1, substr_count( $res2['html'], 'iwsl-protected-wrap' ), 'content: second pass does not double-wrap' );

// No images / no protected images → untouched.
$plain = '<p>hello</p>';
$rp    = IWSL_Media_Protection::protect_content( $plain, $mp_check );
iwsl_assert_same( $plain, $rp['html'], 'content: image-free html untouched' );
iwsl_assert_same( 0, $rp['count'], 'content: image-free html counts 0' );
$unrelated = '<img src="/plain.jpg">';
iwsl_assert_same( 0, IWSL_Media_Protection::protect_content( $unrelated, $mp_check )['count'], 'content: img without attachment id never protected' );

// ── 8. Gate BLOCKS: no decoration, no footer, for a lower tier ────────────────

$MP_CONTENT = '<p><img class="wp-image-11" src="/a.jpg"></p>';

// (a) flag absent.
$mp_lk = new IWSL_Media_Protection( iwsl_mp_entitlements( $MP_NOW, 'active', array( 'plus' => true ) ), new IWSL_Memory_Store() );
iwsl_assert_same( $MP_CONTENT, $mp_lk->filter_the_content( $MP_CONTENT ), 'gate (flag absent): content byte-identical' );

// (b) state != active, even WITH the flag true.
$mp_pd = new IWSL_Media_Protection( iwsl_mp_entitlements( $MP_NOW, 'pending', array( 'plus' => true, 'media_protection' => true ) ), new IWSL_Memory_Store() );
iwsl_assert_same( $MP_CONTENT, $mp_pd->filter_the_content( $MP_CONTENT ), 'gate (not active): unchanged despite flag' );

// (c) stale heartbeat (3h), even WITH the flag true.
$mp_st = new IWSL_Media_Protection( iwsl_mp_entitlements( $MP_NOW, 'active', array( 'plus' => true, 'media_protection' => true ), 10800000 ), new IWSL_Memory_Store() );
iwsl_assert_same( $MP_CONTENT, $mp_st->filter_the_content( $MP_CONTENT ), 'gate (stale heartbeat): unchanged despite flag' );

// (d) locked footer emits nothing (even if a flag were somehow set).
iwsl_assert_same( '', $mp_lk->footer_markup(), 'gate: locked footer is empty' );

// Attribute filter is gated too.
$attrs_in = array( 'src' => '/a.jpg', 'class' => 'wp-image-11' );
iwsl_assert_same( $attrs_in, $mp_lk->filter_attachment_image_attributes( $attrs_in, (object) array( 'ID' => 11 ) ), 'gate: attrs filter returns array untouched' );

// ── 9. Unlocked integration: content pass, presence flag, footer ──────────────

$store_on = new IWSL_Memory_Store();
$mp_on    = new IWSL_Media_Protection( iwsl_mp_unlocked_entitlements( $MP_NOW ), $store_on );

iwsl_assert_same( false, $mp_on->protected_seen(), 'unlocked: fresh request has seen no protected image' );
iwsl_assert_same( '', $mp_on->footer_markup(), 'unlocked: zero-protected page emits NO footer assets' );

$live = $mp_on->filter_the_content( $MP_CONTENT );
iwsl_assert( false !== strpos( $live, 'iwsl-protected-wrap' ), 'unlocked + enabled: protected content image wrapped' );
iwsl_assert_same( true, $mp_on->protected_seen(), 'unlocked: content pass flags the page' );

$footer = $mp_on->footer_markup();
iwsl_assert( false !== strpos( $footer, '<style' ), 'footer: inline style emitted' );
iwsl_assert( false !== strpos( $footer, '<script' ), 'footer: inline script emitted' );
iwsl_assert( false !== strpos( $footer, '-webkit-user-drag:none' ), 'footer: css carries the drag suppression' );
iwsl_assert( false !== strpos( $footer, 'contextmenu' ), 'footer: js suppresses the context menu' );
iwsl_assert( false === strpos( $footer, 'keydown' ), 'footer: global deterrent OFF by default (no keydown hook)' );

// Global deterrent ON → keydown blocker appears.
$store_on->set( IWSL_Media_Protection::OPTION_KEY, array( 'enabled' => true, 'global_deterrent' => true ) );
iwsl_assert( false !== strpos( $mp_on->footer_markup(), 'keydown' ), 'footer: global deterrent ON adds the keydown blocker' );

// wp_get_attachment_image_attributes path: protected id tagged, page flagged.
$store_at = new IWSL_Memory_Store();
$mp_at    = new IWSL_Media_Protection( iwsl_mp_unlocked_entitlements( $MP_NOW ), $store_at );
$tagged   = $mp_at->filter_attachment_image_attributes( array( 'src' => '/a.jpg' ), (object) array( 'ID' => 11 ) );
iwsl_assert( false !== strpos( (string) $tagged['class'], 'iwsl-protected' ), 'attrs filter: protected attachment tagged' );
iwsl_assert_same( true, $mp_at->protected_seen(), 'attrs filter: page flagged for the footer' );
iwsl_assert_same( array( 'src' => '/b.jpg' ), $mp_at->filter_attachment_image_attributes( array( 'src' => '/b.jpg' ), (object) array( 'ID' => 12 ) ), 'attrs filter: unprotected attachment untouched' );

// ── 10. Unlocked but DISABLED: nothing happens anywhere ───────────────────────

$store_off = new IWSL_Memory_Store();
$store_off->set( IWSL_Media_Protection::OPTION_KEY, array( 'enabled' => false, 'global_deterrent' => false ) );
$mp_off = new IWSL_Media_Protection( iwsl_mp_unlocked_entitlements( $MP_NOW ), $store_off );
iwsl_assert_same( $MP_CONTENT, $mp_off->filter_the_content( $MP_CONTENT ), 'disabled: content byte-identical' );
iwsl_assert_same( '', $mp_off->footer_markup(), 'disabled: footer empty' );

// ── 11. sanitize_settings + defaults ──────────────────────────────────────────

iwsl_assert_same(
	array( 'enabled' => true, 'global_deterrent' => false ),
	IWSL_Media_Protection::sanitize_settings( array( 'enabled' => '1', 'rogue' => 'x' ) ),
	'sanitize: checkbox semantics + unknown keys dropped'
);
iwsl_assert_same(
	array( 'enabled' => false, 'global_deterrent' => false ),
	IWSL_Media_Protection::sanitize_settings( array() ),
	'sanitize: empty input → both off'
);

$mp_def = new IWSL_Media_Protection( iwsl_mp_unlocked_entitlements( $MP_NOW ), new IWSL_Memory_Store() );
$def    = $mp_def->settings();
iwsl_assert_same( true, $def['enabled'], 'defaults: enabled true out of the box' );
iwsl_assert_same( false, $def['global_deterrent'], 'defaults: global deterrent off out of the box' );

// ── 12. update_settings: gate + persistence ───────────────────────────────────

$store_u = new IWSL_Memory_Store();
$mp_u    = new IWSL_Media_Protection( iwsl_mp_unlocked_entitlements( $MP_NOW ), $store_u );
$ru      = $mp_u->update_settings( array( 'enabled' => '1', 'global_deterrent' => '1' ) );
iwsl_assert_same( true, $ru['ok'], 'update_settings: ok when unlocked' );
iwsl_assert_same( true, $ru['settings']['global_deterrent'], 'update_settings: global deterrent stored true' );
iwsl_assert_same( true, $mp_u->settings()['global_deterrent'], 'update_settings: persisted value read back' );

$store_l = new IWSL_Memory_Store();
$mp_l    = new IWSL_Media_Protection( iwsl_mp_entitlements( $MP_NOW, 'active', array( 'plus' => true ) ), $store_l );
$rl      = $mp_l->update_settings( array( 'enabled' => '1' ) );
iwsl_assert_same( false, $rl['ok'], 'update_settings (locked): refused' );
iwsl_assert_same( 'entitlement-locked', $rl['reason'], 'update_settings (locked): reason entitlement-locked' );
iwsl_assert_same( array(), $store_l->get( IWSL_Media_Protection::OPTION_KEY, array() ), 'update_settings (locked): nothing persisted' );

// ── 13. The opt-in UI: field builder + edit/save filters ──────────────────────

$field = IWSL_Media_Protection::attachment_field( 7, true );
iwsl_assert_same( 'html', $field['input'], 'field: input type html' );
iwsl_assert( false !== strpos( $field['html'], 'attachments[7][iwsl_protected]' ), 'field: name targets attachments[7]' );
iwsl_assert( false !== strpos( $field['html'], ' checked' ), 'field: checked when protected' );
iwsl_assert( false === strpos( IWSL_Media_Protection::attachment_field( 7, false )['html'], ' checked' ), 'field: unchecked when not protected' );
iwsl_assert( false !== stripos( $field['helps'], 'deterrent' ), 'field: honest deterrent note on the checkbox' );

// wants_protection: pure checkbox interpretation.
iwsl_assert_same( true, IWSL_Media_Protection::wants_protection( array( 'iwsl_protected' => '1' ) ), "wants: '1' → true" );
iwsl_assert_same( true, IWSL_Media_Protection::wants_protection( array( 'iwsl_protected' => 'on' ) ), "wants: 'on' → true" );
iwsl_assert_same( false, IWSL_Media_Protection::wants_protection( array() ), 'wants: absent → false' );
iwsl_assert_same( false, IWSL_Media_Protection::wants_protection( array( 'iwsl_protected' => '0' ) ), "wants: '0' → false" );

// fields_to_edit: unlocked+enabled adds the checkbox for an image attachment…
$mp_ui  = new IWSL_Media_Protection( iwsl_mp_unlocked_entitlements( $MP_NOW ), new IWSL_Memory_Store() );
$img_at = (object) array( 'ID' => 11, 'post_mime_type' => 'image/jpeg' );
$fset   = $mp_ui->filter_attachment_fields_to_edit( array(), $img_at );
iwsl_assert( isset( $fset['iwsl_protected'] ), 'fields_to_edit: checkbox added for image attachment' );
iwsl_assert( false !== strpos( $fset['iwsl_protected']['html'], ' checked' ), 'fields_to_edit: reflects stored protected state' );

// …but never for non-images, and never when locked.
iwsl_assert_same( array(), $mp_ui->filter_attachment_fields_to_edit( array(), (object) array( 'ID' => 13, 'post_mime_type' => 'application/pdf' ) ), 'fields_to_edit: non-image untouched' );
iwsl_assert_same( array(), $mp_lk->filter_attachment_fields_to_edit( array(), $img_at ), 'fields_to_edit: locked site shows stock modal' );

// fields_to_save: unlocked persists / clears the meta…
$mp_ui->filter_attachment_fields_to_save( array( 'ID' => 21 ), array( 'iwsl_protected' => '1' ) );
iwsl_assert_same( '1', get_post_meta( 21, IWSL_Media_Protection::META_KEY, true ), 'fields_to_save: checkbox on → meta written' );
$mp_ui->filter_attachment_fields_to_save( array( 'ID' => 21 ), array() );
iwsl_assert_same( '', get_post_meta( 21, IWSL_Media_Protection::META_KEY, true ), 'fields_to_save: checkbox off → meta cleared' );

// …a locked site never touches the meta, in either direction.
$mp_lk->filter_attachment_fields_to_save( array( 'ID' => 22 ), array( 'iwsl_protected' => '1' ) );
iwsl_assert_same( '', get_post_meta( 22, IWSL_Media_Protection::META_KEY, true ), 'fields_to_save (locked): never writes' );
update_post_meta( 23, IWSL_Media_Protection::META_KEY, '1' );
$mp_lk->filter_attachment_fields_to_save( array( 'ID' => 23 ), array() );
iwsl_assert_same( '1', get_post_meta( 23, IWSL_Media_Protection::META_KEY, true ), 'fields_to_save (locked): never clears the owner\'s marks' );

// ── 14. purge(): teardown removes settings option + _iwsl_protected meta ─────

if ( ! class_exists( 'IWSL_MP_Fake_WPDB' ) ) {
	final class IWSL_MP_Fake_WPDB {
		public $postmeta = 'wp_postmeta';
		/** Models a bulk `DELETE ... WHERE meta_key = X` against the postmeta fixture. */
		public function delete( $table, $where ) {
			if ( $this->postmeta !== $table || ! isset( $where['meta_key'] ) ) {
				return 0;
			}
			$key     = (string) $where['meta_key'];
			$removed = 0;
			foreach ( $GLOBALS['iwsl_mp_meta'] as $id => $row ) {
				if ( is_array( $row ) && array_key_exists( $key, $row ) ) {
					unset( $GLOBALS['iwsl_mp_meta'][ $id ][ $key ] );
					++$removed;
				}
			}
			return $removed;
		}
	}
}
$GLOBALS['wpdb'] = new IWSL_MP_Fake_WPDB();

// (a) cheap no-op when nothing exists: a fresh meta slate + a never-configured
// store proves the clean-state behaviour, independent of earlier sections'
// fixture attachments (11/21/22/23) which stay untouched by this reset.
$GLOBALS['iwsl_mp_meta'] = array();
$store_purge_clean = new IWSL_Memory_Store();
$mp_purge_clean     = new IWSL_Media_Protection( iwsl_mp_unlocked_entitlements( $MP_NOW ), $store_purge_clean );
$pg_clean = $mp_purge_clean->purge();
iwsl_assert_same( 0, $pg_clean['options'], 'purge(clean): options=0 (nothing stored)' );
iwsl_assert_same( 0, $pg_clean['meta'], 'purge(clean): meta=0 (nothing marked protected)' );
iwsl_assert_same( false, $pg_clean['cron'], 'purge(clean): cron=false (this engine schedules none)' );

// (b) seed a real footprint: a settings option + three protected marks.
$store_purge = new IWSL_Memory_Store();
$store_purge->set( IWSL_Media_Protection::OPTION_KEY, array( 'enabled' => true, 'global_deterrent' => true ) );
update_post_meta( 31, IWSL_Media_Protection::META_KEY, '1' );
update_post_meta( 32, IWSL_Media_Protection::META_KEY, '1' );
update_post_meta( 33, IWSL_Media_Protection::META_KEY, '1' );
$mp_purge = new IWSL_Media_Protection( iwsl_mp_unlocked_entitlements( $MP_NOW ), $store_purge );

$pg = $mp_purge->purge();
iwsl_assert_same( 1, $pg['options'], 'purge: settings option removed' );
iwsl_assert_same( 3, $pg['meta'], 'purge: all three protected marks removed' );
iwsl_assert_same( false, $pg['cron'], 'purge: cron=false (this engine schedules none)' );
iwsl_assert_same( array(), $store_purge->get( IWSL_Media_Protection::OPTION_KEY, array() ), 'purge: settings option reads back empty' );
iwsl_assert_same( '', get_post_meta( 31, IWSL_Media_Protection::META_KEY, true ), 'purge: attachment 31 unprotected' );
iwsl_assert_same( '', get_post_meta( 32, IWSL_Media_Protection::META_KEY, true ), 'purge: attachment 32 unprotected' );
iwsl_assert_same( '', get_post_meta( 33, IWSL_Media_Protection::META_KEY, true ), 'purge: attachment 33 unprotected' );

// (c) idempotent: a second call finds nothing left, reports zeros, no error.
$pg2 = $mp_purge->purge();
iwsl_assert_same( 0, $pg2['options'], 'purge(idempotent): second call removes no option' );
iwsl_assert_same( 0, $pg2['meta'], 'purge(idempotent): second call removes no meta' );

unset( $GLOBALS['wpdb'] );

// ── 15. content-cache flush: update_settings invalidates the page cache ──────

if ( ! class_exists( 'IWSL_Teardown' ) ) {
	class IWSL_Teardown {
		/** @var int */
		public static $flush_calls = 0;
		public static function flush_page_cache(): void {
			self::$flush_calls++;
		}
	}
}

IWSL_Teardown::$flush_calls = 0;
$store_flush = new IWSL_Memory_Store();
$mp_flush    = new IWSL_Media_Protection( iwsl_mp_unlocked_entitlements( $MP_NOW ), $store_flush );
$mp_flush->update_settings( array( 'enabled' => '1' ) );
iwsl_assert_same( 1, IWSL_Teardown::$flush_calls, 'update_settings: flush_page_cache() called once when IWSL_Teardown exists' );

// a locked update never reaches the flush.
IWSL_Teardown::$flush_calls = 0;
$store_locked_flush = new IWSL_Memory_Store();
$mp_locked_flush     = new IWSL_Media_Protection( iwsl_mp_entitlements( $MP_NOW, 'active', array( 'plus' => true ) ), $store_locked_flush );
$mp_locked_flush->update_settings( array( 'enabled' => '1' ) );
iwsl_assert_same( 0, IWSL_Teardown::$flush_calls, 'update_settings (locked): flush_page_cache() NOT called' );
