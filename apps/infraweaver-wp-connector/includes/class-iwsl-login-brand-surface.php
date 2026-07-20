<?php
/**
 * The login-page white-label surface (part of the gated `white_label` feature).
 *
 * Resolves the four login-screen brand fragments from the sanitized settings:
 *   - the logo CSS (a `.login h1 a { background-image: … }` rule),
 *   - the logo link URL (the wp-login.php header anchor href),
 *   - the logo link text (its title/alt text),
 *   - an optional message prepended above the login form.
 *
 * Pure and side-effect free: it only reads the settings map and returns escaped
 * fragments — the engine (IWSL_White_Label) owns the hooks, the gate, and the
 * echo. Every WordPress escaping call is function_exists-guarded with a plain-PHP
 * fallback so the surface resolves identically under the zero-dependency harness.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Login_Brand_Surface implements IWSL_Brand_Surface {

	/** Rendered logo box height (px) — matches WordPress's default login h1 a. */
	const LOGO_HEIGHT = 84;

	public function id(): string {
		return 'login';
	}

	public function label(): string {
		return 'Login screen';
	}

	public function hooks(): array {
		return array( 'login_enqueue_scripts', 'login_headerurl', 'login_headertext', 'login_message' );
	}

	/**
	 * Resolve the login fragments. `header_url` is returned RAW (already validated
	 * to a clean http(s)/rooted-relative URL by the engine) because core esc_url()s
	 * the `login_headerurl` filter result itself; every other dynamic value is
	 * escaped here.
	 *
	 * @param array<string, mixed> $settings
	 * @return array{ id:string, active:bool, logo_url:string, logo_css:string, header_url:string, header_text:string, message_html:string }
	 */
	public function resolve( array $settings ): array {
		$logo_url    = isset( $settings['login_logo_url'] ) ? (string) $settings['login_logo_url'] : '';
		$header_url  = isset( $settings['login_header_url'] ) ? (string) $settings['login_header_url'] : '';
		$header_text = isset( $settings['login_header_text'] ) ? (string) $settings['login_header_text'] : '';
		$message     = isset( $settings['login_message'] ) ? (string) $settings['login_message'] : '';

		$logo_css = '';
		if ( '' !== $logo_url ) {
			$css_url = self::css_url( $logo_url );
			if ( '' !== $css_url ) {
				$logo_css = '.login h1 a{background-image:url("' . $css_url . '");'
					. 'background-size:contain;background-position:center center;'
					. 'width:auto;height:' . (int) self::LOGO_HEIGHT . 'px;}';
			}
		}

		$message_html = '' === $message
			? ''
			: '<p class="message">' . self::esc_html_g( $message ) . '</p>' . "\n";

		return array(
			'id'           => $this->id(),
			'active'       => ( '' !== $logo_url || '' !== $header_url || '' !== $header_text || '' !== $message ),
			'logo_url'     => $logo_url,
			'logo_css'     => $logo_css,
			'header_url'   => $header_url,
			// Escaped: core echoes the `login_headertext` filter result verbatim.
			'header_text'  => '' === $header_text ? '' : self::esc_html_g( $header_text ),
			'message_html' => $message_html,
		);
	}

	/**
	 * A CSS-context-safe URL for `url("…")`. Refuses any byte that could break out
	 * of the quoted url() token, then esc_url()s when WordPress is present. Returns
	 * '' when the URL is unsafe, so the caller emits no rule at all.
	 */
	private static function css_url( string $url ): string {
		if ( preg_match( '/["\'()\\\\\s]/', $url ) ) {
			return '';
		}
		return function_exists( 'esc_url' ) ? (string) esc_url( $url ) : $url;
	}

	/** esc_html with a plain-PHP fallback for the no-WP harness. */
	private static function esc_html_g( string $value ): string {
		return function_exists( 'esc_html' )
			? (string) esc_html( $value )
			: htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}
}
