<?php
/**
 * Automatic image ALT text for the SEO Suite (shares the `seo_suite` gate — this
 * class carries NO FEATURE flag of its own and is never entitlement-checked here;
 * the check lives in IWSL_SEO_Suite, which owns the `add_attachment` hook).
 *
 * WHY. Missing alt text hurts both accessibility and image SEO. Yoast leaves the
 * field blank; Rank Math needs you to configure a variable template. We fill it
 * deterministically on upload with zero configuration — and NEVER overwrite an
 * alt an author wrote, so it is purely additive.
 *
 * PURITY. derive() / humanize_filename() / resolve_fill() are pure, WordPress-free
 * and unit-tested with plain strings. The WP glue (reading the attachment,
 * writing `_wp_attachment_image_alt`) lives in IWSL_SEO_Suite::auto_fill_alt_text()
 * behind the same gate + function_exists guards as the rest of the engine.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_SEO_Alt_Text {

	/** The core meta key WordPress stores an attachment's alt text under. */
	const ALT_META_KEY = '_wp_attachment_image_alt';

	/**
	 * Derive an alt string from the available signals in strict precedence:
	 *   1. the attachment title (what the author named the image), else
	 *   2. the humanized filename (extension stripped, -/_ → space, Title Case), else
	 *   3. the parent post's title.
	 * Returns '' only when every signal is empty.
	 */
	public static function derive( string $title, string $filename, string $parent_title ): string {
		$title = self::clean( $title );
		if ( '' !== $title ) {
			return $title;
		}
		$humanized = self::humanize_filename( $filename );
		if ( '' !== $humanized ) {
			return $humanized;
		}
		return self::clean( $parent_title );
	}

	/**
	 * Turn a bare filename into human-readable words: drop any path, strip a
	 * trailing extension, turn `-` / `_` runs into spaces, collapse whitespace and
	 * Title Case the result. `coffee-grinder_photo.JPG` → `Coffee Grinder Photo`.
	 * Returns '' for an empty / extension-only input.
	 */
	public static function humanize_filename( string $filename ): string {
		$name = self::clean( $filename );
		if ( '' === $name ) {
			return '';
		}
		$name = basename( $name );
		$name = preg_replace( '/\.[A-Za-z0-9]{1,8}$/', '', $name ) ?? $name; // strip extension.
		$name = str_replace( array( '-', '_' ), ' ', $name );
		$name = preg_replace( '/\s+/u', ' ', $name ) ?? $name;
		$name = trim( $name );
		if ( '' === $name ) {
			return '';
		}
		return self::title_case( $name );
	}

	/**
	 * The pure fill decision: given the CURRENT stored alt and the derivation
	 * inputs, return the alt to WRITE, or null when nothing should be written —
	 * either an author already wrote an alt (NEVER overwritten) or nothing could
	 * be derived. This is where the "never clobber" invariant lives, so it is unit
	 * testable without WordPress.
	 */
	public static function resolve_fill( string $current_alt, string $title, string $filename, string $parent_title ): ?string {
		if ( '' !== trim( $current_alt ) ) {
			return null; // Author-written alt — leave it untouched.
		}
		$derived = self::derive( $title, $filename, $parent_title );
		return '' !== $derived ? $derived : null;
	}

	// ── helpers ─────────────────────────────────────────────────────────────────

	/** Strip control chars, collapse whitespace, trim. */
	private static function clean( string $s ): string {
		$s = preg_replace( '/[\x00-\x1F\x7F]+/u', ' ', $s ) ?? '';
		$s = preg_replace( '/\s+/u', ' ', $s ) ?? $s;
		return trim( $s );
	}

	/** Title Case (mb-aware when the mbstring extension is present). */
	private static function title_case( string $s ): string {
		if ( function_exists( 'mb_convert_case' ) ) {
			return mb_convert_case( $s, MB_CASE_TITLE, 'UTF-8' );
		}
		return ucwords( strtolower( $s ) );
	}
}
