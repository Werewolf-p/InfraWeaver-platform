<?php
/**
 * Shared "?" field-help badge. One plain-English, no-jargon line per input,
 * revealed on hover or keyboard focus (aria-label carries it to screen readers).
 *
 * A plain function (not a class method) so every render_section() across the
 * engines can call it without coupling to IWSL_Admin, and so the test harness —
 * which loads the engines but not the admin class — can render sections freely.
 * The `.iwsl-help` styles ship with the card layout (render_cards_styles), which
 * wraps every section, so the badge is always styled where it appears.
 */

defined( 'ABSPATH' ) || exit;

if ( ! function_exists( 'iwsl_field_help' ) ) {
	/**
	 * Return the markup for a "?" help badge with a plain-English explanation.
	 * Empty text → empty string (renders nothing). Escaping is applied here so
	 * callers pass a raw human sentence.
	 */
	function iwsl_field_help( string $text ): string {
		if ( '' === $text ) {
			return '';
		}
		$attr = function_exists( 'esc_attr' ) ? esc_attr( $text ) : htmlspecialchars( $text, ENT_QUOTES );
		$html = function_exists( 'esc_html' ) ? esc_html( $text ) : htmlspecialchars( $text, ENT_QUOTES );
		return '<span class="iwsl-help iwsl-help--field" tabindex="0" role="note" aria-label="' . $attr . '">'
			. '<span class="iwsl-help__q" aria-hidden="true">?</span>'
			. '<span class="iwsl-help__tip" aria-hidden="true">' . $html . '</span>'
			. '</span>';
	}
}

if ( ! function_exists( 'iwsl_plus_redirect_base' ) ) {
	/**
	 * The URL an admin-post/settings handler should send the operator BACK to
	 * after a save: the SAME InfraWeaver Plus category sub-page the form was
	 * submitted from — so a button press keeps them on the section they were
	 * working in, instead of bouncing to the Overview dashboard.
	 *
	 * Only the safe `page` slug is read from the request referer, and only when
	 * it starts with `infraweaver-plus` (our own pages); any other referer, or
	 * none, falls back to the main page. The slug is hard-sanitised to
	 * `[a-z0-9-]`, and every query result-flag on the referer is dropped so they
	 * never accumulate across successive saves. A shared plain function (not a
	 * method) so every engine's handler can reuse it without coupling to
	 * IWSL_Admin and so the WP-less test harness can exercise it.
	 */
	function iwsl_plus_redirect_base(): string {
		$page = 'infraweaver-plus';
		$back = function_exists( 'wp_get_referer' ) ? wp_get_referer() : '';
		if ( is_string( $back ) && '' !== $back ) {
			$query = function_exists( 'wp_parse_url' ) ? wp_parse_url( $back, PHP_URL_QUERY ) : parse_url( $back, PHP_URL_QUERY );
			if ( is_string( $query ) && '' !== $query ) {
				$vars = array();
				parse_str( $query, $vars );
				if ( isset( $vars['page'] ) && is_string( $vars['page'] ) && 0 === strpos( $vars['page'], 'infraweaver-plus' ) ) {
					$slug = preg_replace( '/[^a-z0-9\-]/', '', $vars['page'] );
					if ( is_string( $slug ) && '' !== $slug ) {
						$page = $slug;
					}
				}
			}
		}
		return function_exists( 'admin_url' )
			? admin_url( 'admin.php?page=' . $page )
			: 'admin.php?page=' . $page;
	}
}
