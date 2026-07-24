<?php
/**
 * IWSL_Media_Editor — the `media.edit` runner behind the viewer's "Edit Image"
 * (Agent A): crop / rotate / flip / scale + thumbnail regeneration, using
 * WordPress's OWN WP_Image_Editor (never a hand-rolled encoder).
 *
 * SECURITY — path containment (CRITICAL). The editor operates by ATTACHMENT ID,
 * never a caller-supplied path. The source file is resolved server-side
 * (wp_get_original_image_path → get_attached_file) and then MUST pass the same
 * realpath containment gauntlet the optimizer uses: the resolved real path has to
 * live INSIDE the uploads base dir, or the edit is refused `path-escape`. A symlink
 * planted in uploads that points out is caught because realpath() follows it before
 * the containment test. No request field ever names a file.
 *
 * OFFLOAD SAFETY. Editing rewrites the canonical file and regenerates derivatives;
 * for an offloaded asset that would orphan the bucket copy, so the runner REFUSES
 * (`offloaded-refused`) and asks the operator to restore first — the "never leave a
 * dangling remote" rule the restore path already enforces.
 *
 * OPTIMIZER INVALIDATION. A successful edit invalidates any lossless derivative, so
 * the optimizer marker (`_iwsl_media_optimizer`) is CLEARED — the asset re-lists as
 * "not lossless" and can be re-optimized, never served a stale WebP.
 *
 * TRUST MODEL / SAFETY. Console-authoritative; STATEMENT 1 is the image_optimization
 * gate (this is an image-pipeline power). In-process only, no exec/network. The
 * WP_Image_Editor is obtained through an injectable factory so the zero-dependency
 * test harness can drive the op pipeline + containment with a fake editor.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Media_Editor {

	/** This power lives behind the image-pipeline flag. */
	const FEATURE = 'image_optimization';

	/** Hard ceiling on ops per edit (the console offers a handful at a time). */
	const EDIT_OPS_MAX = 10;

	/** Postmeta the optimizer writes — cleared on a successful edit (derivative stale). */
	const OPT_META     = '_iwsl_media_optimizer';
	const OFFLOAD_META = '_iwsl_offload';

	/** Op vocabularies. */
	const OP_TYPES  = array( 'rotate', 'flip', 'crop', 'scale' );
	const FLIP_AXES = array( 'horizontal', 'vertical' );
	const TARGETS   = array( 'all', 'thumbnail' );

	/**
	 * Per-side ceiling for crop/scale dimensions (px) — mirrors
	 * IWSL_Media_Optimizer::MAX_DIMENSION (also WebP's own 16383px limit). Caps the
	 * allocation a single edit op can request, so a bounded write can't ask the
	 * image editor for a multi-gigapixel canvas.
	 */
	const MAX_DIMENSION = 16383;

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var string Uploads base dir; realpath containment root for every path. */
	private $base_dir;

	/** @var callable(string):mixed Factory → a WP_Image_Editor-like object (or WP_Error). */
	private $editor_factory;

	/**
	 * @param IWSL_Entitlements $entitlements   The gate.
	 * @param string|null       $base_dir       Uploads basedir; defaults to wp_get_upload_dir()['basedir'].
	 * @param callable|null     $editor_factory fn(string $path) => WP_Image_Editor|WP_Error; defaults to wp_get_image_editor.
	 */
	public function __construct( IWSL_Entitlements $entitlements, ?string $base_dir = null, ?callable $editor_factory = null ) {
		$this->entitlements   = $entitlements;
		$this->base_dir       = null !== $base_dir ? $base_dir : self::default_base_dir();
		$this->editor_factory = $editor_factory ?? static function ( string $path ) {
			return function_exists( 'wp_get_image_editor' ) ? wp_get_image_editor( $path ) : null;
		};
	}

	/** Uploads basedir under WordPress, or empty string outside it. */
	private static function default_base_dir(): string {
		if ( function_exists( 'wp_get_upload_dir' ) ) {
			$dir = wp_get_upload_dir();
			if ( is_array( $dir ) && isset( $dir['basedir'] ) && is_string( $dir['basedir'] ) ) {
				return $dir['basedir'];
			}
		}
		return '';
	}

	/**
	 * Apply the op pipeline to one attachment. STATEMENT 1 is the entitlement gate;
	 * then the path-containment gauntlet, the offloaded refusal, the WP_Image_Editor
	 * ops in order, save, metadata regeneration and optimizer-marker invalidation.
	 *
	 * @param array<int,array<string,mixed>> $ops        Validated op list (rotate|flip|crop|scale).
	 * @param string                         $target     'all' | 'thumbnail'.
	 * @param bool                           $regenerate Regenerate attachment metadata after save.
	 * @return array<string,mixed>
	 */
	public function edit( int $id, array $ops, string $target = 'all', bool $regenerate = true ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'locked' => true, 'gate' => $gate );
		}
		if ( array() === $ops ) {
			return self::refuse( 'no-ops' );
		}

		// Refuse an offloaded asset FIRST — editing would orphan the bucket copy.
		if ( $this->is_offloaded( $id ) ) {
			return self::refuse( 'offloaded-refused' );
		}

		// CRITICAL: id → server-side path → realpath containment inside uploads.
		$contained = $this->contained_source( $id );
		if ( empty( $contained['ok'] ) ) {
			return self::refuse( (string) $contained['reason'] );
		}
		$path = (string) $contained['path'];

		$editor = ( $this->editor_factory )( $path );
		if ( ! is_object( $editor ) || ( function_exists( 'is_wp_error' ) && is_wp_error( $editor ) ) ) {
			return self::refuse( 'editor-unavailable' );
		}

		$applied = $this->apply_ops( $editor, $ops );
		if ( ! empty( $applied['error'] ) ) {
			return self::refuse( (string) $applied['error'] );
		}

		$saved = $editor->save( $path );
		if ( function_exists( 'is_wp_error' ) && is_wp_error( $saved ) ) {
			return self::refuse( 'save-failed' );
		}

		// Regenerate attachment metadata (all sizes, or leave sub-sizes when 'thumbnail').
		if ( $regenerate ) {
			$this->regenerate( $id, $path );
		}

		// The lossless derivative (if any) is now stale — clear the marker so the
		// asset re-lists as not-lossless and can be re-optimized honestly.
		$optimizer_cleared = $this->clear_optimizer_marker( $id );

		$dims = $this->current_dimensions( $editor, $id );
		return array(
			'ok'                => true,
			'edited'            => true,
			'id'                => $id,
			'target'            => in_array( $target, self::TARGETS, true ) ? $target : 'all',
			'width'             => (int) $dims['width'],
			'height'            => (int) $dims['height'],
			'filesize'          => is_file( $path ) ? (int) filesize( $path ) : 0,
			'optimizer_cleared' => $optimizer_cleared,
		);
	}

	/**
	 * Run the ops against the WP_Image_Editor in order. Returns { error } on the first
	 * failed op (a WP_Error result), else {} on success. Ops are already validated for
	 * shape; this is the execution + editor-error mapping.
	 *
	 * @param object                         $editor
	 * @param array<int,array<string,mixed>> $ops
	 * @return array{error?:string}
	 */
	private function apply_ops( $editor, array $ops ): array {
		foreach ( $ops as $op ) {
			$type = isset( $op['type'] ) ? (string) $op['type'] : '';
			switch ( $type ) {
				case 'rotate':
					$r = $editor->rotate( (float) $op['angle'] );
					break;
				case 'flip':
					$horizontal = 'horizontal' === ( $op['axis'] ?? '' );
					$r          = $editor->flip( $horizontal, ! $horizontal );
					break;
				case 'crop':
					$r = $editor->crop( (int) $op['x'], (int) $op['y'], (int) $op['width'], (int) $op['height'] );
					break;
				case 'scale':
					$r = $editor->resize( (int) $op['width'], (int) $op['height'], false );
					break;
				default:
					return array( 'error' => 'unsupported-op' );
			}
			if ( function_exists( 'is_wp_error' ) && is_wp_error( $r ) ) {
				return array( 'error' => 'op-failed:' . $type );
			}
		}
		return array();
	}

	/**
	 * The path-containment gauntlet (reused from the optimizer): id → server-resolved
	 * source path → realpath must live INSIDE the uploads base dir. Never trusts a
	 * caller path. Returns { ok, reason, path } — `path` is the contained real path.
	 *
	 * @return array{ok:bool,reason:string,path:string}
	 */
	private function contained_source( int $id ): array {
		$path = $this->resolve_source_path( $id );
		if ( '' === $path ) {
			return array( 'ok' => false, 'reason' => 'no-source', 'path' => '' );
		}
		$real_base = '' === $this->base_dir ? false : realpath( $this->base_dir );
		$real      = realpath( $path );
		if ( false === $real_base || false === $real
			|| 0 !== strpos( $real, rtrim( $real_base, '/' ) . '/' ) ) {
			return array( 'ok' => false, 'reason' => 'path-escape', 'path' => '' );
		}
		if ( ! is_file( $real ) ) {
			return array( 'ok' => false, 'reason' => 'not-a-file', 'path' => '' );
		}
		return array( 'ok' => true, 'reason' => '', 'path' => $real );
	}

	/** Resolve an attachment's ORIGINAL file path server-side. '' outside WP. */
	private function resolve_source_path( int $id ): string {
		if ( $id <= 0 ) {
			return '';
		}
		if ( function_exists( 'wp_get_original_image_path' ) ) {
			$candidate = wp_get_original_image_path( $id );
			if ( is_string( $candidate ) && '' !== $candidate ) {
				return $candidate;
			}
		}
		if ( function_exists( 'get_attached_file' ) ) {
			$candidate = get_attached_file( $id );
			if ( is_string( $candidate ) && '' !== $candidate ) {
				return $candidate;
			}
		}
		return '';
	}

	/** Whether this attachment is offloaded to the bucket (a non-empty `key`). */
	private function is_offloaded( int $id ): bool {
		$raw = ( $id > 0 && function_exists( 'get_post_meta' ) ) ? get_post_meta( $id, self::OFFLOAD_META, true ) : '';
		return is_array( $raw ) && isset( $raw['key'] ) && '' !== (string) $raw['key'];
	}

	/** Regenerate attachment metadata from the edited file (best-effort, guarded). */
	private function regenerate( int $id, string $path ): void {
		if ( ! function_exists( 'wp_generate_attachment_metadata' ) && defined( 'ABSPATH' ) && function_exists( 'is_admin' ) ) {
			$image_inc = ABSPATH . 'wp-admin/includes/image.php';
			if ( is_file( $image_inc ) ) {
				require_once $image_inc;
			}
		}
		if ( function_exists( 'wp_generate_attachment_metadata' ) && function_exists( 'wp_update_attachment_metadata' ) ) {
			$meta = wp_generate_attachment_metadata( $id, $path );
			if ( is_array( $meta ) && array() !== $meta ) {
				wp_update_attachment_metadata( $id, $meta );
			}
		}
	}

	/** Clear the optimizer's derivative marker; returns whether a marker was present. */
	private function clear_optimizer_marker( int $id ): bool {
		if ( $id <= 0 || ! function_exists( 'get_post_meta' ) ) {
			return false;
		}
		$existing = get_post_meta( $id, self::OPT_META, true );
		$had      = is_array( $existing ) ? array() !== $existing : '' !== (string) $existing;
		if ( $had && function_exists( 'delete_post_meta' ) ) {
			delete_post_meta( $id, self::OPT_META );
		}
		return $had;
	}

	/**
	 * Post-edit dimensions: the editor's own get_size() when available, else the
	 * refreshed attachment metadata. Zeros when neither resolves.
	 *
	 * @param object $editor
	 * @return array{width:int,height:int}
	 */
	private function current_dimensions( $editor, int $id ): array {
		if ( method_exists( $editor, 'get_size' ) ) {
			$size = $editor->get_size();
			if ( is_array( $size ) && isset( $size['width'], $size['height'] ) ) {
				return array( 'width' => (int) $size['width'], 'height' => (int) $size['height'] );
			}
		}
		if ( function_exists( 'wp_get_attachment_metadata' ) ) {
			$meta = wp_get_attachment_metadata( $id );
			if ( is_array( $meta ) ) {
				return array( 'width' => (int) ( $meta['width'] ?? 0 ), 'height' => (int) ( $meta['height'] ?? 0 ) );
			}
		}
		return array( 'width' => 0, 'height' => 0 );
	}

	// ── validator (the wire boundary) ────────────────────────────────────────────

	/**
	 * `media.edit` params: { id, ops:[...] (1..EDIT_OPS_MAX), target?, regenerate? }.
	 * Each op is a discriminated shape by `type`:
	 *   rotate { angle } — angle a non-zero multiple of 90 within ±360;
	 *   flip   { axis: horizontal|vertical };
	 *   crop   { x>=0, y>=0, width>0, height>0 };
	 *   scale  { width>0, height>0 } (a max box).
	 *
	 * @param mixed $params
	 */
	public static function validate_params( $params ): bool {
		if ( ! $params instanceof stdClass ) {
			return false;
		}
		$vars = get_object_vars( $params );
		if ( array() !== array_diff_key( $vars, array( 'id' => 1, 'ops' => 1, 'target' => 1, 'regenerate' => 1 ) ) ) {
			return false;
		}
		if ( ! isset( $vars['id'] ) || ! is_int( $vars['id'] ) || $vars['id'] <= 0 ) {
			return false;
		}
		if ( ! isset( $vars['ops'] ) || ! is_array( $vars['ops'] ) ) {
			return false;
		}
		$n = count( $vars['ops'] );
		if ( $n < 1 || $n > self::EDIT_OPS_MAX ) {
			return false;
		}
		foreach ( $vars['ops'] as $op ) {
			if ( ! self::valid_op( $op ) ) {
				return false;
			}
		}
		if ( isset( $vars['target'] ) && ! ( is_string( $vars['target'] ) && in_array( $vars['target'], self::TARGETS, true ) ) ) {
			return false;
		}
		return ! isset( $vars['regenerate'] ) || is_bool( $vars['regenerate'] );
	}

	/** True when a single op object carries exactly its type's key set with valid values. @param mixed $op */
	private static function valid_op( $op ): bool {
		if ( ! $op instanceof stdClass ) {
			return false;
		}
		$vars = get_object_vars( $op );
		$type = isset( $vars['type'] ) ? $vars['type'] : '';
		if ( ! is_string( $type ) || ! in_array( $type, self::OP_TYPES, true ) ) {
			return false;
		}
		switch ( $type ) {
			case 'rotate':
				if ( array() !== array_diff_key( $vars, array( 'type' => 1, 'angle' => 1 ) ) || ! isset( $vars['angle'] ) || ! is_int( $vars['angle'] ) ) {
					return false;
				}
				return 0 !== $vars['angle'] && 0 === $vars['angle'] % 90 && $vars['angle'] >= -360 && $vars['angle'] <= 360;
			case 'flip':
				return array() === array_diff_key( $vars, array( 'type' => 1, 'axis' => 1 ) )
					&& isset( $vars['axis'] ) && is_string( $vars['axis'] ) && in_array( $vars['axis'], self::FLIP_AXES, true );
			case 'crop':
				return array() === array_diff_key( $vars, array( 'type' => 1, 'x' => 1, 'y' => 1, 'width' => 1, 'height' => 1 ) )
					&& self::non_neg_int( $vars, 'x' ) && self::non_neg_int( $vars, 'y' )
					&& self::dim_int( $vars, 'width' ) && self::dim_int( $vars, 'height' );
			case 'scale':
				return array() === array_diff_key( $vars, array( 'type' => 1, 'width' => 1, 'height' => 1 ) )
					&& self::dim_int( $vars, 'width' ) && self::dim_int( $vars, 'height' );
		}
		return false;
	}

	/** @param array<string,mixed> $vars */
	private static function non_neg_int( array $vars, string $key ): bool {
		return isset( $vars[ $key ] ) && is_int( $vars[ $key ] ) && $vars[ $key ] >= 0;
	}

	/**
	 * A positive int within the per-side dimension ceiling (1..MAX_DIMENSION). A
	 * crop/scale edge above the ceiling is refused (alloc-DoS guard), mirroring the
	 * optimizer's own bound. @param array<string,mixed> $vars
	 */
	private static function dim_int( array $vars, string $key ): bool {
		return isset( $vars[ $key ] ) && is_int( $vars[ $key ] ) && $vars[ $key ] > 0 && $vars[ $key ] <= self::MAX_DIMENSION;
	}

	/** @param array<string,mixed> $vars */
	private static function pos_int( array $vars, string $key ): bool {
		return isset( $vars[ $key ] ) && is_int( $vars[ $key ] ) && $vars[ $key ] > 0;
	}

	/** A fresh refusal record. */
	private static function refuse( string $reason ): array {
		return array( 'ok' => false, 'edited' => false, 'reason' => $reason );
	}
}
