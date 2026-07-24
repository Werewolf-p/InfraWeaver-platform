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

	/** @var IWSL_SEO_Console|null lazily built SEO signed-channel surface. */
	private $seo_console;

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
	 * The native-media takeover engine (gate flag `media_folders`), built fresh from
	 * the plugin's OWN entitlement gate + store — cheap, and the store is the shared
	 * one so `media.config.set` and `media.config.get` see the same option. Mirrors
	 * redirects_engine(): a thin wrapper over the store, no lazy field needed.
	 */
	public function media_native(): IWSL_Media_Native {
		return new IWSL_Media_Native( $this->entitlements, $this->store );
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
	 * The operator kill-switch surface over the plugin's own gate + store. Built
	 * per-call (stateless) so the email runners can report `switch_on` — the skew
	 * between "entitled" (signed) and "switched on" (local operator toggle).
	 */
	public function email_switches(): IWSL_Feature_Switches {
		return new IWSL_Feature_Switches( $this->entitlements, $this->store );
	}

	/**
	 * The signed-channel SEO surface (`seo.*` methods), built once from the plugin's
	 * own entitlement gate + operator feature-switch layer + store. Lazy so a request
	 * that never touches SEO forces no object graph. Reachable from the `seo.*` runner
	 * closures (which are scoped to this class) without widening any visibility.
	 */
	public function seo_console(): IWSL_SEO_Console {
		if ( null === $this->seo_console ) {
			$this->seo_console = new IWSL_SEO_Console(
				$this->entitlements,
				new IWSL_Feature_Switches( $this->entitlements, $this->store ),
				$this->store
			);
		}
		return $this->seo_console;
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

		// A CR/LF guard for the email validators — every string that reaches the SMTP
		// engine must be single-line (header-injection defence, mirrored pre-engine).
		$no_crlf = static function ( $value ): bool {
			return is_string( $value ) && 1 !== preg_match( '/[\r\n]/', $value );
		};

		// Strict `email.config.set` validator (§7). Top-level keys are EXACTLY
		// { settings, password?, clear_password? }; `settings` carries EXACTLY the
		// eight known fields with the right types; `password` (write-only) and
		// `clear_password` are optional. The engine's save_settings() remains the
		// authoritative validator (host/port/secure/from format, opt-in, AES-256-GCM
		// fail-closed) — this only rejects a malformed wire shape before dispatch.
		$email_settings_keys      = array(
			'host'                  => 1,
			'port'                  => 1,
			'auth'                  => 1,
			'username'              => 1,
			'from_email'            => 1,
			'from_name'             => 1,
			'secure'                => 1,
			'allow_option_password' => 1,
		);
		$email_config_set_params  = static function ( $params ) use ( $email_settings_keys, $no_crlf ): bool {
			if ( ! $params instanceof stdClass ) {
				return false;
			}
			$vars = get_object_vars( $params );
			if ( array() !== array_diff_key( $vars, array( 'settings' => 1, 'password' => 1, 'clear_password' => 1 ) ) ) {
				return false; // unknown top-level key.
			}
			if ( ! isset( $vars['settings'] ) || ! $vars['settings'] instanceof stdClass ) {
				return false;
			}
			$s = get_object_vars( $vars['settings'] );
			// Exact key set — no unknown fields, none missing.
			if ( array() !== array_diff_key( $s, $email_settings_keys ) || array() !== array_diff_key( $email_settings_keys, $s ) ) {
				return false;
			}
			if ( ! $no_crlf( $s['host'] ) || ! $no_crlf( $s['username'] ) || ! $no_crlf( $s['from_email'] ) || ! $no_crlf( $s['from_name'] ) || ! is_string( $s['secure'] ) ) {
				return false;
			}
			if ( ! is_int( $s['port'] ) || ! is_bool( $s['auth'] ) || ! is_bool( $s['allow_option_password'] ) ) {
				return false;
			}
			if ( isset( $vars['password'] ) && ! $no_crlf( $vars['password'] ) ) {
				return false; // write-only secret: must be a single-line string.
			}
			if ( isset( $vars['clear_password'] ) && ! is_bool( $vars['clear_password'] ) ) {
				return false;
			}
			return true;
		};

		// Strict `email.test` validator: EXACTLY { to: non-empty single-line string }.
		$email_test_params = static function ( $params ) use ( $no_crlf ): bool {
			if ( ! $params instanceof stdClass ) {
				return false;
			}
			$vars = get_object_vars( $params );
			if ( array() !== array_diff_key( $vars, array( 'to' => 1 ) ) ) {
				return false;
			}
			return isset( $vars['to'] ) && $no_crlf( $vars['to'] ) && '' !== trim( $vars['to'] );
		};

		// ── Performance/cache validators (§6.3 strict: unknown keys are rejected) ──
		$perf_audit_params = static function ( $params ): bool {
			$vars = get_object_vars( $params );
			if ( array() === $vars ) {
				return true; // rows optional.
			}
			if ( array() !== array_diff_key( $vars, array( 'rows' => 1 ) ) ) {
				return false;
			}
			return isset( $vars['rows'] ) && is_int( $vars['rows'] ) && $vars['rows'] >= 1 && $vars['rows'] <= 25;
		};
		$cache_purge_params = static function ( $params ): bool {
			$vars = get_object_vars( $params );
			if ( ! isset( $vars['scope'] ) || ! is_string( $vars['scope'] ) ) {
				return false;
			}
			if ( 'all' === $vars['scope'] ) {
				return array() === array_diff_key( $vars, array( 'scope' => 1 ) );
			}
			if ( 'paths' === $vars['scope'] ) {
				if ( array() !== array_diff_key( $vars, array( 'scope' => 1, 'paths' => 1 ) ) ) {
					return false;
				}
				if ( ! isset( $vars['paths'] ) || ! is_array( $vars['paths'] ) ) {
					return false;
				}
				$n = count( $vars['paths'] );
				if ( $n < 1 || $n > 50 ) {
					return false;
				}
				foreach ( $vars['paths'] as $p ) {
					if ( ! is_string( $p ) || '' === $p || strlen( $p ) > 1024 ) {
						return false;
					}
				}
				return true;
			}
			return false;
		};
		$cache_warm_params = static function ( $params ): bool {
			$vars = get_object_vars( $params );
			if ( array() !== array_diff_key( $vars, array( 'paths' => 1, 'limit' => 1 ) ) ) {
				return false;
			}
			if ( isset( $vars['limit'] ) && ( ! is_int( $vars['limit'] ) || $vars['limit'] < 1 || $vars['limit'] > 25 ) ) {
				return false;
			}
			if ( isset( $vars['paths'] ) ) {
				if ( ! is_array( $vars['paths'] ) ) {
					return false;
				}
				$n = count( $vars['paths'] );
				if ( $n < 1 || $n > 25 ) {
					return false;
				}
				foreach ( $vars['paths'] as $p ) {
					if ( ! is_string( $p ) || '' === $p || strlen( $p ) > 1024 ) {
						return false;
					}
				}
			}
			return true;
		};
		$cache_configure_params = static function ( $params ): bool {
			$vars = get_object_vars( $params );
			if ( array() === $vars ) {
				return false; // must set at least one field.
			}
			if ( array() !== array_diff_key( $vars, array( 'enabled' => 1, 'ttl' => 1, 'exclusions' => 1 ) ) ) {
				return false;
			}
			if ( isset( $vars['enabled'] ) && ! is_bool( $vars['enabled'] ) ) {
				return false;
			}
			if ( isset( $vars['ttl'] ) && ( ! is_int( $vars['ttl'] ) || $vars['ttl'] < 600 || $vars['ttl'] > 86400 ) ) {
				return false;
			}
			if ( isset( $vars['exclusions'] ) ) {
				if ( ! is_array( $vars['exclusions'] ) || count( $vars['exclusions'] ) > 50 ) {
					return false;
				}
				foreach ( $vars['exclusions'] as $pattern ) {
					if ( ! is_string( $pattern ) || strlen( $pattern ) > 300 ) {
						return false;
					}
				}
			}
			return true;
		};
		$perf_settings_params = static function ( $params ): bool {
			$vars = get_object_vars( $params );
			if ( array() === $vars ) {
				return false; // must carry lazy_load and/or speed_pack.
			}
			if ( array() !== array_diff_key( $vars, array( 'lazy_load' => 1, 'speed_pack' => 1 ) ) ) {
				return false;
			}
			if ( isset( $vars['lazy_load'] ) ) {
				if ( ! $vars['lazy_load'] instanceof stdClass ) {
					return false;
				}
				$ll = get_object_vars( $vars['lazy_load'] );
				if ( array() !== array_diff_key( $ll, array( 'enabled' => 1, 'lazy_iframes' => 1, 'skip_images' => 1 ) ) ) {
					return false;
				}
			}
			if ( isset( $vars['speed_pack'] ) ) {
				if ( ! $vars['speed_pack'] instanceof stdClass ) {
					return false;
				}
				$allowed = array_flip(
					array(
						'minify_html', 'defer_js', 'delay_js', 'server_headers', 'resource_hints',
						'remove_query_strings', 'disable_emojis', 'disable_embeds', 'instant_page',
						'heartbeat_control', 'heartbeat_disable_frontend', 'heartbeat_frequency',
						'prefetch_hosts', 'defer_exclusions',
					)
				);
				if ( array() !== array_diff_key( get_object_vars( $vars['speed_pack'] ), $allowed ) ) {
					return false;
				}
			}
			return true;
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

			// ── media fusion (§ media) ────────────────────────────────────────────
			// Seven signed methods behind the flagship fused Media Explorer. Every
			// runner re-checks the entitlement gate as STATEMENT 1 and returns a
			// signed { locked, gate } payload when the tier does not grant it — no
			// media action ever rides a public/REST endpoint. Read methods
			// (list/tree/status) never sign-with-current and never wipe. Bulk id-lists
			// are re-validated inside the runner via IWSL_Media_Library::int_list, and
			// the engines already treat ids as untrusted. Folder mutations touch TERMS
			// ONLY; restore delegates to the offload engine's download-verify-then-drop
			// un-offload so the last remaining copy is never deleted.
			new IWSL_Command_Handler(
				'media.list',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$lib = new IWSL_Media_Library( $plugin->entitlements() );
					return array( true, $lib->list_assets( get_object_vars( $envelope->params ) ) );
				},
				array( 'IWSL_Media_Library', 'validate_list_params' )
			),
			new IWSL_Command_Handler(
				'media.tree',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$gate = $plugin->entitlements()->evaluate( IWSL_Media_Library::FEATURE_FOLDERS );
					if ( empty( $gate['unlocked'] ) ) {
						return array( true, array( 'locked' => true, 'gate' => $gate ) );
					}
					$folders = new IWSL_Media_Folders( $plugin->entitlements(), $plugin->store() );
					return array( true, array( 'locked' => false, 'tree' => $folders->folder_tree() ) );
				}
			),
			new IWSL_Command_Handler(
				'media.status',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$ent  = $plugin->entitlements();
					$gate = $ent->evaluate( IWSL_Media_Library::FEATURE_OPT );
					if ( empty( $gate['unlocked'] ) ) {
						return array( true, array( 'locked' => true, 'gate' => $gate ) );
					}
					$optimizer = new IWSL_Media_Optimizer( $ent );
					$offload   = new IWSL_Media_Offload( $ent, $plugin->store() );
					$opt_stats = $optimizer->library_stats();
					$off_stats = $offload->stats();
					$cdn_gate  = $ent->evaluate( IWSL_Media_Library::FEATURE_CDN );
					return array(
						true,
						array(
							'locked'        => false,
							'optimization'  => $opt_stats,
							'offload'       => $off_stats,
							'totals'        => array( 'attachments' => (int) ( $opt_stats['total'] ?? 0 ) ),
							'non_lossless'  => (int) ( $opt_stats['remaining'] ?? 0 ),
							'not_offloaded' => (int) ( $off_stats['remaining'] ?? 0 ),
							// CDN host-swap is a site-wide banner, never a per-asset column.
							'cdn_rewrite'   => array( 'unlocked' => ! empty( $cdn_gate['unlocked'] ) ),
						),
					);
				}
			),
			new IWSL_Command_Handler(
				'media.optimize',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$ent  = $plugin->entitlements();
					$gate = $ent->evaluate( IWSL_Media_Library::FEATURE_OPT );
					if ( empty( $gate['unlocked'] ) ) {
						return array( true, array( 'locked' => true, 'gate' => $gate ) );
					}
					$p         = $envelope->params;
					$ids       = IWSL_Media_Library::int_list( $p->ids, IWSL_Media_Library::REQUEST_MAX );
					$converter = isset( $p->converter_id ) ? (string) $p->converter_id : 'webp_lossless';
					$mode      = isset( $p->mode ) ? (string) $p->mode : 'copy';
					$rewrite   = isset( $p->rewrite ) ? (bool) $p->rewrite : false;
					$skip      = isset( $p->skip_optimized ) ? (bool) $p->skip_optimized : true;
					$optimizer = new IWSL_Media_Optimizer( $ent );
					// run() batches ≤ MAX_BATCH per call and reports `partial`; the
					// console loops the signed command for a set larger than one batch.
					$result = $optimizer->run( $converter, IWSL_Media_Optimizer::MAX_BATCH, $mode, false, 'auto', $ids, $rewrite, $skip );
					return array( true, array( 'locked' => false, 'result' => $result ) );
				},
				array( 'IWSL_Media_Library', 'validate_optimize_params' )
			),
			new IWSL_Command_Handler(
				'media.offload',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$ent  = $plugin->entitlements();
					$gate = $ent->evaluate( IWSL_Media_Library::FEATURE_OPT );
					if ( empty( $gate['unlocked'] ) ) {
						return array( true, array( 'locked' => true, 'gate' => $gate ) );
					}
					$p       = $envelope->params;
					$ids     = IWSL_Media_Library::int_list( $p->ids, IWSL_Media_Library::BULK_MAX );
					$offload = new IWSL_Media_Offload( $ent, $plugin->store() );
					$result  = $offload->bulk( (string) $p->op, $ids );
					return array( true, array( 'locked' => false, 'result' => $result ) );
				},
				array( 'IWSL_Media_Library', 'validate_offload_params' )
			),
			new IWSL_Command_Handler(
				'media.restore',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$ent  = $plugin->entitlements();
					$gate = $ent->evaluate( IWSL_Media_Library::FEATURE_OPT );
					if ( empty( $gate['unlocked'] ) ) {
						return array( true, array( 'locked' => true, 'gate' => $gate ) );
					}
					$ids     = IWSL_Media_Library::int_list( $envelope->params->ids, IWSL_Media_Library::BULK_MAX );
					$offload = new IWSL_Media_Offload( $ent, $plugin->store() );
					$results = array();
					$ok      = 0;
					$failed  = 0;
					foreach ( $ids as $id ) {
						if ( $offload->is_offloaded( $id ) ) {
							// download → HEAD-verify local → only then drop the remote.
							$r       = $offload->unoffload_one( $id );
							$r['id'] = $id;
						} else {
							$r = array( 'ok' => false, 'id' => $id, 'reason' => 'not-offloaded' );
						}
						$results[] = $r;
						if ( ! empty( $r['ok'] ) ) {
							++$ok;
						} else {
							++$failed;
						}
					}
					return array(
						true,
						array(
							'locked'  => false,
							'op'      => 'restore',
							'results' => $results,
							'summary' => array( 'total' => count( $ids ), 'ok' => $ok, 'failed' => $failed ),
						),
					);
				},
				array( 'IWSL_Media_Library', 'validate_restore_params' )
			),
			new IWSL_Command_Handler(
				'media.folder',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$ent  = $plugin->entitlements();
					$gate = $ent->evaluate( IWSL_Media_Library::FEATURE_FOLDERS );
					if ( empty( $gate['unlocked'] ) ) {
						return array( true, array( 'locked' => true, 'gate' => $gate ) );
					}
					$p       = $envelope->params;
					$op      = (string) $p->op;
					$folders = new IWSL_Media_Folders( $ent, $plugin->store() );
					switch ( $op ) {
						case 'create':
							$r = $folders->create_folder( (string) $p->name, isset( $p->parent ) ? (int) $p->parent : 0 );
							break;
						case 'rename':
							$r = $folders->rename_folder( (int) $p->id, (string) $p->name );
							break;
						case 'move':
							$r = $folders->move_folder( (int) $p->id, (int) $p->parent, isset( $p->order ) ? (int) $p->order : null );
							break;
						case 'delete':
							// Terms-only: removes the term + its relationships; every
							// attachment is left byte-identical (files simply unfile).
							$r = $folders->delete_folder( (int) $p->id );
							break;
						case 'assign':
							$r = $folders->assign( IWSL_Media_Library::int_list( $p->ids, IWSL_Media_Library::FOLDER_IDS_MAX ), (int) $p->folder_id );
							break;
						case 'tag':
							$r = $folders->tag(
								IWSL_Media_Library::int_list( $p->ids, IWSL_Media_Library::FOLDER_IDS_MAX ),
								IWSL_Media_Library::str_list( isset( $p->add ) ? $p->add : array() ),
								IWSL_Media_Library::int_list( isset( $p->remove ) ? $p->remove : array(), IWSL_Media_Library::FOLDER_IDS_MAX )
							);
							break;
						case 'tag_rename':
							// Terms-only: renames the tag term; every tagged file is byte-identical.
							$r = $folders->rename_tag( (int) $p->id, (string) $p->name );
							break;
						case 'tag_delete':
							// Terms-only: drops the tag term + its relationships; NO file deleted.
							$r = $folders->delete_tag( (int) $p->id );
							break;
						case 'tag_merge':
							// Terms-only: files carrying `from` gain `into`, then `from` is removed.
							$r = $folders->merge_tags( (int) $p->from, (int) $p->into );
							break;
						default:
							$r = array( 'ok' => false, 'reason' => 'bad-op' );
					}
					return array( true, array( 'locked' => false, 'op' => $op, 'result' => $r ) );
				},
				array( 'IWSL_Media_Library', 'validate_folder_params' )
			),
				// ---- media viewer (Agent A): six signed methods behind the click-to-open
				// image viewer. Every runner re-checks the surface entitlement gate as
				// STATEMENT 1 (returning a renderable { locked, gate }); reads never
				// sign-with-current, never wipe. media.get/updateMeta/usage/delete route
				// through IWSL_Media_Detail (viewer read-model + safe mutations); media.edit
				// through IWSL_Media_Editor (WP_Image_Editor, path-contained BY ID, never a
				// caller path); media.protect through IWSL_Media_Protection::set_protected
				// (the SHARED contract with the security-consent protection surface, one
				// method). media.delete is the one deliberate attachment-destroying method:
				// its validator hard-requires confirm:true, byte-for-byte separate from the
				// terms-only folder/tag delete.
				new IWSL_Command_Handler(
					'media.get',
					static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
						$detail = new IWSL_Media_Detail( $plugin->entitlements() );
						return array( true, $detail->get_asset( (int) $envelope->params->id ) );
					},
					array( 'IWSL_Media_Detail', 'validate_get_params' )
				),
				new IWSL_Command_Handler(
					'media.updateMeta',
					static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
						// Only the fields the caller sent cross into the engine; the
						// optimistic-concurrency refusal + sanitizer matrix live there. A
						// conflict is a VALID signed answer (outer ok=true), so the viewer
						// reads result.conflict and offers re-apply, never a 502.
						$p      = $envelope->params;
						$fields = array();
						foreach ( array( 'alt', 'title', 'caption', 'description' ) as $key ) {
							if ( isset( $p->$key ) ) {
								$fields[ $key ] = (string) $p->$key;
							}
						}
						$detail = new IWSL_Media_Detail( $plugin->entitlements() );
						return array( true, $detail->update_meta( (int) $p->id, (string) $p->expect_modified, $fields ) );
					},
					array( 'IWSL_Media_Detail', 'validate_update_params' )
				),
				new IWSL_Command_Handler(
					'media.edit',
					static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
						// WP_Image_Editor only; the engine resolves the file from the id and
						// runs the realpath containment gauntlet, no path ever comes from the
						// wire. Ops arrive validated; decode to plain arrays for the pipe.
						$p   = $envelope->params;
						$ops = array();
						foreach ( (array) $p->ops as $op ) {
							$ops[] = $op instanceof stdClass ? get_object_vars( $op ) : array();
						}
						$target     = isset( $p->target ) ? (string) $p->target : 'all';
						$regenerate = ! isset( $p->regenerate ) || (bool) $p->regenerate;
						$editor     = new IWSL_Media_Editor( $plugin->entitlements() );
						return array( true, $editor->edit( (int) $p->id, $ops, $target, $regenerate ) );
					},
					array( 'IWSL_Media_Editor', 'validate_params' )
				),
				new IWSL_Command_Handler(
					'media.protect',
					static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
						// Shared protection contract (media_protection/Pro). set_protected()
						// re-checks the gate as STATEMENT 1 and re-validates the ids.
						$p   = $envelope->params;
						$mp  = new IWSL_Media_Protection( $plugin->entitlements(), $plugin->store() );
						$ids = IWSL_Media_Library::int_list( $p->ids, IWSL_Media_Protection::PROTECT_WIRE_MAX );
						return array( true, $mp->set_protected( $ids, (bool) $p->protected ) );
					},
					array( 'IWSL_Media_Protection', 'validate_protect_params' )
				),
				new IWSL_Command_Handler(
					'media.delete',
					static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
						// A REAL attachment delete (file + thumbnails). The validator already
						// hard-required confirm:true; the engine fences it again. NEVER a
						// folder/tag path.
						$p      = $envelope->params;
						$detail = new IWSL_Media_Detail( $plugin->entitlements() );
						return array( true, $detail->delete( (int) $p->id, isset( $p->confirm ) && true === $p->confirm ) );
					},
					array( 'IWSL_Media_Detail', 'validate_delete_params' )
				),
				new IWSL_Command_Handler(
					'media.usage',
					static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
						// Read-only bounded where-used scan (posts/meta/options), paginated.
						$p      = $envelope->params;
						$page   = isset( $p->page ) ? (int) $p->page : 1;
						$detail = new IWSL_Media_Detail( $plugin->entitlements() );
						return array( true, $detail->usage( (int) $p->id, $page ) );
					},
					array( 'IWSL_Media_Detail', 'validate_usage_params' )
				),
			// ── email delivery (gate flag `email_delivery`, Pro/Ultimate) ─────────────
			// Five thin shims over IWSL_Email_Delivery — the console's signed window
			// onto the connector's own SMTP feature. Every runner inherits STATEMENT 1
			// (the entitlement gate) from the engine methods it delegates to; the read
			// methods additionally REPORT the gate ("locked" is a renderable state, not
			// an error). The SMTP secret crosses the wire at most once (write-only, on
			// email.config.set, inside this signed envelope) and is NEVER returned:
			// save_settings() strips it and config_snapshot() reads settings_for_render()
			// which drops it wholesale. `switch_on` surfaces the operator kill-switch so
			// the console never claims delivery the (unregistered) hooks won't actually
			// perform. No REST/AJAX surface — signed channel only.
			new IWSL_Command_Handler(
				'email.config.get',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$snapshot              = $plugin->email_delivery()->config_snapshot();
					$snapshot['switch_on'] = $plugin->email_switches()->is_on( IWSL_Email_Delivery::FEATURE );
					return array( true, $snapshot );
				}
			),
			new IWSL_Command_Handler(
				'email.config.set',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$params   = $envelope->params;
					$settings = isset( $params->settings ) && $params->settings instanceof stdClass
						? get_object_vars( $params->settings )
						: array();
					// Write-only secret. clear_password wins: it drops any stored secret
					// by turning the DB-storage opt-in off with a blank submit (the engine's
					// existing "not opted in + blank = drop" path — no save internals touched).
					if ( ! empty( $params->clear_password ) ) {
						$settings['password']              = '';
						$settings['allow_option_password'] = false;
					} elseif ( isset( $params->password ) ) {
						$settings['password'] = (string) $params->password;
					}
					$res = $plugin->email_delivery()->save_settings( $settings );

					// Never echo the secret. save_settings() already returns STRIPPED
					// settings; carry only ok/reason/settings(+gate when locked).
					$out = array(
						'ok'     => ! empty( $res['ok'] ),
						'reason' => isset( $res['reason'] ) ? (string) $res['reason'] : '',
					);
					if ( isset( $res['settings'] ) ) {
						$out['settings'] = $res['settings'];
					}
					if ( isset( $res['gate'] ) ) {
						$out['locked'] = true;
						$out['gate']   = $res['gate'];
					}
					return array( true, $out );
				},
				$email_config_set_params
			),
			new IWSL_Command_Handler(
				'email.test',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$switch_on = $plugin->email_switches()->is_on( IWSL_Email_Delivery::FEATURE );
					$gate      = $plugin->entitlements()->evaluate( IWSL_Email_Delivery::FEATURE );
					if ( empty( $gate['unlocked'] ) ) {
						return array( true, array( 'sent' => false, 'reason' => 'entitlement-locked', 'switch_on' => $switch_on, 'locked' => true, 'gate' => $gate ) );
					}
					// Kill-switch off ⇒ phpmailer_init is NOT hooked ⇒ a real send would
					// silently fall back to PHP mail(). Report that instead of a misleading
					// result rather than firing a send whose transport isn't wired.
					if ( ! $switch_on ) {
						return array( true, array( 'sent' => false, 'reason' => 'delivery-switch-off', 'switch_on' => false ) );
					}
					$to  = isset( $envelope->params->to ) ? (string) $envelope->params->to : '';
					$res = $plugin->email_delivery()->send_test( $to );
					return array(
						true,
						array(
							'sent'          => ! empty( $res['sent'] ),
							'reason'        => isset( $res['reason'] ) ? (string) $res['reason'] : '',
							'switch_on'     => true,
						) + ( isset( $res['retry_after_s'] ) ? array( 'retry_after_s' => (int) $res['retry_after_s'] ) : array() ),
					);
				},
				$email_test_params
			),
			new IWSL_Command_Handler(
				'email.log.get',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// Gate the read too: a locked site returns the gate, not its activity.
					$gate = $plugin->entitlements()->evaluate( IWSL_Email_Delivery::FEATURE );
					if ( empty( $gate['unlocked'] ) ) {
						return array( true, array( 'entries' => array(), 'count' => 0, 'locked' => true, 'gate' => $gate ) );
					}
					$entries = $plugin->email_delivery()->log(); // bounded, whitelisted, redacted at write time.
					return array( true, array( 'entries' => $entries, 'count' => count( $entries ) ) );
				}
			),
			new IWSL_Command_Handler(
				'email.log.clear',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$res = $plugin->email_delivery()->clear_log(); // STATEMENT 1 gate inside.
					$out = array(
						'ok'      => ! empty( $res['ok'] ),
						'cleared' => ! empty( $res['cleared'] ),
					);
					if ( isset( $res['reason'] ) && '' !== (string) $res['reason'] ) {
						$out['reason'] = (string) $res['reason'];
					}
					if ( isset( $res['gate'] ) ) {
						$out['locked'] = true;
						$out['gate']   = $res['gate'];
					}
					return array( true, $out );
				}
			),
			// ── SEO surface (wp-overhaul) — the console's only SEO↔connector channel.
			// Read-only counts snapshot + on-demand audit + two Ultimate mutations.
			// Each mutating/gated runner re-checks entitlement + operator switch as
			// STATEMENT 1 inside IWSL_SEO_Console; validators refuse stray keys.
			new IWSL_Command_Handler(
				'seo.status',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// Safe read: no method-level gate — per-section markers carry the
					// unlocked/switched-off state. Counts only, bounded envelope.
					return $plugin->seo_console()->status();
				}
			),
			new IWSL_Command_Handler(
				'seo.audit.run',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					return $plugin->seo_console()->run_audit( $envelope->params ?? new stdClass() );
				},
				array( 'IWSL_SEO_Console', 'validate_audit_params' )
			),
			new IWSL_Command_Handler(
				'seo.alt.backfill',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					return $plugin->seo_console()->backfill_alt( $envelope->params ?? new stdClass() );
				},
				array( 'IWSL_SEO_Console', 'validate_backfill_params' )
			),
			new IWSL_Command_Handler(
				'seo.fix.apply',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					return $plugin->seo_console()->apply_fix( $envelope->params ?? new stdClass() );
				},
				array( 'IWSL_SEO_Console', 'validate_fix_params' )
			),
			// ── Content / Branding / Config fleet methods (content-branding domain) ──
			// One contiguous block; each runner builds its engine from the plugin's own
			// store + entitlement gate. No public/REST/AJAX surface — the signed channel
			// (dual-sig + JCS + per-site RBAC) is the only console→connector path.
			new IWSL_Command_Handler(
				'branding.get',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// Read-only, SAFE WHEN LOCKED: settings() re-validates on read and
					// capabilities() is side-effect free, so the console can render the
					// locked state (gate.reasons) without the plugin doing anything.
					$wl = new IWSL_White_Label( $plugin->entitlements, $plugin->store, $plugin->now_ms );
					return array(
						true,
						array(
							'gate'     => $plugin->entitlements->evaluate( IWSL_White_Label::FEATURE ),
							'settings' => $wl->settings(),
							'surfaces' => $wl->capabilities(),
						),
					);
				}
			),
			new IWSL_Command_Handler(
				'branding.set',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// STATEMENT-1 gate holds inside save_settings() (white_label/Ultimate):
					// a mis-tiered push fails closed with `entitlement-locked`. The wire
					// values run the IDENTICAL save-time gauntlet as the admin form — no
					// second sanitizer.
					$wl    = new IWSL_White_Label( $plugin->entitlements, $plugin->store, $plugin->now_ms );
					$input = IWSL_White_Label::wire_settings_to_input( $envelope->params->settings );
					$res   = $wl->save_settings( $input );
					if ( empty( $res['ok'] ) ) {
						return array( false, array( 'ok' => false, 'reason' => (string) ( $res['reason'] ?? 'error' ) ) );
					}
					return array( true, array( 'ok' => true, 'settings' => $res['settings'] ) );
				},
				array( 'IWSL_White_Label', 'validate_wire_params' )
			),
			new IWSL_Command_Handler(
				'config.get',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// RBAC-only (no entitlement gate), like the admin Config tab. Read-only:
					// reports the allow-list, live effective values, the last-written
					// configured PHP limits, the SAPI mechanism, and target writability so
					// the console can render configured-vs-effective honestly.
					$ce = new IWSL_Config_Editor();
					return array(
						true,
						array(
							'allowlist'  => IWSL_Config_Editor::allowlist(),
							'current'    => $ce->current(),
							'configured' => $ce->configured_php_limits(),
							'mechanism'  => $ce->php_limits_mechanism(),
							'writable'   => array(
								'wp_config'  => $ce->wp_config_writable(),
								'php_limits' => $ce->php_limits_writable(),
							),
						),
					);
				}
			),
			new IWSL_Command_Handler(
				'config.set',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// RBAC-only. apply() enforces the allow-list AGAIN (a stray key →
					// `skipped`), writes fail-safe, and returns applied/skipped/manual_step/
					// effective verbatim so the console never pretends success.
					$ce     = new IWSL_Config_Editor();
					$values = IWSL_Config_Editor::wire_values_to_input( $envelope->params->values );
					return array( true, $ce->apply( $values ) );
				},
				array( 'IWSL_Config_Editor', 'validate_wire_params' )
			),
			new IWSL_Command_Handler(
				'content.duplicate',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// CONSOLE-ACTOR SEAM (security-reviewed, see IWSL_Duplicate_Post::duplicate):
					// build the engine with console_actor=true so it skips the per-user
					// `edit_post` cap — the signed runner has no WP user, and the dual-signed
					// channel + per-site RBAC IS the authority (mirrors entitlements.set).
					// The engine's STATEMENT-1 entitlement gate (duplicate_post/Pro) STILL
					// applies, so a non-Pro site refuses even a signed request.
					$dp  = new IWSL_Duplicate_Post( $plugin->entitlements, null, true );
					$res = $dp->duplicate( (int) $envelope->params->post_id );
					if ( empty( $res['ok'] ) ) {
						return array( false, array( 'ok' => false, 'reason' => (string) ( $res['reason'] ?? 'error' ) ) );
					}
					return array(
						true,
						array(
							'ok'           => true,
							'source_id'    => (int) $res['source_id'],
							'new_id'       => (int) $res['new_id'],
							'terms_copied' => (int) $res['terms_copied'],
							'meta_copied'  => (int) $res['meta_copied'],
						),
					);
				},
				array( 'IWSL_Duplicate_Post', 'validate_params' )
			),
			// ── Security / Consent / Protection domain (signed; read + closed-set write) ──
			// All five follow the invariant: no public endpoint, STATEMENT-1 entitlement
			// gate, strict validators. No raw consent-log row ever crosses the wire.
			new IWSL_Command_Handler(
				'security.scan',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// Read-only HTTP security-header grade + tracker detection from a
					// loopback fetch of the site's OWN home URL behind the shared SSRF
					// anchor. STATEMENT 1 (inside scan()) is the entitlement gate; a
					// locked site returns { locked, gate } and no fetch happens.
					$engine = new IWSL_Security_Headers( $plugin->entitlements(), $plugin->store() );
					$res    = $engine->scan();
					if ( empty( $res['ok'] ) && 'entitlement-locked' === ( $res['reason'] ?? '' ) ) {
						return array( false, array( 'locked' => true, 'gate' => $res['gate'] ?? null ) );
					}
					return array( true, $res );
				}
			),
			new IWSL_Command_Handler(
				'security.harden',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// Write: apply an allow-listed hardening config. The params validator
					// (a CLOSED key/enum set) already refused any free-form header name or
					// value before dispatch, so header injection is foreclosed by
					// construction. STATEMENT 1 inside apply_config() is the entitlement
					// gate; CSP is only ever emitted report-only until an explicit enforce.
					$engine = new IWSL_Security_Headers( $plugin->entitlements(), $plugin->store() );
					$res    = $engine->apply_config( $envelope->params );
					if ( empty( $res['ok'] ) ) {
						return array( false, array( 'locked' => true, 'gate' => $res['gate'] ?? null, 'reason' => $res['reason'] ?? 'locked' ) );
					}
					return array( true, array( 'applied' => $res['applied'] ) );
				},
				array( 'IWSL_Security_Headers', 'validate_params' )
			),
			new IWSL_Command_Handler(
				'consent.getConfig',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// Read-only consent config + PRIVACY-SAFE aggregates. The pseudonymous
					// consent-log ring NEVER crosses the wire — only counts by method/region.
					$gate = $plugin->entitlements()->evaluate( IWSL_Cookie_Consent::FEATURE );
					if ( empty( $gate['unlocked'] ) ) {
						return array( false, array( 'locked' => true, 'gate' => $gate ) );
					}
					$cc       = new IWSL_Cookie_Consent( $plugin->entitlements(), $plugin->store() );
					$settings = $cc->settings();
					return array(
						true,
						array(
							'settings'   => $settings,
							'enabled'    => ! empty( $settings['enabled'] ),
							'aggregates' => $cc->aggregates(),
						),
					);
				}
			),
			new IWSL_Command_Handler(
				'consent.setConfig',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// Write: route the console's settings through the SAME sanitize_settings()
					// gauntlet as the wp-admin save (one gauntlet, two callers). `enabled`
					// obeys the default-OFF rule (absent ⇒ off), so enabling is always an
					// explicit operator action. STATEMENT 1 inside save_settings() is the gate.
					$cc       = new IWSL_Cookie_Consent( $plugin->entitlements(), $plugin->store() );
					$settings = self::stdclass_to_array( $envelope->params->settings );
					$res      = $cc->save_settings( $settings );
					if ( empty( $res['ok'] ) ) {
						return array( false, array( 'locked' => true, 'gate' => $res['gate'] ?? null, 'reason' => $res['reason'] ?? 'locked' ) );
					}
					return array( true, array( 'settings' => $res['settings'] ) );
				},
				static function ( $params ): bool {
					if ( ! $params instanceof stdClass ) {
						return false;
					}
					$vars = get_object_vars( $params );
					return array() === array_diff_key( $vars, array( 'settings' => 1 ) )
						&& isset( $vars['settings'] ) && $vars['settings'] instanceof stdClass;
				}
			),
			new IWSL_Command_Handler(
				'protection.status',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// Read-only cross-feature status aggregate for the console's Site
					// Security surface. Per-feature `entitled` is the raw flag grant; each
					// section reports only benign booleans/counts — no secrets, no log rows,
					// no sanitizer knobs (SVG status is read-only by design).
					$ent         = $plugin->entitlements();
					$store       = $plugin->store();
					$mp          = new IWSL_Media_Protection( $ent, $store );
					$svg         = new IWSL_SVG_Upload( $ent, $store );
					$cc          = new IWSL_Cookie_Consent( $ent, $store );
					$sh          = new IWSL_Security_Headers( $ent, $store );
					$mp_settings = $mp->settings();
					return array(
						true,
						array(
							'media_protection' => array(
								'entitled'        => $ent->has( IWSL_Media_Protection::FEATURE ),
								'enabled'         => ! empty( $mp_settings['enabled'] ),
								'protect_all'     => ! empty( $mp_settings['protect_all'] ),
								'protected_count' => $mp->protected_count(),
							),
							'svg_upload'       => array(
								'entitled' => $ent->has( IWSL_SVG_Upload::FEATURE ),
								'enabled'  => $svg->is_enabled(),
							),
							'cookie_consent'   => array(
								'entitled'       => $ent->has( IWSL_Cookie_Consent::FEATURE ),
								'enabled'        => ! empty( $cc->settings()['enabled'] ),
								'policy_version' => $cc->policy_version(),
							),
							'security_headers' => array(
								'entitled' => $ent->has( IWSL_Security_Headers::FEATURE ),
								'config'   => $sh->config(),
							),
						),
					);
				}
			),

			// ── database health / cleanup / automation (§ database) ────────────────
			// Three signed methods behind the console's fused "Database" cockpit,
			// routed through the EXISTING gated engines (IWSL_DB_Optimizer + its
			// cleaners, IWSL_Scheduled_DB_Cleanup) — the console never gets a raw
			// `wp db optimize` / purge-all-transients path. Each runner delegates to a
			// private method that re-checks the entitlement gate as STATEMENT 1 and
			// the local feature switch, returning a signed `{ locked, gate }` payload
			// when the tier does not grant it (never a public/REST endpoint). db.analyze
			// is read-only (no params); db.cleanup deletes only through the bounded,
			// preview-by-default engine (MAX_ROWS clamps DOWN only, never DROP); the
			// deletion only fires on a literal `dry_run: false`.
			new IWSL_Command_Handler(
				'db.analyze',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					return array( true, $plugin->db_analyze() );
				}
			),
			new IWSL_Command_Handler(
				'db.cleanup',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$out = $plugin->db_cleanup( $envelope->params );
					return array( ! empty( $out['ok'] ), $out );
				},
				static function ( $params ): bool {
					if ( ! $params instanceof stdClass ) {
						return false;
					}
					$vars = get_object_vars( $params );
					if ( array() !== array_diff_key( $vars, array( 'categories' => 1, 'dry_run' => 1, 'max_rows' => 1 ) ) ) {
						return false;
					}
					if ( ! isset( $vars['categories'] ) || ! is_array( $vars['categories'] ) || count( $vars['categories'] ) > IWSL_DB_Optimizer::MAX_CLEANERS_PER_RUN ) {
						return false;
					}
					foreach ( $vars['categories'] as $id ) {
						if ( ! is_string( $id ) || ! preg_match( '/^[a-z0-9_]{1,32}$/', $id ) ) {
							return false;
						}
					}
					// dry_run MUST be a real boolean — the preview-by-default invariant
					// depends on deletion firing only on a literal `false`.
					if ( ! isset( $vars['dry_run'] ) || ! is_bool( $vars['dry_run'] ) ) {
						return false;
					}
					if ( isset( $vars['max_rows'] ) && ! is_int( $vars['max_rows'] ) ) {
						return false;
					}
					return true;
				}
			),
			new IWSL_Command_Handler(
				'db.schedule',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$out = $plugin->db_schedule( $envelope->params );
					return array( ! empty( $out['ok'] ), $out );
				},
				static function ( $params ): bool {
					if ( ! $params instanceof stdClass ) {
						return false;
					}
					$vars = get_object_vars( $params );
					if ( array() !== array_diff_key( $vars, array( 'enabled' => 1, 'frequency' => 1, 'categories' => 1 ) ) ) {
						return false;
					}
					if ( ! isset( $vars['enabled'] ) || ! is_bool( $vars['enabled'] ) ) {
						return false;
					}
					if ( ! isset( $vars['frequency'] ) || ! in_array( $vars['frequency'], array( 'daily', 'weekly' ), true ) ) {
						return false;
					}
					if ( isset( $vars['categories'] ) ) {
						if ( ! is_array( $vars['categories'] ) || count( $vars['categories'] ) > IWSL_DB_Optimizer::MAX_CLEANERS_PER_RUN ) {
							return false;
						}
						foreach ( $vars['categories'] as $id ) {
							if ( ! is_string( $id ) || ! preg_match( '/^[a-z0-9_]{1,32}$/', $id ) ) {
								return false;
							}
						}
					}
					return true;
				}
			),

			// ── Performance & cache surface (§7 signed methods; no new public/REST
			// surface). All read-only methods take no state; every mutating method
			// re-checks STATEMENT 1 inside the engine it delegates to, and the host
			// is NEVER taken from the caller (purge/warm keys derive from the baked
			// home host). perf.status is the console's single composite fetch.
			new IWSL_Command_Handler(
				'perf.status',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					return array( true, $plugin->perf_status() );
				}
			),
			new IWSL_Command_Handler(
				'perf.audit',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					$vars = get_object_vars( $envelope->params );
					$rows = isset( $vars['rows'] ) ? (int) $vars['rows'] : IWSL_Perf_Audit::REPORT_ROWS;
					return array( true, $plugin->perf_audit_report( $rows ) );
				},
				$perf_audit_params
			),
			new IWSL_Command_Handler(
				'cache.purge',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					return array( true, $plugin->cache_purge( $envelope->params ) );
				},
				$cache_purge_params
			),
			new IWSL_Command_Handler(
				'cache.warm',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					return array( true, $plugin->cache_warm( $envelope->params ) );
				},
				$cache_warm_params
			),
			new IWSL_Command_Handler(
				'cache.configure',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					return array( true, $plugin->cache_configure( $envelope->params ) );
				},
				$cache_configure_params
			),
			new IWSL_Command_Handler(
				'perf.settings.set',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					return array( true, $plugin->perf_settings_set( $envelope->params ) );
				},
				$perf_settings_params
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
			// ── native-media takeover (gate flag `media_folders`, Pro/Ultimate) ───────
			// Two thin shims over IWSL_Media_Native — the console's only channel onto the
			// `iwsl_media_explorer.replace_native` toggle. Mirrors the email.config.* shim
			// style: the read reports the gate as a renderable `locked` state (never an
			// error); the write is gate-first (a locked site cannot enable the takeover)
			// and echoes the resulting flag. No REST/AJAX surface — signed channel only.
			new IWSL_Command_Handler(
				'media.config.get',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					return array( true, $plugin->media_native()->config_snapshot() );
				}
			),
			new IWSL_Command_Handler(
				'media.config.set',
				static function ( IWSL_Plugin $plugin, stdClass $envelope ): array {
					// STATEMENT 1 (the entitlement gate) lives inside set_replace_native():
					// it refuses to enable a locked site and writes nothing, returning the
					// gate. A conflict-free, idempotent boolean flip otherwise.
					$on = isset( $envelope->params->replace_native ) && true === $envelope->params->replace_native;
					return array( true, $plugin->media_native()->set_replace_native( $on ) );
				},
				// Strict validator: EXACTLY { replace_native: bool }. No stray keys, no
				// missing key, no non-bool — the signed envelope shape is pinned before
				// dispatch (the engine re-checks the gate regardless).
				static function ( $params ): bool {
					if ( ! $params instanceof stdClass ) {
						return false;
					}
					$vars = get_object_vars( $params );
					if ( array() !== array_diff_key( $vars, array( 'replace_native' => 1 ) ) ) {
						return false; // unknown top-level key.
					}
					return isset( $vars['replace_native'] ) && is_bool( $vars['replace_native'] );
				}
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
	 * Recursively convert a decoded-JSON stdClass value into a nested associative
	 * array, so a signed-command params object can feed an array<string,mixed>-typed
	 * settings sanitizer (e.g. IWSL_Cookie_Consent::sanitize_settings). Round-trips
	 * through json so nested objects (categories, vendor_overrides) become arrays.
	 *
	 * @param mixed $value
	 * @return array<string,mixed>
	 */
	private static function stdclass_to_array( $value ): array {
		if ( ! $value instanceof stdClass && ! is_array( $value ) ) {
			return array();
		}
		$json    = json_encode( $value );
		$decoded = false === $json ? null : json_decode( $json, true );
		return is_array( $decoded ) ? $decoded : array();
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
		$gauges  = $this->cache_perf_gauges();
		return array(
			// Cache + load-time gauges (§US-11) so the Prometheus exporter gets
			// speed history for free. Cheap integers; a fresh store yields zeros.
			'cache_entries'      => (int) $gauges['cache_entries'],
			'cache_hits_today'   => (int) $gauges['cache_hits_today'],
			'cache_misses_today' => (int) $gauges['cache_misses_today'],
			'perf_avg_ms'        => (int) $gauges['perf_avg_ms'],
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
	 * Read-only assembly behind the signed `db.analyze` command — the whole
	 * "Database" cockpit in one verified response: the entitlement + local-switch
	 * gate, the engine caps, and (only when unlocked) sizes/overhead, autoload
	 * weight, live cleanup-category counts, the automation schedule, and the
	 * cleanup history. The gate is STATEMENT 1: a locked or switched-off site gets
	 * `{ locked, gate, caps }` and performs ZERO database queries. Sizes come from
	 * IWSL_DB_Analyzer (information_schema, SELECT-only); category counts reuse the
	 * optimizer's side-effect-free preview; schedule + history read their stores.
	 *
	 * @return array
	 */
	private function db_analyze(): array {
		$switches  = new IWSL_Feature_Switches( $this->entitlements, $this->store );
		$switch_on = $switches->is_on( IWSL_DB_Optimizer::FEATURE );
		$gate      = $this->entitlements->evaluate( IWSL_DB_Optimizer::FEATURE ) + array( 'switched_off' => ! $switch_on );
		$caps      = array(
			'max_rows'   => IWSL_DB_Optimizer::MAX_ROWS,
			'categories' => array_keys( IWSL_DB_Optimizer::cleaners() ),
		);

		if ( empty( $gate['unlocked'] ) || ! $switch_on ) {
			return array( 'locked' => true, 'gate' => $gate, 'caps' => $caps );
		}

		$sizing  = ( new IWSL_DB_Analyzer( $this->entitlements, null, $this->now_ms ) )->analyze();
		$preview = ( new IWSL_DB_Optimizer( $this->entitlements, null, $this->now_ms ) )->run( 'preview' );

		return array(
			'locked'           => false,
			'gate'             => $gate,
			'caps'             => $caps,
			'totals'           => $sizing['totals'],
			'tables'           => $sizing['tables'],
			'autoload'         => $sizing['autoload'],
			'schema_available' => $sizing['schema_available'],
			'categories'       => ! empty( $preview['ok'] ) ? $preview['cleaners'] : array(),
			'schedule'         => $this->db_schedule_snapshot( $switches ),
			'history'          => ( new IWSL_DB_History( $this->store, $this->now_ms ) )->all(),
		);
	}

	/**
	 * The automation card's read-model for `db.analyze`: the scheduler's stored
	 * state (enabled, cadence, category subset, next/last run) plus whether the
	 * scheduling feature is unlocked (entitlement AND local switch). Reads only.
	 */
	private function db_schedule_snapshot( IWSL_Feature_Switches $switches ): array {
		$scheduler  = new IWSL_Scheduled_DB_Cleanup( $this->entitlements, $this->store, null, $this->now_ms );
		$sched_gate = $this->entitlements->evaluate( IWSL_Scheduled_DB_Cleanup::FEATURE );
		$settings   = $scheduler->settings();
		return array(
			'unlocked'   => ! empty( $sched_gate['unlocked'] ) && $switches->is_on( IWSL_Scheduled_DB_Cleanup::FEATURE ),
			'enabled'    => ! empty( $settings['enabled'] ),
			'frequency'  => (string) $settings['frequency'],
			'categories' => isset( $settings['categories'] ) && is_array( $settings['categories'] ) ? $settings['categories'] : array(),
			'next_run'   => $scheduler->next_run(),
			'last_run'   => $scheduler->last_run(),
		);
	}

	/**
	 * The signed `db.cleanup` runner (private). Triple-gated: the verifier already
	 * proved console authority; here the LOCAL feature switch is checked, then the
	 * work is delegated to the bounded IWSL_DB_Optimizer whose own entitlement gate
	 * is STATEMENT 1. Deletion fires ONLY on a literal `dry_run: false`; anything
	 * else stays a preview. `max_rows` can only ever LOWER the per-category cap
	 * (the engine clamps it down, never up). Real runs append a `console`-sourced
	 * history entry; previews never do.
	 *
	 * @param stdClass $params Validated { categories, dry_run, max_rows? }.
	 * @return array
	 */
	private function db_cleanup( stdClass $params ): array {
		$switches = new IWSL_Feature_Switches( $this->entitlements, $this->store );
		if ( ! $switches->is_on( IWSL_DB_Optimizer::FEATURE ) ) {
			$gate = $this->entitlements->evaluate( IWSL_DB_Optimizer::FEATURE ) + array( 'switched_off' => true );
			return array( 'ok' => false, 'locked' => true, 'reason' => 'switched-off', 'gate' => $gate );
		}

		$vars       = get_object_vars( $params );
		$categories = isset( $vars['categories'] ) && is_array( $vars['categories'] ) ? array_values( $vars['categories'] ) : array();
		$dry_run    = $vars['dry_run'] ?? true; // preview-by-default if somehow absent.
		$cap        = isset( $vars['max_rows'] ) && is_int( $vars['max_rows'] ) ? $vars['max_rows'] : IWSL_DB_Optimizer::MAX_ROWS;
		$mode       = ( false === $dry_run ) ? 'run' : 'preview';

		$history   = new IWSL_DB_History( $this->store, $this->now_ms );
		$optimizer = new IWSL_DB_Optimizer( $this->entitlements, null, $this->now_ms, null, $history );
		$summary   = $optimizer->run( $mode, $categories, $cap, 'console' );

		if ( empty( $summary['ok'] ) && 'entitlement-locked' === ( $summary['reason'] ?? '' ) ) {
			$summary['locked'] = true;
		}
		$summary['cap'] = max( 1, min( $cap, IWSL_DB_Optimizer::MAX_ROWS ) );
		return $summary;
	}

	/**
	 * The signed `db.schedule` runner (private). Gated on `scheduled_db_cleanup`
	 * (verifier authority + local switch + the scheduler's own STATEMENT-1 gate).
	 * Delegates to IWSL_Scheduled_DB_Cleanup::save_settings() — the SAME store and
	 * WP-Cron reconciliation WP-admin uses, so the two surfaces never drift — with
	 * a category subset sanitized against the cleaner registry. Echoes the stored
	 * settings + the next run.
	 *
	 * @param stdClass $params Validated { enabled, frequency, categories? }.
	 * @return array
	 */
	private function db_schedule( stdClass $params ): array {
		$switches = new IWSL_Feature_Switches( $this->entitlements, $this->store );
		if ( ! $switches->is_on( IWSL_Scheduled_DB_Cleanup::FEATURE ) ) {
			$gate = $this->entitlements->evaluate( IWSL_Scheduled_DB_Cleanup::FEATURE ) + array( 'switched_off' => true );
			return array( 'ok' => false, 'locked' => true, 'reason' => 'switched-off', 'gate' => $gate );
		}

		$vars      = get_object_vars( $params );
		$scheduler = new IWSL_Scheduled_DB_Cleanup( $this->entitlements, $this->store, null, $this->now_ms );
		$result    = $scheduler->save_settings(
			array(
				'enabled'    => ! empty( $vars['enabled'] ),
				'frequency'  => isset( $vars['frequency'] ) ? (string) $vars['frequency'] : 'daily',
				'categories' => isset( $vars['categories'] ) && is_array( $vars['categories'] ) ? array_values( $vars['categories'] ) : array(),
			)
		);

		if ( empty( $result['ok'] ) ) {
			$result['locked'] = true;
			return $result;
		}
		$result['next_run'] = $scheduler->next_run();
		return $result;
	}

	// ── performance & cache runners (delegate to engines; §7 signed methods) ────

	/** Page cache engine over this plugin's gate + store (persists ttl/exclusions). */
	private function page_cache(): IWSL_Page_Cache {
		return new IWSL_Page_Cache( $this->entitlements, null, null, $this->now_ms, null, $this->store );
	}

	/** Speed Pack engine over this plugin's gate + store. */
	private function speed_pack(): IWSL_Speed_Pack {
		return new IWSL_Speed_Pack( $this->entitlements, $this->store, null, null, $this->now_ms );
	}

	/** Lazy Load engine over this plugin's gate + store. */
	private function lazy_load(): IWSL_Lazy_Load {
		return new IWSL_Lazy_Load( $this->entitlements, $this->store );
	}

	/** FREE Load-Time Audit engine over this plugin's store. */
	private function perf_audit(): IWSL_Perf_Audit {
		return new IWSL_Perf_Audit( $this->store, $this->now_ms );
	}

	/**
	 * The console's ONE read-only composite (perf.status): page cache posture +
	 * counters, speed-pack settings/status, lazy-load settings, and a trimmed audit
	 * roll-up — one signed round-trip feeding the Manage → Performance surface, per
	 * the console-slowness constraint (no per-panel exec fan-out).
	 */
	private function perf_status(): array {
		$audit = $this->perf_audit()->report();
		$sp    = $this->speed_pack();
		return array(
			'page_cache' => $this->page_cache()->status(),
			'speed_pack' => array(
				'settings' => $sp->settings(),
				'status'   => $sp->status(),
			),
			'lazy_load'  => $this->lazy_load()->settings(),
			'audit'      => array(
				'enabled'       => (bool) $audit['enabled'],
				'avg_ms'        => (int) $audit['avg_ms'],
				'total_samples' => (int) $audit['total_samples'],
				'slow_paths'    => (int) $audit['slow_paths'],
			),
		);
	}

	/** perf.audit runner: the read-only Load-Time Audit report (FREE feature, capped rows). */
	private function perf_audit_report( int $rows ): array {
		return $this->perf_audit()->report( $rows );
	}

	/** cache.purge runner: purge all, or specific URLs by path (host is the baked home, never the caller). */
	private function cache_purge( stdClass $params ): array {
		$scope = (string) $params->scope;
		if ( 'paths' === $scope ) {
			$res = $this->page_cache()->purge_paths( self::string_list( $params->paths ?? array() ) );
		} else {
			$res = $this->page_cache()->purge_all();
		}
		return array( 'purged' => (int) ( $res['purged'] ?? 0 ) );
	}

	/**
	 * cache.warm runner: with no paths, warm the top-N most-visited URLs the FREE
	 * Load-Time Audit already knows (home fallback) — the elegant tie, no sitemap.
	 * The engine builds each URL from home_url() + a validated path, so the caller
	 * can never steer the loopback off-host. Entitlement-gated inside warm().
	 */
	private function cache_warm( stdClass $params ): array {
		$vars  = get_object_vars( $params );
		$limit = isset( $vars['limit'] ) ? (int) $vars['limit'] : IWSL_Page_Cache::WARM_MAX;
		$paths = isset( $vars['paths'] )
			? self::string_list( $vars['paths'] )
			: $this->warm_default_paths( $limit );
		return self::with_lock_flag( $this->page_cache()->warm( $paths, $limit ) );
	}

	/** The audit-fed default warm set: most-visited tracked paths, `/` when the audit is empty. */
	private function warm_default_paths( int $limit ): array {
		$paths = $this->perf_audit()->top_paths( max( 1, $limit ) );
		return array() === $paths ? array( '/' ) : $paths;
	}

	/** cache.configure runner: TTL + exclusions (baked) + enable/disable. Entitlement-gated by enable(). */
	private function cache_configure( stdClass $params ): array {
		return self::with_lock_flag( $this->page_cache()->configure( get_object_vars( $params ) ) );
	}

	/**
	 * perf.settings.set runner: flip lazy-load / speed-pack SETTINGS within an
	 * entitled feature. Delegates verbatim to the existing update_settings() /
	 * save_settings() so every clamp/sanitize/gate/.htaccess reconcile is reused —
	 * and the entitlement gate inside those refuses to widen a tier over the signed
	 * channel (a locked feature returns entitlement-locked).
	 */
	private function perf_settings_set( stdClass $params ): array {
		$vars = get_object_vars( $params );
		$out  = array();
		if ( isset( $vars['lazy_load'] ) && $vars['lazy_load'] instanceof stdClass ) {
			$out['lazy_load'] = self::with_lock_flag( $this->lazy_load()->update_settings( get_object_vars( $vars['lazy_load'] ) ) );
		}
		if ( isset( $vars['speed_pack'] ) && $vars['speed_pack'] instanceof stdClass ) {
			$out['speed_pack'] = self::with_lock_flag( $this->speed_pack()->save_settings( get_object_vars( $vars['speed_pack'] ) ) );
		}
		return $out;
	}

	/** The four cache/perf gauges folded into metrics.snapshot (cheap; zeros on a fresh store). */
	private function cache_perf_gauges(): array {
		$status = $this->page_cache()->status();
		$audit  = $this->perf_audit()->report();
		return array(
			'cache_entries'      => (int) ( $status['entries'] ?? 0 ),
			'cache_hits_today'   => (int) ( $status['hits_today'] ?? 0 ),
			'cache_misses_today' => (int) ( $status['misses_today'] ?? 0 ),
			'perf_avg_ms'        => (int) ( $audit['avg_ms'] ?? 0 ),
		);
	}

	/** Tag a gated engine result with `locked` when it refused on the entitlement gate. */
	private static function with_lock_flag( array $res ): array {
		if ( isset( $res['reason'] ) && 'entitlement-locked' === $res['reason'] ) {
			$res['locked'] = true;
		}
		return $res;
	}

	/** Coerce a decoded params array into a list of strings (drops non-strings). @return string[] */
	private static function string_list( $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}
		$out = array();
		foreach ( $value as $item ) {
			if ( is_string( $item ) ) {
				$out[] = $item;
			}
		}
		return $out;
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
