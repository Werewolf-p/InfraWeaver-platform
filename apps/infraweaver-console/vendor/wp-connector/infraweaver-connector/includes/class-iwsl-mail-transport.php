<?php
/**
 * Mail-transport strategy contract for the gated "SMTP delivery & email log"
 * feature (gate flag `email_delivery`). A transport is a pure, side-effect-scoped
 * configurator: given a mailer object plus already-validated settings and the
 * effective password, it applies delivery configuration to the mailer and reports
 * an immutable outcome. It never sends, never touches the message body/headers,
 * never talks to the network on its own, and never shells out — configuration is
 * in-process only.
 *
 * The generic engine (IWSL_Email_Delivery) owns the entitlement gate, the
 * settings/log store, credential sourcing (wp-config constant first), whitelist
 * logging and redaction. A transport owns exactly one thing: mapping the stored
 * settings onto a mailer. Adding a new transport is therefore one class
 * implementing this interface plus one line in IWSL_Email_Delivery::transports().
 */

defined( 'ABSPATH' ) || exit;

interface IWSL_Mail_Transport {

	/** Stable id, shape `[a-z0-9_]{1,32}`. Registry key and wire token, e.g. 'smtp'. */
	public function id(): string;

	/** Human label for the admin capability copy, e.g. 'SMTP (PHPMailer)'. */
	public function label(): string;

	/**
	 * Side-effect-free capability probe: is this transport usable in-process? Never
	 * connects, never writes, never allocates — safe to call on every admin render.
	 *
	 * @return array{ ok:bool, reason:string }
	 */
	public function availability(): array;

	/**
	 * Apply $settings + $password to a mailer object. Duck-typed: EVERY property
	 * and method access must be method_exists/property_exists-guarded so a recording
	 * fake works and the no-WP test harness never fatals on a missing member. Reads
	 * ONLY delivery configuration from $settings (host/port/auth/username/secure);
	 * it MUST NOT read a stored password out of $settings — the caller passes the
	 * effective secret as $password. Returns an immutable outcome.
	 *
	 * @param object|mixed $phpmailer The mailer to configure (WP's PHPMailer at runtime).
	 * @param array        $settings  Validated settings, password already stripped.
	 * @param string       $password  The effective password (constant or opted-in option).
	 * @return array{ ok:bool, reason:string }
	 */
	public function configure( $phpmailer, array $settings, string $password ): array;
}
