<?php
/**
 * The one concrete IWSL_Mail_Transport: route wp_mail() through an SMTP server by
 * configuring WordPress's own PHPMailer instance on `phpmailer_init`. Nothing is
 * sent from here — WordPress sends. This class only maps the console-managed
 * settings onto the mailer, and only the delivery fields: it never sets Sender,
 * never adds headers, and never reads the message body.
 *
 * Duck-typed by design: every member access is property_exists / method_exists
 * guarded so the recording fake in the zero-dependency test harness (and any
 * future mailer shape) works without a real PHPMailer, and so a stripped-down
 * mailer never fatals the request.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_SMTP_Transport implements IWSL_Mail_Transport {

	public function id(): string {
		return 'smtp';
	}

	public function label(): string {
		return 'SMTP (PHPMailer)';
	}

	/**
	 * SMTP configuration is in-process (it only sets properties on the mailer
	 * WordPress already built), so the transport is always available. Side-effect
	 * free — no connection, no allocation.
	 *
	 * @return array{ ok:bool, reason:string }
	 */
	public function availability(): array {
		return array( 'ok' => true, 'reason' => '' );
	}

	/**
	 * Apply, in order: isSMTP(), Host, Port (int), SMTPAuth (bool), Username,
	 * Password, SMTPSecure ('' | 'ssl' | 'tls'). Nothing else. Password comes ONLY
	 * from the $password argument (the engine's effective secret), never from
	 * $settings. Every access is guarded so a recording fake / partial mailer is safe.
	 *
	 * @return array{ ok:bool, reason:string }
	 */
	public function configure( $phpmailer, array $settings, string $password ): array {
		if ( ! is_object( $phpmailer ) ) {
			return array( 'ok' => false, 'reason' => 'no-mailer' );
		}

		if ( method_exists( $phpmailer, 'isSMTP' ) ) {
			$phpmailer->isSMTP();
		}

		self::set_prop( $phpmailer, 'Host', isset( $settings['host'] ) ? (string) $settings['host'] : '' );
		self::set_prop( $phpmailer, 'Port', isset( $settings['port'] ) ? (int) $settings['port'] : 0 );
		self::set_prop( $phpmailer, 'SMTPAuth', ! empty( $settings['auth'] ) );
		self::set_prop( $phpmailer, 'Username', isset( $settings['username'] ) ? (string) $settings['username'] : '' );
		self::set_prop( $phpmailer, 'Password', $password );
		self::set_prop( $phpmailer, 'SMTPSecure', isset( $settings['secure'] ) ? (string) $settings['secure'] : '' );

		return array( 'ok' => true, 'reason' => '' );
	}

	/**
	 * Guarded property write — only assigns a declared property, so a recording
	 * fake (or any mailer missing the member) is never fataled.
	 *
	 * @param object $obj
	 * @param mixed  $value
	 */
	private static function set_prop( $obj, string $prop, $value ): void {
		if ( property_exists( $obj, $prop ) ) {
			$obj->$prop = $value;
		}
	}
}
