<?php
/**
 * IWSL Connector runtime — wires verifier + enrollment + rotation + responder
 * to the REST surface. Allow-listed ops only (§7); phase 1–2 ships the
 * protocol/enrollment/rotation set, fleet ops arrive with phase 4 dispatch.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Plugin {

	/** @var IWSL_Store */
	private $store;

	/** @var IWSL_Verifier */
	private $verifier;

	/** @var IWSL_Enrollment */
	private $enrollment;

	/** @var IWSL_Rotation */
	private $rotation;

	/** @var IWSL_Responder */
	private $responder;

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Email_Delivery|null lazily built from the plugin's store + entitlements. */
	private $email_delivery;

	/** @var IWSL_Statistics|null lazily built from the plugin's store + entitlements. */
	private $statistics;

	/** @var IWSL_Activity_Log|null lazily built from the plugin's store + entitlements. */
	private $activity_log;

	/** @var callable|null shared clock, threaded into lazily-built payloads. */
	private $now_ms;

	/** @var array<string, IWSL_Command_Handler> the command registry (§7), method-keyed. */
	private $handlers;

	public function __construct( IWSL_Store $store, ?callable $now_ms = null ) {
		$this->store        = $store;
		$this->now_ms       = $now_ms;
		$this->enrollment   = new IWSL_Enrollment( $store, $now_ms );
		$this->rotation     = new IWSL_Rotation( $store );
		$this->responder    = new IWSL_Responder( $store, $this->rotation, $now_ms );
		$this->entitlements = new IWSL_Entitlements( $store, $now_ms );
		$this->handlers     = self::command_handlers();
		// Verifier allow-list is derived from the same registry — no parallel list.
		$this->verifier     = new IWSL_Verifier( $store, self::validators( $this->handlers ), $now_ms );
	}

	public function store(): IWSL_Store {
		return $this->store;
	}

	public function enrollment(): IWSL_Enrollment {
		return $this->enrollment;
	}

	public function entitlements(): IWSL_Entitlements {
		return $this->entitlements;
	}

	/**
	 * The SMTP delivery & email-log engine (gate flag `email_delivery`), built once
	 * from the plugin's own entitlement gate + store and the shared clock. Lazy so a
	 * request that never sends mail forces no object graph.
	 */
	public function email_delivery(): IWSL_Email_Delivery {
		if ( null === $this->email_delivery ) {
			$this->email_delivery = new IWSL_Email_Delivery( $this->entitlements, $this->store, $this->now_ms );
		}
		return $this->email_delivery;
	}

	/**
	 * The first-party statistics engine (gate flag `statistics`), built once from the
	 * plugin's own entitlement gate + store + shared clock. Lazy so a request that never
	 * reads traffic forces no object graph. The $wpdb handle defaults to the global one
	 * (null under the harness → the engine degrades to bounded empty reads).
	 */
	public function statistics(): IWSL_Statistics {
		if ( null === $this->statistics ) {
			$this->statistics = new IWSL_Statistics( $this->entitlements, $this->store, null, $this->now_ms );
		}
		return $this->statistics;
	}

	/**
	 * The admin activity-log engine (gate flag `activity_log`), built once from the
	 * plugin's entitlement gate + store + shared clock. Lazy, mirroring email_delivery().
	 */
	public function activity_log(): IWSL_Activity_Log {
		if ( null === $this->activity_log ) {
			$this->activity_log = new IWSL_Activity_Log( $this->entitlements, $this->store, $this->now_ms );
		}
		return $this->activity_log;
	}

	public function rotation(): IWSL_Rotation {
		return $this->rotation;
	}

	/**
	 * Verifier allow-list (§7), derived from the command registry so the method
	 * set has one definition point. Shape unchanged: method => validator|null.
	 *
	 * @return array<string, callable|null>
	 */
	public static function allowed_methods(): array {
		return self::validators( self::command_handlers() );
	}

	/**
	 * The current signed commands (§6/§7). Single source of truth: both the
	 * verifier allow-list and `execute()` dispatch derive from this. Runners are
	 * closures scoped to this class, so they reach the private store/rotation/
	 * debug surface without any of it going public.
	 *
	 * @return array<string, IWSL_Command_Handler>
	 */
	private static function command_handlers(): array {
		$rotation_params = static function ( $params ): bool {
			$vars = get_object_vars( $params );
			return isset( $vars['rotation_id'] ) && is_string( $vars['rotation_id'] )
				&& '' !== $vars['rotation_id']
				&& ( ! isset( $vars['new_kid'] ) || is_int( $vars['new_kid'] ) )
				&& array() === array_diff_key( $vars, array( 'rotation_id' => 1, 'new_kid' => 1 ) );
		};

		$handlers = array(
			new IWSL_Command_Handler(
				'health.check',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$result = array(
						'status' => 'ok',
						'php'    => PHP_VERSION,
						'plugin' => defined( 'IWSL_CONNECTOR_VERSION' ) ? IWSL_CONNECTOR_VERSION : 'dev',
						'kid'    => $plugin->rotation->signing_kid(),
						'seq'    => (int) $plugin->store->get( 'last_seq', 0 ),
					);
					// §5 clone/identity-crisis self-report: the site's OWN live
					// canonical URL, carried inside this Ed25519-signed response so
					// the console reads it only after verifying the signature. A
					// clone (DB + keys copied to another domain) still answers a
					// valid signature but reports ITS url — the one thing it can't
					// fake. Omitted when WP can't resolve a URL (never a false crisis).
					$site_url = self::canonical_site_url();
					if ( null !== $site_url ) {
						$result['site_url'] = $site_url;
					}
					// §8 observability: last signing-key reroll outcome, so the
					// console keeps "Last reroll" fresh from the signed channel on
					// every hourly sweep (not only right after an operator reroll).
					$last_reroll = $plugin->rotation->last_reroll();
					if ( null !== $last_reroll ) {
						$result['last_reroll'] = $last_reroll;
					}
					return array( true, $result );
				}
			),
			new IWSL_Command_Handler(
				'debug.status',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					return array( true, $plugin->debug_status() );
				}
			),
			new IWSL_Command_Handler(
				'metrics.snapshot',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// Read-only numeric telemetry over the SAME signed channel as
					// health.check — the console verifies this response against the
					// pinned WP-PK before it trusts a single gauge, so a scraped
					// value can't be forged in transit. No params, no key material,
					// no state change (never signs-with-current, never wipes).
					return array( true, $plugin->metrics_snapshot() );
				}
			),
			// ── analytics/insights (§ analytics) ──────────────────────────────────
			// Three READ-ONLY methods behind the console's Insights surface, over the
			// same signed channel as metrics.snapshot. STATEMENT 1 of each engine
			// projection is the entitlement gate; a locked site answers a signed
			// { locked, gate } so the console renders the real reasons (never fake
			// numbers). Only bounded AGGREGATES cross the wire — the drill island,
			// heatmap and raw hit rows stay WP-side; byte budgets guard the §6.2
			// ceiling. No params mutate state (never signs-with-current, never wipes).
			new IWSL_Command_Handler(
				'stats.summary',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$params = get_object_vars( $envelope->params );
					$range  = isset( $params['range_days'] ) ? (int) $params['range_days'] : IWSL_Statistics::DEFAULT_RANGE;
					return array( true, $plugin->statistics()->wire_summary( $range ) );
				},
				array( 'IWSL_Statistics', 'validate_summary_params' )
			),
			new IWSL_Command_Handler(
				'stats.timeseries',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$params = get_object_vars( $envelope->params );
					$days   = isset( $params['days'] ) ? (int) $params['days'] : IWSL_Stats_Classifier::SERIES_DAYS;
					return array( true, $plugin->statistics()->wire_timeseries( $days ) );
				},
				array( 'IWSL_Statistics', 'validate_timeseries_params' )
			),
			new IWSL_Command_Handler(
				'activity.log',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$params = get_object_vars( $envelope->params );
					$limit  = isset( $params['limit'] ) ? (int) $params['limit'] : IWSL_Activity_Log::WIRE_DEFAULT_LIMIT;
					return array( true, $plugin->activity_log()->wire_log( $limit ) );
				},
				array( 'IWSL_Activity_Log', 'validate_log_params' )
			),
			new IWSL_Command_Handler(
				'key.rotate.self',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$params = get_object_vars( $envelope->params );
					$result = $plugin->rotation->prepare(
						(string) $params['rotation_id'],
						isset( $params['new_kid'] ) ? (int) $params['new_kid'] : (int) $plugin->store->get( 'wp_current_kid', 1 ) + 1
					);
					return array(
						$result['ok'],
						$result['ok']
							? array( 'new_wp_pk' => $result['new_wp_pk'] )
							: array( 'reason' => $result['reason'] ),
					);
				},
				$rotation_params,
				true // §8 chain of custody: PREPARE signs under the current confirmed key.
			),
			new IWSL_Command_Handler(
				'key.rotate.confirm',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$params = get_object_vars( $envelope->params );
					$result = $plugin->rotation->confirm( (string) $params['rotation_id'] );
					return array( $result['ok'], $result['ok'] ? array() : array( 'reason' => $result['reason'] ) );
				},
				$rotation_params
			),
			new IWSL_Command_Handler(
				'key.rotate.abort',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$params = get_object_vars( $envelope->params );
					$plugin->rotation->abort( (string) $params['rotation_id'] );
					return array( true, array() );
				},
				$rotation_params
			),
			new IWSL_Command_Handler(
				'site.deactivate',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					return array( true, array( 'deactivated' => true ) );
				},
				null,
				false,
				true // §8 kill switch: wipe after the response is built.
			),
			new IWSL_Command_Handler(
				'link.purge',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// §12.6 delete: the console is tearing this site down and asks the
					// plugin to scrub its own enrollment state FIRST, while the pod is
					// still reachable, so a reused/restored database can never leave a
					// re-enroll-blocking `iwsl_*` orphan (the bug that already bit a
					// site). Reuses the exact `wipe()` the kill switch runs — the
					// signed response is built and verified BEFORE the wipe, so the
					// console still confirms the purge end-to-end. Idempotent: a fresh
					// or half-enrolled store wipes to the same clean `unenrolled` slate.
					return array( true, array( 'purged' => true ) );
				},
				null,
				false,
				true // §12.6: wipe all local IWSL state after answering.
			),
			new IWSL_Command_Handler(
				'entitlements.set',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// Paid-feature entitlements — console-authoritative, writable ONLY
					// through this dual-signed method. The verifier already proved the
					// command came from the console (the site can't self-grant a flag),
					// so the plugin stores exactly what was pushed. The map is general
					// so future paid flags need no new method.
					$stored = $plugin->entitlements()->apply( $envelope->params->entitlements );
					return array( true, array( 'entitlements' => $stored ) );
				},
				array( 'IWSL_Entitlements', 'validate_params' )
			),
		);

		$by_method = array();
		foreach ( $handlers as $handler ) {
			$by_method[ $handler->method ] = $handler;
		}
		return $by_method;
	}

	/**
	 * Project a registry to the verifier's method => validator allow-list.
	 *
	 * @param array<string, IWSL_Command_Handler> $handlers
	 * @return array<string, callable|null>
	 */
	private static function validators( array $handlers ): array {
		$out = array();
		foreach ( $handlers as $method => $handler ) {
			$out[ $method ] = $handler->validator;
		}
		return $out;
	}

	/**
	 * Handle a signed command wire object (decoded JSON, stdClass mode).
	 *
	 * @param mixed  $wire    The decoded { envelope, sigs } command.
	 * @param string $channel Ingress transport ('exec' via wp-cli eval, 'https'
	 *                        via the REST /command route). Matched against the
	 *                        signed §6.4 aud.chan binding. Defaults to 'exec'.
	 * @return array ['status' => int, 'body' => array]
	 */
	public function handle_command( $wire, string $channel = 'exec' ): array {
		$state = $this->store->get( 'state', 'unenrolled' );
		if ( 'pending' !== $state && 'active' !== $state ) {
			return array( 'status' => 403, 'body' => array( 'ok' => false, 'reason' => 'not-enrolled' ) );
		}
		$verdict = $this->verifier->verify_command( $wire, $channel );
		if ( ! $verdict['ok'] ) {
			return array( 'status' => 403, 'body' => array( 'ok' => false, 'reason' => $verdict['reason'] ) );
		}
		$envelope = $verdict['envelope'];

		// Heartbeat: a verified command is a signature-authenticated contact from
		// the console. Stamp it on the verifier's success path (before dispatch, so
		// even a wiping command counts as fresh) — the client-side feature gate
		// judges heartbeat freshness from this, and it can only be advanced by a
		// valid dual signature, never by an unauthenticated request.
		$this->entitlements->record_verified_contact();

		// Verifier already enforced the allow-list, so a handler always exists;
		// guard defensively regardless (a null handler cannot dispatch).
		$handler = $this->handlers[ $envelope->method ] ?? null;
		if ( null === $handler ) {
			return array( 'status' => 403, 'body' => array( 'ok' => false, 'reason' => 'unknown-method' ) );
		}

		// First verified command completes §5 step 3–4: burn secret, drop proof.
		$this->enrollment->activate();

		// §8 chain of custody: a PREPARE response is signed by the current
		// CONFIRMED key — the new key only proves itself in VERIFY.
		$sign_kid = $handler->signs_with_current_kid
			? (int) $this->store->get( 'wp_current_kid', 1 )
			: null;

		list( $ok, $result ) = $handler->run( $this, $envelope );
		$response = $this->responder->build( $envelope->nonce, $ok, $result, $sign_kid );
		if ( null === $response ) {
			return array( 'status' => 500, 'body' => array( 'ok' => false, 'reason' => 'internal' ) );
		}
		if ( $handler->wipes_after ) {
			$this->wipe(); // §8 kill switch — respond, then forget everything.
		}
		return array( 'status' => 200, 'body' => $response );
	}

	/**
	 * Structured link diagnostics over the signed channel (§12.5) — everything
	 * `wp infraweaver status` prints, plus runtime facts, as data the console
	 * can render. Read-only; exposes no key material (fingerprints only).
	 */
	private function debug_status(): array {
		$wp_kid  = (int) $this->store->get( 'wp_current_kid', 0 );
		$iw_kid  = (int) $this->store->get( 'iw_current_kid', 0 );
		$wp_pair = $this->store->get( 'wp_keys.' . $wp_kid );
		$iw_keys = $this->store->get( 'iw_keys.' . $iw_kid );
		$pending = $this->store->get( 'pending_rotation' );
		$reject  = $this->store->get( 'last_rejection' );
		$nonces  = $this->store->get( 'nonces', array() );
		return array(
			'state'          => (string) $this->store->get( 'state', 'unenrolled' ),
			'plugin'         => defined( 'IWSL_CONNECTOR_VERSION' ) ? IWSL_CONNECTOR_VERSION : 'dev',
			'php'            => PHP_VERSION,
			// §5 clone/identity-crisis self-report — same live canonical URL the
			// signed health.check carries, exposed in deep diagnostics too.
			'site_url'       => self::canonical_site_url(),
			'wp'             => function_exists( 'get_bloginfo' ) ? (string) get_bloginfo( 'version' ) : null,
			'time_ms'        => (int) round( microtime( true ) * 1000 ),
			'sodium'         => function_exists( 'sodium_crypto_sign_verify_detached' ),
			'wp_kid'         => $wp_kid,
			'iw_kid'         => $iw_kid,
			'wp_epoch_floor' => (int) $this->store->get( 'wp_epoch_floor', 0 ),
			'iw_epoch_floor' => (int) $this->store->get( 'iw_epoch_floor', 0 ),
			'wp_fingerprint' => is_array( $wp_pair ) ? IWSL_Crypto::fingerprint( $wp_pair['pk'] ) : null,
			'iw_fingerprint' => is_array( $iw_keys ) ? IWSL_Crypto::iw_fingerprint( $iw_keys ) : null,
			'iw_pq_alg'      => is_array( $iw_keys ) ? IWSL_Crypto::pinned_slhdsa_alg( $iw_keys ) : null,
			'last_seq'       => (int) $this->store->get( 'last_seq', 0 ),
			'nonce_cache'    => is_array( $nonces ) ? count( $nonces ) : 0,
			'rotation'       => is_array( $pending )
				? array( 'phase' => 'pending', 'new_kid' => (int) $pending['new_kid'] )
				: null,
			'last_reroll'    => $this->rotation->last_reroll(),
			'last_rejection' => is_array( $reject )
				? array( 'reason' => (string) $reject['reason'], 'ts' => (int) $reject['ts'] )
				: null,
			// Paid-feature entitlement state, echoed so the console can reconcile
			// what the plugin actually stored against what it pushed (drift check).
			// `last_verified_at` is the heartbeat the client-side gate reads.
			'entitlements'     => $this->entitlements->all(),
			'last_verified_at' => $this->entitlements->last_verified_at(),
			'plus_gate'        => $this->entitlements->evaluate( 'plus' ),
		);
	}

	/**
	 * Numeric/scalar telemetry for the console's Prometheus exporter, carried over
	 * the signed `metrics.snapshot` command. A curated, gauge-shaped projection of
	 * the same state debug_status() exposes — no fingerprints, no key material, no
	 * live URL (health.check owns §5 identity): just counters the console renders
	 * as `iwsl_connector_*` series. Booleans are emitted as 0/1 and every count
	 * defaults to 0 so a fresh/partial store yields a well-formed sample, never a
	 * gap. `time_ms` is the plugin's own clock (skew detection); string versions
	 * ride into the exporter's `_info` label gauge.
	 */
	private function metrics_snapshot(): array {
		$nonces  = $this->store->get( 'nonces', array() );
		$pending = $this->store->get( 'pending_rotation' );
		$reroll  = $this->rotation->last_reroll();
		return array(
			'plugin'           => defined( 'IWSL_CONNECTOR_VERSION' ) ? IWSL_CONNECTOR_VERSION : 'dev',
			'php'              => PHP_VERSION,
			'wp'               => function_exists( 'get_bloginfo' ) ? (string) get_bloginfo( 'version' ) : null,
			'time_ms'          => (int) round( microtime( true ) * 1000 ),
			'sodium'           => function_exists( 'sodium_crypto_sign_verify_detached' ) ? 1 : 0,
			'wp_kid'           => (int) $this->store->get( 'wp_current_kid', 0 ),
			'iw_kid'           => (int) $this->store->get( 'iw_current_kid', 0 ),
			'wp_epoch_floor'   => (int) $this->store->get( 'wp_epoch_floor', 0 ),
			'iw_epoch_floor'   => (int) $this->store->get( 'iw_epoch_floor', 0 ),
			'last_seq'         => (int) $this->store->get( 'last_seq', 0 ),
			'nonce_cache'      => is_array( $nonces ) ? count( $nonces ) : 0,
			'rotation_pending' => is_array( $pending ) ? 1 : 0,
			// Last signing-key reroll (§8): unix seconds + a 0/1 success flag, 0
			// when the site has never rerolled. Lets the console alert on a reroll
			// that aborted or a key that has gone too long without one.
			'last_reroll_at'   => is_array( $reroll ) ? (int) $reroll['at'] : 0,
			'last_reroll_ok'   => is_array( $reroll ) && ! empty( $reroll['ok'] ) ? 1 : 0,
		);
	}

	/**
	 * The site's own canonical URL (§5 identity binding), read LIVE from WordPress
	 * on every call — never cached in IWSL state. That liveness is the whole point:
	 * a clone of the database (site_id + keys and all) reports the URL of whatever
	 * domain it is actually served from, so the console can catch the mismatch.
	 * Prefers the Site Address (`home`) over the WP Address (`siteurl`). Returns
	 * null when no WordPress URL is resolvable (e.g. a bare CLI/test context) so
	 * the console degrades to "no signal" rather than a false identity crisis.
	 */
	private static function canonical_site_url(): ?string {
		$url = null;
		if ( function_exists( 'home_url' ) ) {
			$url = home_url();
		} elseif ( function_exists( 'get_option' ) ) {
			$url = get_option( 'home' );
			if ( ! is_string( $url ) || '' === $url ) {
				$url = get_option( 'siteurl' );
			}
		}
		if ( ! is_string( $url ) || '' === $url ) {
			return null;
		}
		// Cap to the console's MAX_URL_LEN. An oversized `home` (needs wp-admin/DB
		// write access) would otherwise bloat the signed result toward the §6.2
		// byte ceiling and get the whole response rejected as `result-too-large`
		// — a self-inflicted quarantine. Degrade to "no signal" instead.
		return strlen( $url ) <= 2048 ? $url : null;
	}

	/** §8 kill switch: wipe WP-SK, pinned IW-PK, and all local IWSL state. */
	private function wipe(): void {
		$pending  = $this->store->get( 'pending_rotation' );
		$max_kid  = max(
			(int) $this->store->get( 'wp_current_kid', 1 ),
			(int) $this->store->get( 'iw_current_kid', 1 ),
			is_array( $pending ) ? (int) $pending['new_kid'] : 1
		) + 1;
		for ( $kid = 1; $kid <= $max_kid; $kid++ ) {
			$this->store->delete( 'wp_keys.' . $kid );
			$this->store->delete( 'iw_keys.' . $kid );
		}
		// Per-nonce replay claims live as individual `nonce.<n>` options (§6.3
		// atomic guard); enumerate them from the aggregate ledger and drop each so
		// the kill switch leaves no replay state behind. Must run before the loop
		// below deletes the `nonces` ledger itself.
		$nonces = $this->store->get( 'nonces', array() );
		if ( is_array( $nonces ) ) {
			foreach ( array_keys( $nonces ) as $nonce ) {
				$this->store->delete( 'nonce.' . (string) $nonce );
			}
		}
		foreach (
			array(
				'state', 'site_id', 'enroll_secret', 'last_seq', 'nonces',
				'wp_current_kid', 'wp_epoch_floor', 'iw_current_kid',
				'iw_epoch_floor', 'pending_rotation', 'last_confirmed_rotation',
				'last_rejection', 'enroll_claim',
				// Paid-feature state — a killed link must lose Plus and its heartbeat
				// so the client-side gate locks immediately after the kill switch.
				'entitlements', 'entitlements_updated_at', 'last_verified_at',
			) as $key
		) {
			$this->store->delete( $key );
		}
		$this->store->set( 'state', 'unenrolled' );
	}
}
