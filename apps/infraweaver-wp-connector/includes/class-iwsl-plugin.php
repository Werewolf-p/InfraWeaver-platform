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

	public function rotation(): IWSL_Rotation {
		return $this->rotation;
	}

	/**
	 * Site Health engines, built on demand from the plugin's OWN entitlement gate
	 * (correctly clocked) + store, so the signed Site Health methods (§ redirects /
	 * links / maintenance / sitehealth) reach the exact same gate the wp-admin
	 * surfaces use. Cheap to build per-call — each is a thin wrapper over the store.
	 */
	public function redirects_engine(): IWSL_Redirects {
		return new IWSL_Redirects( $this->entitlements, $this->store );
	}

	public function maintenance_mode(): IWSL_Maintenance_Mode {
		return new IWSL_Maintenance_Mode( $this->entitlements, $this->store );
	}

	public function broken_link_scan(): IWSL_Broken_Link_Scan {
		return new IWSL_Broken_Link_Scan( $this->entitlements, $this->store );
	}

	public function site_health(): IWSL_Site_Health {
		return new IWSL_Site_Health(
			$this->entitlements,
			$this->maintenance_mode(),
			$this->redirects_engine(),
			$this->broken_link_scan()
		);
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

		// ── Site Health params validators (§ redirects / links / maintenance) ──────
		// Shape-only, mirroring the strategy note: authorization ALWAYS lives in the
		// engine (STATEMENT-1 gates). A stray signed-but-ignored field is refused
		// (array_diff_key), matching the rotation/aud/entitlements validators.

		// Optional { budget_ms:int } — or empty params.
		$links_scan_params = static function ( $params ): bool {
			if ( ! $params instanceof stdClass ) {
				return false;
			}
			$vars = get_object_vars( $params );
			if ( array() !== array_diff_key( $vars, array( 'budget_ms' => 1 ) ) ) {
				return false;
			}
			return ! isset( $vars['budget_ms'] ) || is_int( $vars['budget_ms'] );
		};

		// { source:string, target:string, type:int, match?:string } — shape only.
		$redirects_create_params = static function ( $params ): bool {
			if ( ! $params instanceof stdClass ) {
				return false;
			}
			$vars = get_object_vars( $params );
			if ( array() !== array_diff_key( $vars, array( 'source' => 1, 'target' => 1, 'type' => 1, 'match' => 1 ) ) ) {
				return false;
			}
			if ( ! isset( $vars['source'] ) || ! is_string( $vars['source'] ) ) {
				return false;
			}
			if ( ! isset( $vars['target'] ) || ! is_string( $vars['target'] ) ) {
				return false;
			}
			if ( ! isset( $vars['type'] ) || ! is_int( $vars['type'] ) ) {
				return false;
			}
			return ! isset( $vars['match'] ) || is_string( $vars['match'] );
		};

		// { id:string } matching the server-derived rule id shape.
		$redirects_delete_params = static function ( $params ): bool {
			if ( ! $params instanceof stdClass ) {
				return false;
			}
			$vars = get_object_vars( $params );
			if ( array() !== array_diff_key( $vars, array( 'id' => 1 ) ) ) {
				return false;
			}
			return isset( $vars['id'] ) && is_string( $vars['id'] ) && 1 === preg_match( IWSL_Redirects::RULE_ID_RE, $vars['id'] );
		};

		// { rules: [ {source,target,type,match?} ] } capped at 50 rows.
		$redirects_import_params = static function ( $params ): bool {
			if ( ! $params instanceof stdClass ) {
				return false;
			}
			$vars = get_object_vars( $params );
			if ( array() !== array_diff_key( $vars, array( 'rules' => 1 ) ) ) {
				return false;
			}
			if ( ! isset( $vars['rules'] ) || ! is_array( $vars['rules'] ) || count( $vars['rules'] ) > 50 ) {
				return false;
			}
			foreach ( $vars['rules'] as $row ) {
				if ( ! $row instanceof stdClass ) {
					return false;
				}
				$rv = get_object_vars( $row );
				if ( array() !== array_diff_key( $rv, array( 'source' => 1, 'target' => 1, 'type' => 1, 'match' => 1 ) ) ) {
					return false;
				}
				if ( ! isset( $rv['source'] ) || ! is_string( $rv['source'] )
					|| ! isset( $rv['target'] ) || ! is_string( $rv['target'] )
					|| ! isset( $rv['type'] ) || ! is_int( $rv['type'] )
					|| ( isset( $rv['match'] ) && ! is_string( $rv['match'] ) ) ) {
					return false;
				}
			}
			return true;
		};

		// { log_404?:bool, auto_slug?:bool } — either, both, or (a no-op) neither.
		$redirects_toggles_params = static function ( $params ): bool {
			if ( ! $params instanceof stdClass ) {
				return false;
			}
			$vars = get_object_vars( $params );
			if ( array() !== array_diff_key( $vars, array( 'log_404' => 1, 'auto_slug' => 1 ) ) ) {
				return false;
			}
			if ( isset( $vars['log_404'] ) && ! is_bool( $vars['log_404'] ) ) {
				return false;
			}
			return ! isset( $vars['auto_slug'] ) || is_bool( $vars['auto_slug'] );
		};

		// { enabled:bool, headline?:string, message?:string, retry_after?:bool, until?:int, allow_ips?:string[] }.
		$maintenance_set_params = static function ( $params ): bool {
			if ( ! $params instanceof stdClass ) {
				return false;
			}
			$vars    = get_object_vars( $params );
			$allowed = array( 'enabled' => 1, 'headline' => 1, 'message' => 1, 'retry_after' => 1, 'until' => 1, 'allow_ips' => 1 );
			if ( array() !== array_diff_key( $vars, $allowed ) ) {
				return false;
			}
			if ( ! isset( $vars['enabled'] ) || ! is_bool( $vars['enabled'] ) ) {
				return false;
			}
			if ( isset( $vars['headline'] ) && ! is_string( $vars['headline'] ) ) {
				return false;
			}
			if ( isset( $vars['message'] ) && ! is_string( $vars['message'] ) ) {
				return false;
			}
			if ( isset( $vars['retry_after'] ) && ! is_bool( $vars['retry_after'] ) ) {
				return false;
			}
			if ( isset( $vars['until'] ) && ! is_int( $vars['until'] ) ) {
				return false;
			}
			if ( isset( $vars['allow_ips'] ) ) {
				if ( ! is_array( $vars['allow_ips'] ) ) {
					return false;
				}
				foreach ( $vars['allow_ips'] as $ip ) {
					if ( ! is_string( $ip ) ) {
						return false;
					}
				}
			}
			return true;
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

			// ── Site Health signed methods (one bounded aggregate + detail reads +
			// gated mutations). Every runner DELEGATES to an engine whose STATEMENT-1
			// entitlement gate is authoritative: the signed channel adds a transport,
			// never a bypass. A locked flag returns the engine's own refusal/locked
			// marker over the wire. No new REST/AJAX/nopriv surface (signed-channel
			// invariant). ────────────────────────────────────────────────────────────
			new IWSL_Command_Handler(
				'sitehealth.snapshot',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// ONE bounded aggregate read powering the whole panel. Each
					// sub-section self-gates (locked flags emit a locked marker, no
					// data) so a single round-trip is safe across tiers.
					return array( true, $plugin->site_health()->snapshot() );
				}
			),
			new IWSL_Command_Handler(
				'links.scan',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$params = get_object_vars( $envelope->params );
					$budget = isset( $params['budget_ms'] ) ? (int) $params['budget_ms'] : null;
					// scan_guarded owns the entitlement gate (its scan() STATEMENT 1),
					// the budget clamp, the single-flight lock, and last-scan persist.
					return array( true, $plugin->broken_link_scan()->scan_guarded( $budget ) );
				},
				$links_scan_params
			),
			new IWSL_Command_Handler(
				'redirects.list',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// Pure reads are not engine-gated, so gate the LISTING here to keep
					// the redirect table off a locked/lower tier (triple gate).
					$gate = $plugin->entitlements()->evaluate( IWSL_Redirects::FEATURE );
					if ( empty( $gate['unlocked'] ) ) {
						return array( true, array( 'locked' => true, 'gate' => $gate ) );
					}
					$engine = $plugin->redirects_engine();
					return array(
						true,
						array(
							'locked'      => false,
							'rules'       => $engine->rules(),
							'log'         => $engine->log_entries(),
							'log_enabled' => $engine->is_404_logging_enabled(),
							'auto_slug'   => $engine->is_auto_redirect_enabled(),
						),
					);
				}
			),
			new IWSL_Command_Handler(
				'redirects.create',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$p     = get_object_vars( $envelope->params );
					$match = isset( $p['match'] ) ? (string) $p['match'] : 'exact';
					// add_rule() runs the FULL save-time gauntlet + gate; its refusal
					// tokens (duplicate-source, creates-redirect-loop, …) pass through
					// verbatim — the console never re-implements the gauntlet.
					return array( true, $plugin->redirects_engine()->add_rule( (string) $p['source'], (string) $p['target'], (int) $p['type'], $match ) );
				},
				$redirects_create_params
			),
			new IWSL_Command_Handler(
				'redirects.delete',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$p = get_object_vars( $envelope->params );
					return array( true, $plugin->redirects_engine()->delete_rule( (string) $p['id'] ) );
				},
				$redirects_delete_params
			),
			new IWSL_Command_Handler(
				'redirects.import',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$p      = get_object_vars( $envelope->params );
					$rows   = isset( $p['rules'] ) && is_array( $p['rules'] ) ? $p['rules'] : array();
					$engine = $plugin->redirects_engine();
					$out    = array();
					foreach ( $rows as $row ) {
						$rv    = $row instanceof stdClass ? get_object_vars( $row ) : array();
						$src   = isset( $rv['source'] ) && is_string( $rv['source'] ) ? $rv['source'] : '';
						$tgt   = isset( $rv['target'] ) && is_string( $rv['target'] ) ? $rv['target'] : '';
						$type  = isset( $rv['type'] ) && is_int( $rv['type'] ) ? $rv['type'] : 0;
						$match = isset( $rv['match'] ) && is_string( $rv['match'] ) ? $rv['match'] : 'exact';
						// Per-row through the same gated add_rule(); stop-never.
						$r     = $engine->add_rule( $src, $tgt, $type, $match );
						$out[] = empty( $r['ok'] )
							? array( 'ok' => false, 'reason' => isset( $r['reason'] ) ? (string) $r['reason'] : 'error' )
							: array( 'ok' => true );
					}
					return array( true, array( 'results' => $out ) );
				},
				$redirects_import_params
			),
			new IWSL_Command_Handler(
				'redirects.set_toggles',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$p      = get_object_vars( $envelope->params );
					$engine = $plugin->redirects_engine();
					if ( isset( $p['log_404'] ) ) {
						$engine->set_404_logging( (bool) $p['log_404'] ); // gated (STATEMENT 1)
					}
					if ( isset( $p['auto_slug'] ) ) {
						$engine->set_auto_redirect( (bool) $p['auto_slug'] ); // gated (STATEMENT 1)
					}
					return array(
						true,
						array(
							'log_enabled' => $engine->is_404_logging_enabled(),
							'auto_slug'   => $engine->is_auto_redirect_enabled(),
						),
					);
				},
				$redirects_toggles_params
			),
			new IWSL_Command_Handler(
				'maintenance.set',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$p     = get_object_vars( $envelope->params );
					$input = array(
						'enabled'     => (bool) $p['enabled'],
						'headline'    => isset( $p['headline'] ) ? (string) $p['headline'] : '',
						'message'     => isset( $p['message'] ) ? (string) $p['message'] : '',
						'retry_after' => isset( $p['retry_after'] ) ? (bool) $p['retry_after'] : false,
						'until'       => isset( $p['until'] ) ? (int) $p['until'] : 0,
						'allow_ips'   => isset( $p['allow_ips'] ) && is_array( $p['allow_ips'] ) ? $p['allow_ips'] : array(),
					);
					// save_settings() gates (STATEMENT 1) + runs the sanitizer (byte
					// caps, until clamp, IP allow-list normalization).
					return array( true, $plugin->maintenance_mode()->save_settings( $input ) );
				},
				$maintenance_set_params
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
