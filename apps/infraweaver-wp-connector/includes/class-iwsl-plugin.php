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
						default:
							$r = array( 'ok' => false, 'reason' => 'bad-op' );
					}
					return array( true, array( 'locked' => false, 'op' => $op, 'result' => $r ) );
				},
				array( 'IWSL_Media_Library', 'validate_folder_params' )
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
