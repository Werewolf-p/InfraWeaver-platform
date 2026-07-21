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
