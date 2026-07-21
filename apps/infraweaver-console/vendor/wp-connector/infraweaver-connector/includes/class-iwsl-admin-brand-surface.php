<?php
/**
 * The wp-admin white-label surface (part of the gated `white_label` feature).
 *
 * Resolves the two admin-area brand fragments from the sanitized settings:
 *   - a replacement for the "Thank you for creating with WordPress" footer credit,
 *   - a flag to remove the WordPress logo node from the admin bar.
 *
 * Pure and side-effect free: it only reads the settings map and returns escaped
 * fragments — the engine (IWSL_White_Label) owns the hooks, the gate, and the
 * effect (echo / admin-bar node removal). Escaping is function_exists-guarded so
 * the surface resolves identically under the zero-dependency harness.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Admin_Brand_Surface implements IWSL_Brand_Surface {

	public function id(): string {
		return 'admin';
	}

	public function label(): string {
		return 'Admin area';
	}

	public function hooks(): array {
		return array( 'admin_footer_text', 'wp_before_admin_bar_render' );
	}

	/**
	 * Resolve the admin fragments. The footer is escaped and wrapped in the same
	 * `#footer-thankyou` span WordPress uses, so it slots into the admin footer
	 * without layout drift.
	 *
	 * @param array<string, mixed> $settings
	 * @return array{ id:string, active:bool, footer_html:string, hide_wp_logo:bool }
	 */
	public function resolve( array $settings ): array {
		$footer       = isset( $settings['admin_footer_text'] ) ? (string) $settings['admin_footer_text'] : '';
		$hide_wp_logo = ! empty( $settings['hide_wp_logo'] );

		$footer_html = '' === $footer
			? ''
			: '<span id="footer-thankyou">' . self::esc_html_g( $footer ) . '</span>';

		return array(
			'id'           => $this->id(),
			'active'       => ( '' !== $footer || $hide_wp_logo ),
			'footer_html'  => $footer_html,
			'hide_wp_logo' => $hide_wp_logo,
		);
	}

	/** esc_html with a plain-PHP fallback for the no-WP harness. */
	private static function esc_html_g( string $value ): string {
		return function_exists( 'esc_html' )
			? (string) esc_html( $value )
			: htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}
}
