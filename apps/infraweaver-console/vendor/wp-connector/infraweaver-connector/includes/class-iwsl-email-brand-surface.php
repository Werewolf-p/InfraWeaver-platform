<?php
/**
 * The outgoing-email white-label surface (part of the gated `white_label` feature).
 *
 * Resolves ONE brand fragment from the sanitized settings: a header block —
 * logo `<img>` + brand name — that IWSL_Email_Delivery prepends to the HTML mail
 * the site sends, so a client's password-reset / notification emails carry the
 * operator's brand instead of a bare WordPress message. It contributes NOTHING
 * (an empty header) when `apply_to_email` is off, or when neither a logo nor a
 * brand name is set.
 *
 * Pure and side-effect free, exactly like the login/admin surfaces: it only reads
 * the settings map and returns already-escaped fragments — the engine
 * (IWSL_White_Label) owns the gate and the resolution, and the consumer
 * (IWSL_Email_Delivery) owns the prepend. Because the header is a pure function of
 * the settings, the White-Label admin tab can render a live preview from this same
 * resolve() output with no endpoint and no network. Every WordPress escaping call
 * is function_exists-guarded with a plain-PHP fallback so the surface resolves
 * identically under the zero-dependency harness.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Email_Brand_Surface implements IWSL_Brand_Surface {

	/** Rendered email logo max height (px) — matches typical transactional-mail headers. */
	const LOGO_MAX_HEIGHT = 48;

	public function id(): string {
		return 'email';
	}

	public function label(): string {
		return 'Outgoing email';
	}

	public function hooks(): array {
		// Documentation only (the engine/consumer own the wiring): the resolved
		// header is prepended to HTML `wp_mail` bodies.
		return array( 'wp_mail' );
	}

	/**
	 * Resolve the email fragment. `header_html` is a fully-escaped, self-contained
	 * block using inline styles (email clients strip <style>/<head>); it is '' unless
	 * `apply_to_email` is on AND at least one of logo/name is set. The logo URL rides
	 * an `<img src>` through esc_url; the brand name through esc_html; the accent
	 * (already validated to `#rrggbb`) through esc_attr. `active` reports whether the
	 * surface has anything to show, independent of the apply toggle, so the admin
	 * capability table / preview can reflect the configured-but-off state honestly.
	 *
	 * @param array<string, mixed> $settings
	 * @return array{ id:string, active:bool, apply:bool, header_html:string, logo_url:string, name:string, accent:string }
	 */
	public function resolve( array $settings ): array {
		$apply  = ! empty( $settings['apply_to_email'] );
		$logo   = isset( $settings['email_logo_url'] ) ? (string) $settings['email_logo_url'] : '';
		$name   = isset( $settings['brand_name'] ) ? (string) $settings['brand_name'] : '';
		$accent = isset( $settings['accent_color'] ) ? (string) $settings['accent_color'] : '';

		$has_content = ( '' !== $logo || '' !== $name );

		$header_html = '';
		if ( $apply && $has_content ) {
			$border = '' !== $accent ? self::esc_attr_g( $accent ) : '#e2e8f0';
			$inner  = '';
			if ( '' !== $logo ) {
				$src = self::esc_url_g( $logo );
				if ( '' !== $src ) {
					$inner .= '<img src="' . $src . '" alt="' . self::esc_attr_g( $name ) . '" '
						. 'style="max-height:' . (int) self::LOGO_MAX_HEIGHT . 'px;height:auto;border:0;display:inline-block;">';
				}
			}
			if ( '' !== $name ) {
				$color  = '' !== $accent ? self::esc_attr_g( $accent ) : '#0f172a';
				$inner .= '<div style="margin-top:8px;font-size:18px;font-weight:700;color:' . $color . ';">'
					. self::esc_html_g( $name ) . '</div>';
			}
			if ( '' !== $inner ) {
				$header_html = '<div style="padding:16px 0;margin-bottom:16px;'
					. 'border-bottom:2px solid ' . $border . ';text-align:center;">'
					. $inner . '</div>';
			}
		}

		return array(
			'id'          => $this->id(),
			'active'      => $has_content,
			'apply'       => $apply,
			'header_html' => $header_html,
			'logo_url'    => $logo,
			'name'        => $name,
			'accent'      => $accent,
		);
	}

	/** esc_html with a plain-PHP fallback for the no-WP harness. */
	private static function esc_html_g( string $value ): string {
		return function_exists( 'esc_html' )
			? (string) esc_html( $value )
			: htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	/** esc_attr with a plain-PHP fallback for the no-WP harness. */
	private static function esc_attr_g( string $value ): string {
		return function_exists( 'esc_attr' )
			? (string) esc_attr( $value )
			: htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	/** esc_url with a plain-PHP fallback for the no-WP harness. */
	private static function esc_url_g( string $value ): string {
		return function_exists( 'esc_url' )
			? (string) esc_url( $value )
			: htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}
}
