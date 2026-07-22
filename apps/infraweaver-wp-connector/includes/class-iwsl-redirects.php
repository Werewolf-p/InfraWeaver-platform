<?php
/**
 * Generic engine behind the gated "301 Redirect Manager" feature.
 *
 * This is the payload behind the `redirect_manager` entitlement, kept separate
 * from the gate (IWSL_Entitlements) and from the match strategies
 * (IWSL_Redirect_Matcher implementations) so each can be reasoned about — and
 * tested — in isolation.
 *
 * TRUST MODEL. The feature is console-authoritative: the `redirect_manager` flag
 * is written ONLY by the dual-signed `entitlements.set` runner (§7). There is
 * deliberately no self-set path, REST route, AJAX endpoint, cron, or nopriv
 * surface here — this class is a purely-local admin action plus one passive
 * front-end hook, mirroring the IWSL_Media_Optimizer pattern. The gate is
 * re-checked at three layers (admin page, admin-post handler, and here as
 * STATEMENT 1 of every mutator, apply(), and the maybe_redirect() callback).
 * The innermost checks are authoritative: they survive any future caller that
 * forgets the outer two.
 *
 * RESIDUAL RISK (honest statement). A site owner with direct database write
 * access can flip the local entitlement option and unlock this without the
 * console — exactly the accepted threat model of the existing `plus` gate. That
 * is bounded by heartbeat staleness: if the console stops managing the site, the
 * signed heartbeat goes stale and the gate re-locks within HEARTBEAT_FRESH_MS
 * (2h), because evaluate() requires state==active AND a fresh signed contact,
 * not merely the flag. A second accepted residual: only obvious single-hop
 * self-loops (A→A) are refused — multi-hop chains (A→B→A) are not detected.
 * A third: matching is byte-exact on the encoded path, so `/a%2Fb` never matches
 * `/a/b` (fail-closed by design). Query string and fragment are ignored for
 * matching and are NOT forwarded to the target.
 *
 * SAFETY. In-process only — no exec/shell_exec/proc_open, no network. Every
 * redirect flows through wp_safe_redirect() as the sole primitive. Sources and
 * targets pass the full save-time gauntlet (scheme/host/CRLF/backslash/
 * scheme-relative/userinfo/external/self-loop/reserved-path) before storage, and
 * every stored target is re-validated at request time so a DB-tampered rule that
 * no longer validates is silently skipped. WordPress calls are function_exists-
 * guarded so the engine runs under the zero-dependency test harness with an
 * injected store, clock, matcher registry, home host, redirector, is_404 probe
 * and external allow-list.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Redirects {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'redirect_manager';

	/** Hard cap on stored rules — bounds option size / per-request cost. */
	const MAX_RULES = 500;
	/** Ring-buffer cap on the 404 log. */
	const MAX_404_LOG = 100;
	/** Byte ceiling on a source path. */
	const MAX_SOURCE_LEN = 1024;
	/** Byte ceiling on a target. */
	const MAX_TARGET_LEN = 2048;

	/** Store key for the rules list. */
	const RULES_KEY = 'redirect_rules';
	/** Store key for the 404 log ring buffer. */
	const LOG_KEY = 'redirect_404_log';
	/** Store key for the 404-logging on/off toggle. */
	const LOG_ENABLED_KEY = 'redirect_404_log_enabled';
	/** Store key for the auto-redirect-on-slug-change toggle (default ON). */
	const AUTO_REDIRECT_KEY = 'redirect_auto_slug';

	/** Bounded hop budget for the redirect-chain cycle walk. */
	const MAX_REDIRECT_HOPS = 10;

	/** The only redirect statuses this manager will emit. */
	const ALLOWED_TYPES = array( 301, 302 );
	/** Shape of a server-derived rule id: `r` + 12 hex of sha1(normalized source). */
	const RULE_ID_RE = '/^r[0-9a-f]{12}$/';

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store rules + log + toggle live here. */
	private $store;

	/** @var callable():int current unix ms. */
	private $now_ms;

	/** @var array<string, IWSL_Redirect_Matcher> id-keyed matcher registry. */
	private $matchers;

	/** @var string Lowercased home host, '' outside WordPress. */
	private $home_host;

	/** @var int|null Home port, or null when not explicit. */
	private $home_port;

	/** @var callable fn(string $location, int $status): void */
	private $redirector;

	/** @var callable():bool */
	private $is_404;

	/** @var array Code-level external host allow-list (defaults to empty). */
	private $allow_hosts;

	/** @var array<int, string> post_id → old permalink, snapshotted within one request. */
	private $pending_permalinks = array();

	/**
	 * @param IWSL_Entitlements                          $entitlements The gate.
	 * @param IWSL_Store                                 $store        Rules + log + toggle.
	 * @param callable|null                              $now_ms       Clock, mirrors IWSL_Entitlements.
	 * @param array<string, IWSL_Redirect_Matcher>|null  $matchers     Registry override; defaults to self::matchers().
	 * @param string|null                                $home_host    Home host; defaults to parse of home_url().
	 * @param callable|null                              $redirector   fn(location,status):void; default wraps wp_safe_redirect + exit.
	 * @param callable|null                              $is_404       fn():bool; default is_404() when available.
	 * @param array|null                                 $allow_hosts  External allow-list; default via the code filter.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		IWSL_Store $store,
		?callable $now_ms = null,
		?array $matchers = null,
		?string $home_host = null,
		?callable $redirector = null,
		?callable $is_404 = null,
		?array $allow_hosts = null
	) {
		$this->entitlements = $entitlements;
		$this->store        = $store;
		$this->now_ms       = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
		$this->matchers    = null !== $matchers ? $matchers : self::matchers();
		$this->home_host   = null !== $home_host ? strtolower( $home_host ) : self::default_home_host();
		$this->home_port   = self::default_home_port();
		$this->redirector  = $redirector ?? self::default_redirector();
		$this->is_404      = $is_404 ?? static function (): bool {
			return function_exists( 'is_404' ) ? (bool) is_404() : false;
		};
		$this->allow_hosts = null !== $allow_hosts ? $allow_hosts : self::default_allow_hosts();
	}

	/**
	 * The id-keyed matcher registry. Adding a strategy is one class + one line
	 * here — this is the "generic solution" the interface exists to enable.
	 *
	 * @return array<string, IWSL_Redirect_Matcher>
	 */
	public static function matchers(): array {
		return array(
			'exact' => new IWSL_Exact_Path_Matcher(),
		);
	}

	/** Register the front-end hook + the auto-redirect glue. Guarded for the harness. */
	public function register(): void {
		if ( function_exists( 'add_action' ) ) {
			// Priority 1 — ahead of redirect_canonical (10) so a managed rule wins.
			add_action( 'template_redirect', array( $this, 'maybe_redirect' ), 1 );
			// Auto-redirect on slug change (default-on; Yoast gates this behind
			// Premium). Snapshot the OLD permalink before the update, diff after.
			add_action( 'pre_post_update', array( $this, 'snapshot_permalink' ), 10, 2 );
			add_action( 'post_updated', array( $this, 'maybe_auto_redirect' ), 10, 3 );
		}
	}

	// ── reads (safe on every render) ───────────────────────────────────────────

	/**
	 * The stored rules, each defensively re-validated in shape on read. A
	 * malformed entry is dropped, never mutated in place.
	 *
	 * @return array<int, array>
	 */
	public function rules(): array {
		$stored = $this->store->get( self::RULES_KEY, array() );
		if ( ! is_array( $stored ) ) {
			return array();
		}
		$out = array();
		foreach ( $stored as $rule ) {
			$valid = self::sanitize_rule_shape( $rule );
			if ( null !== $valid ) {
				$out[] = $valid;
			}
		}
		return $out;
	}

	/** The bounded 404 log, shape-validated on read. @return array<int, array> */
	public function log_entries(): array {
		$stored = $this->store->get( self::LOG_KEY, array() );
		if ( ! is_array( $stored ) ) {
			return array();
		}
		$out = array();
		foreach ( $stored as $entry ) {
			if ( is_array( $entry ) && isset( $entry['path'] ) && is_string( $entry['path'] ) ) {
				$out[] = array(
					'path'      => $entry['path'],
					'count'     => isset( $entry['count'] ) ? (int) $entry['count'] : 0,
					'last_seen' => isset( $entry['last_seen'] ) ? (int) $entry['last_seen'] : 0,
				);
			}
		}
		return $out;
	}

	/** Whether 404 logging is switched on. */
	public function is_404_logging_enabled(): bool {
		return true === $this->store->get( self::LOG_ENABLED_KEY, false );
	}

	/** Whether auto-redirect-on-slug-change is switched on (default ON). */
	public function is_auto_redirect_enabled(): bool {
		return false !== $this->store->get( self::AUTO_REDIRECT_KEY, true );
	}

	// ── mutators (STATEMENT 1 is the authoritative gate) ───────────────────────

	/**
	 * Add a rule. STATEMENT 1 is the authoritative entitlement gate — nothing
	 * below it runs for a locked site. Then the full save-time gauntlet, then an
	 * immutable append. The id is derived server-side from the deduped normalized
	 * source — never from request input.
	 *
	 * @return array{ ok:bool, reason?:string, rule?:array, rules_count?:int, gate?:array }
	 */
	public function add_rule( string $source, string $target, int $type ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		if ( ! in_array( $type, self::ALLOWED_TYPES, true ) ) {
			return $this->refusal( 'bad-type' );
		}

		$src = $this->validate_source( $source );
		if ( empty( $src['ok'] ) ) {
			return $this->refusal( (string) $src['reason'] );
		}
		$normalized_source = (string) $src['value'];

		$tgt = $this->validate_target( $target, $normalized_source );
		if ( empty( $tgt['ok'] ) ) {
			return $this->refusal( (string) $tgt['reason'] );
		}
		$location = (string) $tgt['value'];

		$rules = $this->rules();

		foreach ( $rules as $rule ) {
			if ( self::normalize_path( (string) $rule['source'] ) === $normalized_source ) {
				return $this->refusal( 'duplicate-source' );
			}
		}

		if ( count( $rules ) >= self::MAX_RULES ) {
			return $this->refusal( 'max-rules' );
		}

		// Reject a rule that would complete a redirect loop/chain (A→B→A, …).
		if ( self::detect_cycle( $rules, $normalized_source, $location ) ) {
			return $this->refusal( 'creates-redirect-loop' );
		}

		$new_rule = array(
			'id'         => 'r' . substr( sha1( $normalized_source ), 0, 12 ),
			'source'     => $normalized_source,
			'target'     => $location,
			'type'       => $type,
			'hits'       => 0,
			'external'   => $this->is_external_target( $location ),
			'created_at' => $this->now_seconds(),
		);

		$next = array_merge( $rules, array( $new_rule ) );
		$this->store->set( self::RULES_KEY, $next );

		return array(
			'ok'          => true,
			'rule'        => $new_rule,
			'rules_count' => count( $next ),
		);
	}

	/**
	 * Delete a rule by its server-derived id. STATEMENT 1 is the gate. The id must
	 * match RULE_ID_RE and exist; the list is rebuilt immutably.
	 *
	 * @return array{ ok:bool, reason?:string, deleted?:string, rules_count?:int, gate?:array }
	 */
	public function delete_rule( string $id ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}

		if ( ! preg_match( self::RULE_ID_RE, $id ) ) {
			return $this->refusal( 'unknown-rule' );
		}

		$rules = $this->rules();
		$found = false;
		foreach ( $rules as $rule ) {
			if ( (string) $rule['id'] === $id ) {
				$found = true;
				break;
			}
		}
		if ( ! $found ) {
			return $this->refusal( 'unknown-rule' );
		}

		$next = array_values(
			array_filter(
				$rules,
				static function ( array $rule ) use ( $id ): bool {
					return (string) $rule['id'] !== $id;
				}
			)
		);
		$this->store->set( self::RULES_KEY, $next );

		return array(
			'ok'          => true,
			'deleted'     => $id,
			'rules_count' => count( $next ),
		);
	}

	/**
	 * Toggle 404 logging. STATEMENT 1 is the gate.
	 *
	 * @return array{ ok:bool, reason?:string, enabled?:bool, gate?:array }
	 */
	public function set_404_logging( bool $enabled ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}
		$this->store->set( self::LOG_ENABLED_KEY, $enabled );
		return array( 'ok' => true, 'enabled' => $enabled );
	}

	/**
	 * Toggle auto-redirect-on-slug-change. STATEMENT 1 is the gate. Mirrors
	 * set_404_logging(); the default is ON, so this exists to turn it OFF.
	 *
	 * @return array{ ok:bool, reason?:string, enabled?:bool, gate?:array }
	 */
	public function set_auto_redirect( bool $enabled ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'gate' => $gate );
		}
		$this->store->set( self::AUTO_REDIRECT_KEY, $enabled );
		return array( 'ok' => true, 'enabled' => $enabled );
	}

	// ── the engine (pure decision) + the effect ────────────────────────────────

	/**
	 * The pure decision function. STATEMENT 1 is the authoritative gate, returning
	 * a locked result with zero side effects. Parses the request path, matches it
	 * against the rules, and request-time re-validates the matched rule's stored
	 * target (defence-in-depth) — a rule that no longer validates is silently
	 * skipped, never an error. Never redirects itself: separating decision from
	 * effect is what lets the harness assert with a recording fake.
	 *
	 * @return array{ ok:bool, reason?:string, matched:bool, rule_id?:string, location?:string, status?:int }
	 */
	public function apply( string $request_uri ): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array( 'ok' => false, 'reason' => 'entitlement-locked', 'matched' => false );
		}

		$path = self::extract_path( $request_uri );
		if ( null === $path ) {
			return array( 'ok' => true, 'matched' => false );
		}
		$request_path = self::normalize_path( $path );

		foreach ( $this->rules() as $rule ) {
			$rule_source = self::normalize_path( (string) $rule['source'] );
			if ( ! $this->any_matcher_matches( $rule_source, $request_path ) ) {
				continue;
			}
			$tgt = $this->validate_target( (string) $rule['target'], $rule_source );
			if ( empty( $tgt['ok'] ) ) {
				continue; // DB-tampered / no-longer-valid target — skip silently.
			}
			return array(
				'ok'       => true,
				'matched'  => true,
				'rule_id'  => (string) $rule['id'],
				'location' => (string) $tgt['value'],
				'status'   => (int) $rule['type'],
			);
		}

		return array( 'ok' => true, 'matched' => false );
	}

	/**
	 * The template_redirect callback. STATEMENT 1 is the gate check — a revoked
	 * flag returns immediately and restores default WordPress behavior, even if
	 * apply() is ever bypassed. On a match: best-effort immutable hit increment,
	 * then the injected redirector. On no match with logging on and is_404(): log.
	 */
	public function maybe_redirect(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return;
		}

		$uri      = $this->request_uri();
		$decision = $this->apply( $uri );

		if ( ! empty( $decision['matched'] ) ) {
			$this->increment_hits( (string) $decision['rule_id'] );
			( $this->redirector )( (string) $decision['location'], (int) $decision['status'] );
			return;
		}

		if ( $this->is_404_logging_enabled() && ( $this->is_404 )() ) {
			$path = self::extract_path( $uri );
			if ( null !== $path ) {
				$this->log_404( self::normalize_path( $path ) );
			}
		}
	}

	// ── auto-redirect on slug change (WP glue) ─────────────────────────────────

	/**
	 * `pre_post_update`: snapshot the CURRENT (old) permalink of an already-published
	 * public post before WordPress writes the update, so we can diff it afterwards.
	 * Gate + toggle checked; every WP call guarded. $data is the incoming update.
	 *
	 * @param int   $post_id
	 * @param mixed $data
	 */
	public function snapshot_permalink( int $post_id, $data = null ): void {
		if ( $post_id <= 0 || ! $this->auto_redirect_active() ) {
			return;
		}
		$type = function_exists( 'get_post_type' ) ? (string) get_post_type( $post_id ) : '';
		if ( ! $this->is_public_type( $type ) ) {
			return;
		}
		if ( function_exists( 'get_post_status' ) && 'publish' !== get_post_status( $post_id ) ) {
			return; // Only track posts that already had a public URL.
		}
		if ( function_exists( 'get_permalink' ) ) {
			$link = get_permalink( $post_id );
			if ( is_string( $link ) && '' !== $link ) {
				$this->pending_permalinks[ $post_id ] = $link;
			}
		}
	}

	/**
	 * `post_updated`: if the permalink changed for a still-published post, create a
	 * 301 from the OLD path to the NEW permalink via the gated add_rule() (whose
	 * validators + loop-detection + gate apply). Snapshot is consumed once.
	 *
	 * @param int   $post_id
	 * @param mixed $post_after
	 * @param mixed $post_before
	 */
	public function maybe_auto_redirect( int $post_id, $post_after = null, $post_before = null ): void {
		if ( ! isset( $this->pending_permalinks[ $post_id ] ) ) {
			return;
		}
		$old = (string) $this->pending_permalinks[ $post_id ];
		unset( $this->pending_permalinks[ $post_id ] );

		if ( ! $this->auto_redirect_active() ) {
			return;
		}
		$status_after = is_object( $post_after ) && isset( $post_after->post_status )
			? (string) $post_after->post_status
			: ( function_exists( 'get_post_status' ) ? (string) get_post_status( $post_id ) : '' );
		if ( 'publish' !== $status_after ) {
			return; // Unpublished — no live URL to redirect to.
		}
		$new = function_exists( 'get_permalink' ) ? (string) get_permalink( $post_id ) : '';
		$auto = self::build_auto_source_target( $old, $new );
		if ( null === $auto ) {
			return;
		}
		$this->add_rule( $auto['source'], $auto['target'], 301 ); // reuse the gated validator.
	}

	/** Whether the feature is unlocked AND auto-redirect is toggled on. */
	private function auto_redirect_active(): bool {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		return ! empty( $gate['unlocked'] ) && $this->is_auto_redirect_enabled();
	}

	/** Whether $type is a public post type (attachment excluded); post+page outside WP. */
	private function is_public_type( string $type ): bool {
		if ( '' === $type ) {
			return false;
		}
		if ( function_exists( 'get_post_types' ) ) {
			$types = get_post_types( array( 'public' => true ), 'names' );
			if ( is_array( $types ) ) {
				unset( $types['attachment'] );
				return in_array( $type, array_values( $types ), true );
			}
		}
		return in_array( $type, array( 'post', 'page' ), true );
	}

	// ── normalization (public static so tests hit it directly) ─────────────────

	/**
	 * Trailing-slash-insensitive path normalization: trim trailing slashes but
	 * preserve the root `/`. No decoding, no case folding — matching stays
	 * byte-exact on the encoded path.
	 */
	public static function normalize_path( string $path ): string {
		if ( '' === $path ) {
			return '';
		}
		$trimmed = rtrim( $path, '/' );
		return '' === $trimmed ? '/' : $trimmed;
	}

	/**
	 * Build the (source, target) for an auto-redirect from an OLD → NEW permalink
	 * pair, or null when there is nothing to do (either empty, or the normalized
	 * paths are equal — a no-op change). Pure: the caller feeds the two permalinks
	 * and passes the result to the gated add_rule(). Source is the old path; target
	 * is the new permalink verbatim (the add_rule validators re-check it).
	 *
	 * @return array{ source:string, target:string }|null
	 */
	public static function build_auto_source_target( string $old_permalink, string $new_permalink ): ?array {
		$old = trim( $old_permalink );
		$new = trim( $new_permalink );
		if ( '' === $old || '' === $new ) {
			return null;
		}
		$old_path = self::extract_path( $old );
		if ( null === $old_path ) {
			return null;
		}
		$old_norm = self::normalize_path( $old_path );
		if ( '' === $old_norm ) {
			return null;
		}
		$new_path = self::extract_path( $new );
		$new_norm = null !== $new_path ? self::normalize_path( $new_path ) : '';
		if ( $old === $new || $old_norm === $new_norm ) {
			return null; // No slug change — nothing to redirect.
		}
		return array( 'source' => $old_norm, 'target' => $new );
	}

	/**
	 * Whether adding (candidate_source → candidate_target) would create a redirect
	 * loop or an over-long chain. Builds a source-path → target-path graph from the
	 * existing rules plus the candidate, then walks forward from the candidate
	 * source: revisiting any node (or returning to the start) is a cycle, and a
	 * chain longer than MAX_REDIRECT_HOPS is treated as unsafe (fail-closed). An
	 * external / pathless candidate target cannot loop internally → false. Pure.
	 *
	 * @param array<int, array> $rules Existing stored rules (each with source+target).
	 */
	public static function detect_cycle( array $rules, string $candidate_source, string $candidate_target ): bool {
		$graph = array();
		foreach ( $rules as $rule ) {
			if ( ! is_array( $rule ) || ! isset( $rule['source'], $rule['target'] ) ) {
				continue;
			}
			$src = self::normalize_path( (string) $rule['source'] );
			$tgt = self::graph_target_path( (string) $rule['target'] );
			if ( '' !== $src && null !== $tgt ) {
				$graph[ $src ] = $tgt;
			}
		}

		$start = self::normalize_path( $candidate_source );
		$cand_tgt = self::graph_target_path( $candidate_target );
		if ( '' === $start || null === $cand_tgt ) {
			return false;
		}
		$graph[ $start ] = $cand_tgt;

		$current = $start;
		$seen = array();
		for ( $hop = 0; $hop < self::MAX_REDIRECT_HOPS; $hop++ ) {
			if ( ! isset( $graph[ $current ] ) ) {
				return false; // Chain terminates at a non-redirected path.
			}
			$next = $graph[ $current ];
			if ( $next === $start || isset( $seen[ $next ] ) ) {
				return true; // Returns to the start or revisits a node → cycle.
			}
			$seen[ $next ] = true;
			$current = $next;
		}
		return true; // Exceeded the hop budget without terminating.
	}

	/** The graph node (path) for a redirect target, or null when it has no path. */
	private static function graph_target_path( string $target ): ?string {
		$target = trim( $target );
		if ( '' === $target ) {
			return null;
		}
		if ( '/' === $target[0] ) {
			return self::normalize_path( $target );
		}
		$path = self::extract_path( $target );
		return null !== $path ? self::normalize_path( $path ) : null;
	}

	// ── validators (the save-time security gauntlet) ───────────────────────────

	/**
	 * Validate + normalize a source path. Refuses scheme-relative, backslash,
	 * control/whitespace, non-rooted, query/fragment/scheme-bearing, and reserved
	 * admin paths.
	 *
	 * @return array{ ok:bool, reason:string, value:string }
	 */
	private function validate_source( string $source ): array {
		if ( '' === $source || strlen( $source ) > self::MAX_SOURCE_LEN ) {
			return self::invalid( 'bad-source' );
		}
		if ( false !== strpos( $source, '\\' ) ) {
			return self::invalid( 'bad-source' );
		}
		if ( preg_match( '/[\x00-\x1F\x7F\s]/', $source ) ) {
			return self::invalid( 'bad-source' );
		}
		if ( 0 === strpos( $source, '//' ) ) {
			return self::invalid( 'scheme-relative' );
		}
		if ( '/' !== $source[0] ) {
			return self::invalid( 'bad-source' );
		}
		if ( false !== strpos( $source, '?' )
			|| false !== strpos( $source, '#' )
			|| false !== strpos( $source, '://' ) ) {
			return self::invalid( 'bad-source' );
		}
		$normalized = self::normalize_path( $source );
		if ( self::is_reserved_path( $normalized ) ) {
			return self::invalid( 'reserved-path' );
		}
		return array( 'ok' => true, 'reason' => '', 'value' => $normalized );
	}

	/**
	 * Validate a target and return the location to store. Relative targets are
	 * rooted internal paths; absolute targets must be strict http(s) URLs that
	 * survive the full gauntlet (scheme, host, userinfo, wp_http_validate_url,
	 * esc_url_raw round-trip, external allow-list). Self-loops are refused for
	 * relative targets and internal absolute targets.
	 *
	 * @return array{ ok:bool, reason:string, value:string }
	 */
	private function validate_target( string $target, string $normalized_source ): array {
		if ( '' === $target || strlen( $target ) > self::MAX_TARGET_LEN ) {
			return self::invalid( 'bad-target' );
		}
		if ( false !== strpos( $target, '\\' ) ) {
			return self::invalid( 'bad-target' );
		}
		if ( preg_match( '/[\x00-\x1F\x7F\s]/', $target ) ) {
			return self::invalid( 'bad-target' );
		}
		if ( 0 === strpos( $target, '//' ) ) {
			return self::invalid( 'scheme-relative' );
		}

		// Relative (internal) target: a rooted path.
		if ( '/' === $target[0] ) {
			if ( false !== strpos( $target, '://' ) ) {
				return self::invalid( 'bad-target' );
			}
			$dest = self::normalize_path( $target );
			if ( $dest === $normalized_source ) {
				return self::invalid( 'self-redirect' );
			}
			return array( 'ok' => true, 'reason' => '', 'value' => $dest );
		}

		return $this->validate_absolute_target( $target, $normalized_source );
	}

	/**
	 * The absolute-URL branch of the target gauntlet.
	 *
	 * @return array{ ok:bool, reason:string, value:string }
	 */
	private function validate_absolute_target( string $target, string $normalized_source ): array {
		$parts = self::parse_url_parts( $target );
		if ( null === $parts ) {
			return self::invalid( 'bad-target' );
		}

		$scheme = isset( $parts['scheme'] ) ? strtolower( (string) $parts['scheme'] ) : '';
		if ( 'http' !== $scheme && 'https' !== $scheme ) {
			return self::invalid( 'bad-target' );
		}

		$host = isset( $parts['host'] ) ? (string) $parts['host'] : '';
		if ( '' === $host ) {
			return self::invalid( 'bad-target' );
		}

		// Userinfo confusion: https://trusted@evil.com.
		if ( isset( $parts['user'] ) || isset( $parts['pass'] ) ) {
			return self::invalid( 'bad-target' );
		}

		// WordPress URL validators (guarded); outside WP the local checks stand.
		if ( function_exists( 'wp_http_validate_url' ) && ! wp_http_validate_url( $target ) ) {
			return self::invalid( 'bad-target' );
		}
		if ( function_exists( 'esc_url_raw' ) ) {
			$clean = esc_url_raw( $target, array( 'http', 'https' ) );
			if ( $clean !== $target ) {
				return self::invalid( 'bad-target' );
			}
		}

		$port    = isset( $parts['port'] ) ? (int) $parts['port'] : null;
		$is_home = ( '' !== $this->home_host )
			&& ( strtolower( $host ) === $this->home_host )
			&& ( $port === $this->home_port );

		if ( ! $is_home ) {
			if ( ! in_array( strtolower( $host ), $this->allow_hosts_lc(), true ) ) {
				return self::invalid( 'external-not-allowed' );
			}
		} else {
			$path = self::normalize_path( isset( $parts['path'] ) ? (string) $parts['path'] : '/' );
			if ( $path === $normalized_source ) {
				return self::invalid( 'self-redirect' );
			}
		}

		return array( 'ok' => true, 'reason' => '', 'value' => $target );
	}

	// ── internal helpers ───────────────────────────────────────────────────────

	/** Whether any registered matcher matches. */
	private function any_matcher_matches( string $rule_source, string $request_path ): bool {
		foreach ( $this->matchers as $matcher ) {
			if ( $matcher instanceof IWSL_Redirect_Matcher && $matcher->matches( $rule_source, $request_path ) ) {
				return true;
			}
		}
		return false;
	}

	/** Whether a validated location points off-site. Relative → internal. */
	private function is_external_target( string $location ): bool {
		if ( '' === $location || '/' === $location[0] ) {
			return false;
		}
		$parts = self::parse_url_parts( $location );
		if ( null === $parts || ! isset( $parts['host'] ) ) {
			return false;
		}
		$host = strtolower( (string) $parts['host'] );
		$port = isset( $parts['port'] ) ? (int) $parts['port'] : null;
		return ! ( '' !== $this->home_host && $host === $this->home_host && $port === $this->home_port );
	}

	/** Best-effort immutable hit increment for the matched rule. */
	private function increment_hits( string $rule_id ): void {
		$rules   = $this->rules();
		$changed = false;
		$next    = array();
		foreach ( $rules as $rule ) {
			if ( (string) $rule['id'] === $rule_id ) {
				$updated         = $rule;
				$updated['hits'] = (int) $rule['hits'] + 1;
				$next[]          = $updated;
				$changed         = true;
			} else {
				$next[] = $rule;
			}
		}
		if ( $changed ) {
			$this->store->set( self::RULES_KEY, $next );
		}
	}

	/**
	 * Record a not-found path in the ring buffer: dedupe by path (count +
	 * last_seen), capped at MAX_404_LOG. Only the validated normalized path is
	 * stored, truncated defensively.
	 */
	private function log_404( string $path ): void {
		if ( '' === $path ) {
			return;
		}
		$path = substr( $path, 0, self::MAX_SOURCE_LEN );
		$now  = $this->now_seconds();
		$log  = $this->log_entries();

		$found = false;
		$next  = array();
		foreach ( $log as $entry ) {
			if ( $entry['path'] === $path ) {
				$next[] = array(
					'path'      => $entry['path'],
					'count'     => (int) $entry['count'] + 1,
					'last_seen' => $now,
				);
				$found = true;
			} else {
				$next[] = $entry;
			}
		}
		if ( ! $found ) {
			$next[] = array(
				'path'      => $path,
				'count'     => 1,
				'last_seen' => $now,
			);
		}
		if ( count( $next ) > self::MAX_404_LOG ) {
			$next = array_slice( $next, -self::MAX_404_LOG );
		}
		$this->store->set( self::LOG_KEY, $next );
	}

	/** A fresh refusal carrying the live rule count. */
	private function refusal( string $reason ): array {
		return array(
			'ok'          => false,
			'reason'      => $reason,
			'rules_count' => count( $this->rules() ),
		);
	}

	/** A fresh validator-failure record. */
	private static function invalid( string $reason ): array {
		return array( 'ok' => false, 'reason' => $reason, 'value' => '' );
	}

	/** Re-validate one stored rule's shape, returning a fresh normalized copy or null. */
	private static function sanitize_rule_shape( $rule ): ?array {
		if ( ! is_array( $rule ) ) {
			return null;
		}
		if ( ! isset( $rule['id'], $rule['source'], $rule['target'], $rule['type'] ) ) {
			return null;
		}
		if ( ! is_string( $rule['id'] ) || ! preg_match( self::RULE_ID_RE, $rule['id'] ) ) {
			return null;
		}
		if ( ! is_string( $rule['source'] ) || ! is_string( $rule['target'] ) ) {
			return null;
		}
		$type = (int) $rule['type'];
		if ( ! in_array( $type, self::ALLOWED_TYPES, true ) ) {
			return null;
		}
		return array(
			'id'         => $rule['id'],
			'source'     => $rule['source'],
			'target'     => $rule['target'],
			'type'       => $type,
			'hits'       => isset( $rule['hits'] ) ? (int) $rule['hits'] : 0,
			'external'   => ! empty( $rule['external'] ),
			'created_at' => isset( $rule['created_at'] ) ? (int) $rule['created_at'] : 0,
		);
	}

	/** Whether a normalized path is at or under a reserved admin path. */
	private static function is_reserved_path( string $path ): bool {
		$reserved = array( '/wp-admin', '/wp-login.php', '/wp-json' );
		foreach ( $reserved as $prefix ) {
			if ( $path === $prefix || 0 === strpos( $path, $prefix . '/' ) ) {
				return true;
			}
		}
		return false;
	}

	/** Parse a URL into parts, wp_parse_url when available, else parse_url. @return array|null */
	private static function parse_url_parts( string $url ): ?array {
		$parts = function_exists( 'wp_parse_url' ) ? wp_parse_url( $url ) : parse_url( $url );
		return is_array( $parts ) ? $parts : null;
	}

	/** Extract the path component from a request URI, or null when unparseable. @return string|null */
	private static function extract_path( string $uri ): ?string {
		if ( '' === $uri ) {
			return null;
		}
		$path = function_exists( 'wp_parse_url' )
			? wp_parse_url( $uri, PHP_URL_PATH )
			: parse_url( $uri, PHP_URL_PATH );
		if ( ! is_string( $path ) || '' === $path ) {
			return null;
		}
		return $path;
	}

	/** The current request URI, unslashed when WordPress is present. */
	private function request_uri(): string {
		if ( ! isset( $_SERVER['REQUEST_URI'] ) ) {
			return '';
		}
		// Only the path component is ever used (parsed via extract_path), never
		// echoed — reading it raw here is safe.
		$raw = $_SERVER['REQUEST_URI']; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized, WordPress.Security.ValidatedSanitizedInput.MissingUnslash
		return function_exists( 'wp_unslash' ) ? (string) wp_unslash( $raw ) : (string) $raw;
	}

	/** Lowercased, non-empty external allow-list. @return string[] */
	private function allow_hosts_lc(): array {
		$out = array();
		foreach ( $this->allow_hosts as $host ) {
			if ( is_string( $host ) && '' !== $host ) {
				$out[] = strtolower( $host );
			}
		}
		return $out;
	}

	private function now_seconds(): int {
		return (int) floor( ( $this->now_ms )() / 1000 );
	}

	/** Lowercased home host from home_url(), '' outside WordPress. */
	private static function default_home_host(): string {
		if ( function_exists( 'home_url' ) ) {
			$home = home_url();
			if ( is_string( $home ) && '' !== $home ) {
				$parts = self::parse_url_parts( $home );
				if ( null !== $parts && isset( $parts['host'] ) && is_string( $parts['host'] ) ) {
					return strtolower( $parts['host'] );
				}
			}
		}
		return '';
	}

	/** Explicit home port from home_url(), or null. @return int|null */
	private static function default_home_port(): ?int {
		if ( function_exists( 'home_url' ) ) {
			$home = home_url();
			if ( is_string( $home ) && '' !== $home ) {
				$parts = self::parse_url_parts( $home );
				if ( null !== $parts && isset( $parts['port'] ) ) {
					return (int) $parts['port'];
				}
			}
		}
		return null;
	}

	/**
	 * The default redirector: wp_safe_redirect + exit. For an (already
	 * save-time-allow-listed) external target it briefly registers the target host
	 * via the allowed_redirect_hosts filter so wp_safe_redirect stays the SOLE
	 * redirect primitive for every redirect.
	 */
	private static function default_redirector(): callable {
		return static function ( string $location, int $status ): void {
			$host  = '';
			$parts = function_exists( 'wp_parse_url' ) ? wp_parse_url( $location ) : parse_url( $location );
			if ( is_array( $parts ) && isset( $parts['host'] ) && is_string( $parts['host'] ) ) {
				$host = $parts['host'];
			}
			$filter = null;
			if ( '' !== $host && function_exists( 'add_filter' ) ) {
				$filter = static function ( $hosts ) use ( $host ): array {
					$existing = is_array( $hosts ) ? $hosts : array();
					return array_merge( $existing, array( $host ) );
				};
				add_filter( 'allowed_redirect_hosts', $filter );
			}
			if ( function_exists( 'wp_safe_redirect' ) ) {
				wp_safe_redirect( $location, $status );
			}
			if ( null !== $filter && function_exists( 'remove_filter' ) ) {
				remove_filter( 'allowed_redirect_hosts', $filter );
			}
			exit;
		};
	}

	/** The default external allow-list — empty, widened only by the code filter. @return array */
	private static function default_allow_hosts(): array {
		if ( function_exists( 'apply_filters' ) ) {
			$hosts = apply_filters( 'iwsl_redirects_external_allow_hosts', array() );
			return is_array( $hosts ) ? $hosts : array();
		}
		return array();
	}
}
