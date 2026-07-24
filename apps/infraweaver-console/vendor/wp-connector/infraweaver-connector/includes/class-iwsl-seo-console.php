<?php
/**
 * Signed-channel SEO surface for the console (§7). This class is the ONLY new
 * console<->connector surface the SEO overhaul adds: four signed methods —
 * `seo.status`, `seo.audit.run`, `seo.alt.backfill`, `seo.fix.apply` — wired into
 * IWSL_Plugin::command_handlers() (validators + runner closures). There is NO new
 * REST/AJAX/public endpoint anywhere (invariant §feedback_iwsl_signed_channel).
 *
 * COMPOSITION, not duplication. The suite file (IWSL_SEO_Suite) is already ~1.9k
 * lines and must not grow, so this thin orchestrator composes the existing engines:
 *   - IWSL_SEO_Audit  — the bounded read-only meta scan (durable last-audit here).
 *   - IWSL_SEO_Suite  — per-post `_iwseo_*` meta + sitemap/settings (sanitizer reuse).
 *   - IWSL_SEO_Alt_Text — the pure, never-clobber alt derivation.
 *
 * GATING (triple-gate; STATEMENT 1 of every mutating/gated runner). gate() ANDs the
 * signed entitlement (IWSL_Entitlements::evaluate — active + fresh heartbeat + flag)
 * with the operator kill-switch (IWSL_Feature_Switches::is_on). A locked runner
 * returns [false, { locked:true, reason:'entitlement-locked', gate }] — a structured
 * reply the console renders as an upsell, never a raw error. Tiers: `seo_audit` is
 * Pro (audit.run); `seo_suite` is Ultimate (alt.backfill, fix.apply). `seo.status`
 * is an unauthenticated-safe READ (counts only) whose per-section fields carry their
 * own unlocked/switched-off markers, so a Basic site still gets a well-formed snapshot.
 *
 * BOUNDS (keeps the signed envelope under the §6.2 ceiling; ≤64KB target). status()
 * returns COUNTS ONLY (no item lists). audit.run caps items on the wire at
 * WIRE_ITEM_CAP (50). alt.backfill scans ≤MAX_BATCH (200) attachments/run and returns
 * ≤ALT_SAMPLE_CAP (10) samples. Every validator refuses stray keys and enforces the
 * int/enum ceilings on both sides of the wire.
 *
 * REUSE NOTE (media-fusion). `seo.alt.backfill` is the single engine behind BOTH the
 * SEO panel's "fill missing alt" finding and the media explorer's bulk bar — one
 * signed method, two doors. Its result shape { scanned, filled, fillable, remaining,
 * samples } is what the media console loops over (dry_run preview → batches until
 * remaining=0). Do not fork a second backfill path for the explorer.
 *
 * PURITY / TEST HARNESS. plan_backfill(), fold_status(), the validators and the param
 * helpers are pure and exercised with plain arrays under the zero-WP runner. Every
 * WordPress touch (the $wpdb counts, get_post/update_post_meta) is function_exists /
 * method_exists guarded, so off-WP every gather degrades to 0/null and status() still
 * returns a well-formed envelope.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_SEO_Console {

	/** Entitlement flags this surface gates on (mirror the engine constants). */
	const AUDIT_FEATURE = 'seo_audit'; // Pro
	const SUITE_FEATURE = 'seo_suite'; // Ultimate

	/** Max audit items serialized onto the signed wire (counts stay unbounded-safe). */
	const WIRE_ITEM_CAP = 50;

	/** Hard cap on attachments scanned per alt-backfill run — bounds per-request cost. */
	const MAX_BATCH = 200;

	/** Max { id, derived } preview samples returned by a backfill run. */
	const ALT_SAMPLE_CAP = 10;

	/** Core meta key WordPress stores an attachment's alt text under. */
	const ALT_META_KEY = '_wp_attachment_image_alt';

	/** The STRICT field allow-list for seo.fix.apply — nothing else is writable. */
	const FIX_FIELDS = array( 'title', 'desc', 'focuskw', 'noindex' );

	/** Byte ceiling on a fix value (matches the suite's widest field, MAX_DESC_LEN). */
	const MAX_FIX_VALUE = 400;

	/** @var IWSL_Entitlements the signed entitlement gate. */
	private $entitlements;

	/** @var IWSL_Feature_Switches the operator kill-switch layer. */
	private $switches;

	/** @var IWSL_Store|null durable persistence (last-audit + suite settings). */
	private $store;

	/** @var IWSL_SEO_Suite|null memoized suite instance (sanitizer + settings reuse). */
	private $suite;

	public function __construct( IWSL_Entitlements $entitlements, IWSL_Feature_Switches $switches, ?IWSL_Store $store = null ) {
		$this->entitlements = $entitlements;
		$this->switches     = $switches;
		$this->store        = $store;
	}

	// ── the gate (entitlement AND operator switch; STATEMENT 1 everywhere) ────────

	/**
	 * The effective gate for a feature: the signed entitlement AND the operator
	 * switch. Returns a NEW array (never mutates evaluate()'s result). When the tier
	 * grants the feature but the site admin switched it off, unlocked flips to false
	 * with a `switched_off` marker + a `switched-off` reason, so "off means off no
	 * matter who calls" (F2).
	 *
	 * @return array the evaluate() shape plus `switched_off`.
	 */
	public function gate( string $feature ): array {
		$gate = $this->entitlements->evaluate( $feature );
		if ( ! empty( $gate['unlocked'] ) && ! $this->switches->is_on( $feature ) ) {
			$reasons = array_values( array_unique( array_merge( (array) ( $gate['reasons'] ?? array() ), array( 'switched-off' ) ) ) );
			return array_merge( $gate, array( 'unlocked' => false, 'switched_off' => true, 'reasons' => $reasons ) );
		}
		return array_merge( $gate, array( 'switched_off' => false ) );
	}

	/** The structured locked reply every gated runner returns when its gate fails. */
	private static function locked_result( array $gate ): array {
		return array(
			false,
			array(
				'ok'     => false,
				'locked' => true,
				'reason' => 'entitlement-locked',
				'gate'   => $gate,
			),
		);
	}

	// ── seo.status: a bounded, counts-only snapshot (safe read) ───────────────────

	/**
	 * The signed `seo.status` runner. Never method-gated (a safe read): every section
	 * carries its own unlocked/locked marker so a Basic site still gets a well-formed
	 * snapshot. Counts only — no item lists — so the envelope stays tiny. Suite-only
	 * sections are null/zeroed when the suite gate is closed.
	 *
	 * @return array{0:bool,1:array}
	 */
	public function status(): array {
		$suite_gate = $this->gate( self::SUITE_FEATURE );
		$audit_gate = $this->gate( self::AUDIT_FEATURE );
		$suite_open = ! empty( $suite_gate['unlocked'] );
		$audit_open = ! empty( $audit_gate['unlocked'] );

		$last = null;
		if ( $audit_open ) {
			$summary = $this->audit()->last_summary();
			$last    = null === $summary ? null : self::audit_last_counts( $summary );
		}

		$in = array(
			'suite'               => array(
				'unlocked'       => $suite_open,
				'switched_off'   => ! empty( $suite_gate['switched_off'] ),
				'score'          => $suite_open ? $this->gather_suite_score() : null,
				'sitemap'        => $suite_open ? $this->gather_sitemap() : array( 'active' => false, 'url' => null ),
				'robots_managed' => $suite_open,
			),
			'audit'               => array(
				'unlocked'     => $audit_open,
				'switched_off' => ! empty( $audit_gate['switched_off'] ),
				'last'         => $last,
			),
			'alt'                 => $this->gather_alt(),
			'keywords'            => $suite_open ? $this->gather_keywords() : array( 'set' => 0, 'missing' => 0, 'duplicates' => 0 ),
			'schema'              => $suite_open ? $this->gather_schema() : null,
			'four04'              => null, // cross-domain: site-health owns redirect.* (see follow-ups).
			'noindexed'           => $suite_open ? $this->count_meta_value( IWSL_SEO_Suite::META_NOINDEX, '1' ) : 0,
			'conflicting_engines' => $suite_open ? $this->detect_conflicts() : array(),
		);

		return array( true, self::fold_status( $in ) );
	}

	/**
	 * Pure assembly of the `seo.status` wire envelope from already-gathered numbers.
	 * Defensive casts everywhere so a partial/absent section yields a well-formed
	 * (zeroed/null) field rather than a gap. Unit-tested with plain arrays.
	 */
	public static function fold_status( array $in ): array {
		$suite  = isset( $in['suite'] ) && is_array( $in['suite'] ) ? $in['suite'] : array();
		$audit  = isset( $in['audit'] ) && is_array( $in['audit'] ) ? $in['audit'] : array();
		$alt    = isset( $in['alt'] ) && is_array( $in['alt'] ) ? $in['alt'] : array();
		$kw     = isset( $in['keywords'] ) && is_array( $in['keywords'] ) ? $in['keywords'] : array();
		$schema = isset( $in['schema'] ) && is_array( $in['schema'] ) ? $in['schema'] : null;
		$four04 = isset( $in['four04'] ) && is_array( $in['four04'] ) ? $in['four04'] : null;
		$score  = isset( $suite['score'] ) && is_array( $suite['score'] ) ? $suite['score'] : array();
		$hist   = isset( $score['histogram'] ) && is_array( $score['histogram'] ) ? $score['histogram'] : array();
		$smap   = isset( $suite['sitemap'] ) && is_array( $suite['sitemap'] ) ? $suite['sitemap'] : array();

		return array(
			'ok'                  => true,
			'engines'             => array(
				'suite' => array(
					'unlocked'       => ! empty( $suite['unlocked'] ),
					'switched_off'   => ! empty( $suite['switched_off'] ),
					'score_avg'      => isset( $score['avg'] ) && null !== $score['avg'] ? (int) $score['avg'] : null,
					'histogram'      => array(
						'good' => (int) ( $hist['good'] ?? 0 ),
						'ok'   => (int) ( $hist['ok'] ?? 0 ),
						'poor' => (int) ( $hist['poor'] ?? 0 ),
						'none' => (int) ( $hist['none'] ?? 0 ),
					),
					'sitemap'        => array(
						'active' => ! empty( $smap['active'] ),
						'url'    => isset( $smap['url'] ) && is_string( $smap['url'] ) ? $smap['url'] : null,
					),
					'robots_managed' => ! empty( $suite['robots_managed'] ),
				),
				'audit' => array(
					'unlocked'     => ! empty( $audit['unlocked'] ),
					'switched_off' => ! empty( $audit['switched_off'] ),
					'last'         => isset( $audit['last'] ) && is_array( $audit['last'] ) ? $audit['last'] : null,
				),
			),
			'alt'                 => array(
				'images'  => (int) ( $alt['images'] ?? 0 ),
				'missing' => (int) ( $alt['missing'] ?? 0 ),
			),
			'keywords'            => array(
				'set'        => (int) ( $kw['set'] ?? 0 ),
				'missing'    => (int) ( $kw['missing'] ?? 0 ),
				'duplicates' => (int) ( $kw['duplicates'] ?? 0 ),
			),
			'schema'              => null === $schema ? null : array(
				'site_representation' => ! empty( $schema['site_representation'] ),
				'typed_posts'         => (int) ( $schema['typed_posts'] ?? 0 ),
				'published'           => (int) ( $schema['published'] ?? 0 ),
			),
			'four04'              => null === $four04 ? null : array(
				'logged'        => (int) ( $four04['logged'] ?? 0 ),
				'auto_redirect' => ! empty( $four04['auto_redirect'] ),
			),
			'noindexed'           => (int) ( $in['noindexed'] ?? 0 ),
			'conflicting_engines' => array_values( array_filter( (array) ( $in['conflicting_engines'] ?? array() ), 'is_string' ) ),
		);
	}

	/** Strip a durable audit summary down to the counts `seo.status` carries. */
	private static function audit_last_counts( array $summary ): array {
		return array(
			'scanned'      => (int) ( $summary['scanned'] ?? 0 ),
			'with_issues'  => (int) ( $summary['with_issues'] ?? 0 ),
			'issue_counts' => isset( $summary['issue_counts'] ) && is_array( $summary['issue_counts'] ) ? $summary['issue_counts'] : array(),
			'generated_at' => (string) ( $summary['generated_at'] ?? '' ),
		);
	}

	// ── seo.audit.run: run the bounded scan, persist durably, cap the wire ────────

	/**
	 * The signed `seo.audit.run` runner (gate: `seo_audit`, Pro). Runs the bounded
	 * read-only audit, persists a durable last-audit copy (so the score survives past
	 * the per-user render transient), and returns the summary with items capped at
	 * WIRE_ITEM_CAP. Counts (scanned/with_issues/issue_counts) are unbounded-safe.
	 *
	 * @param stdClass $params validated `{ limit?: 1..200 }`.
	 * @return array{0:bool,1:array}
	 */
	public function run_audit( $params ): array {
		$gate = $this->gate( self::AUDIT_FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return self::locked_result( $gate );
		}
		$limit   = self::param_int( $params, 'limit', IWSL_SEO_Audit::MAX_ITEMS, 1, IWSL_SEO_Audit::MAX_ITEMS );
		$audit   = $this->audit();
		$summary = $audit->run_audit( null, $limit );
		if ( empty( $summary['ok'] ) ) {
			// Audit's own STATEMENT-1 gate refused (defense in depth) — surface locked.
			return self::locked_result( isset( $summary['gate'] ) && is_array( $summary['gate'] ) ? $summary['gate'] : $gate );
		}
		$audit->persist_summary( $summary );
		return array( true, self::cap_wire_items( $summary, min( $limit, self::WIRE_ITEM_CAP ) ) );
	}

	/** Slice the items list to $cap while preserving every aggregate count. */
	private static function cap_wire_items( array $summary, int $cap ): array {
		$items          = isset( $summary['items'] ) && is_array( $summary['items'] ) ? array_values( $summary['items'] ) : array();
		$wire           = $summary;
		$wire['items']  = array_slice( $items, 0, max( 0, $cap ) );
		$wire['item_capped']   = count( $items ) > $cap;
		$wire['wire_item_cap'] = $cap;
		return $wire;
	}

	// ── seo.alt.backfill: bounded, idempotent, never-clobber (media-fusion reuse) ─

	/**
	 * The signed `seo.alt.backfill` runner (gate: `seo_suite`, Ultimate). Applies the
	 * SAME deterministic derivation new uploads already get to the EXISTING library,
	 * bounded at MAX_BATCH per run. Dry-run by DEFAULT (safe preview) — the console
	 * must pass `dry_run:false` to write. NEVER overwrites a non-empty alt (the
	 * resolve_fill invariant, re-checked at write time); idempotent (a second run over
	 * a filled library fills 0). Returns { scanned, filled, fillable, remaining,
	 * samples } — the shape the media explorer bulk bar loops over.
	 *
	 * @param stdClass $params validated `{ limit?: 1..200, dry_run?: bool }`.
	 * @return array{0:bool,1:array}
	 */
	public function backfill_alt( $params ): array {
		$gate = $this->gate( self::SUITE_FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return self::locked_result( $gate );
		}
		$limit       = self::param_int( $params, 'limit', self::MAX_BATCH, 1, self::MAX_BATCH );
		$dry_run     = self::param_bool( $params, 'dry_run', true );
		$attachments = $this->gather_missing_alt_attachments( $limit );
		$plan        = self::plan_backfill( $attachments );

		$filled = $dry_run ? 0 : $this->apply_backfill( $plan['fills'] );
		$samples = array();
		foreach ( array_slice( $plan['fills'], 0, self::ALT_SAMPLE_CAP ) as $f ) {
			$samples[] = array( 'id' => (int) $f['id'], 'derived' => (string) $f['derived'] );
		}

		return array(
			true,
			array(
				'ok'        => true,
				'dry_run'   => $dry_run,
				'scanned'   => (int) $plan['scanned'],
				'fillable'  => count( $plan['fills'] ),
				'filled'    => (int) $filled,
				'remaining' => $this->count_missing_alt(),
				'samples'   => $samples,
			),
		);
	}

	/**
	 * Pure planner: over a batch of attachment records, decide which get an alt and
	 * what it is, via the never-clobber IWSL_SEO_Alt_Text::resolve_fill (null =
	 * skip: an author already wrote one, or nothing could be derived). No writes, no
	 * WordPress — unit-tested with plain arrays.
	 *
	 * @param array<int, array{id:int,current_alt?:string,title?:string,filename?:string,parent_title?:string}> $attachments
	 * @return array{scanned:int, fills:array<int, array{id:int, derived:string}>}
	 */
	public static function plan_backfill( array $attachments ): array {
		$fills   = array();
		$scanned = 0;
		foreach ( $attachments as $a ) {
			$scanned++;
			$id = isset( $a['id'] ) ? (int) $a['id'] : 0;
			if ( $id <= 0 ) {
				continue;
			}
			$derived = IWSL_SEO_Alt_Text::resolve_fill(
				isset( $a['current_alt'] ) ? (string) $a['current_alt'] : '',
				isset( $a['title'] ) ? (string) $a['title'] : '',
				isset( $a['filename'] ) ? (string) $a['filename'] : '',
				isset( $a['parent_title'] ) ? (string) $a['parent_title'] : ''
			);
			if ( null !== $derived ) {
				$fills[] = array( 'id' => $id, 'derived' => $derived );
			}
		}
		return array( 'scanned' => $scanned, 'fills' => $fills );
	}

	/** Write the planned alts, re-checking the never-clobber invariant per item. */
	private function apply_backfill( array $fills ): int {
		if ( ! function_exists( 'update_post_meta' ) ) {
			return 0;
		}
		$written = 0;
		foreach ( $fills as $f ) {
			$id  = isset( $f['id'] ) ? (int) $f['id'] : 0;
			$alt = isset( $f['derived'] ) ? (string) $f['derived'] : '';
			if ( $id <= 0 || '' === $alt ) {
				continue;
			}
			$current = function_exists( 'get_post_meta' ) ? (string) get_post_meta( $id, self::ALT_META_KEY, true ) : '';
			if ( '' !== trim( $current ) ) {
				continue; // never clobber an author-written alt, even mid-batch.
			}
			update_post_meta( $id, self::ALT_META_KEY, $alt );
			$written++;
		}
		return $written;
	}

	// ── seo.fix.apply: strict field allow-list, suite-sanitized write ─────────────

	/**
	 * The signed `seo.fix.apply` runner (gate: `seo_suite`, Ultimate). Writes exactly
	 * ONE allow-listed `_iwseo_*` field for one post, sanitized through the suite's
	 * own sanitize_post_meta (so the byte ceilings/cleaners are shared, not forked).
	 * The validator already refused unknown fields/stray keys on the wire; this
	 * re-validates defensively. The stored value is echoed for optimistic re-audit.
	 *
	 * @param stdClass $params validated `{ post_id:int>0, field:enum, value:string≤400 }`.
	 * @return array{0:bool,1:array}
	 */
	public function apply_fix( $params ): array {
		$gate = $this->gate( self::SUITE_FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return self::locked_result( $gate );
		}
		if ( ! self::validate_fix_params( $params ) ) {
			return array( false, array( 'ok' => false, 'reason' => 'invalid-params' ) );
		}
		$vars    = get_object_vars( $params );
		$post_id = (int) $vars['post_id'];
		$field   = (string) $vars['field'];
		$value   = (string) $vars['value'];

		$mapped = $this->map_fix( $field, $value );
		if ( '' === $mapped['key'] ) {
			return array( false, array( 'ok' => false, 'reason' => 'unknown-field' ) );
		}
		// Post-type gate: only real posts/pages carry `_iwseo_*` meta. Reject any
		// other id (attachments, revisions, missing) so a numeric id can never seed
		// an orphan meta row — mirrors the `unknown-field` rejection above.
		if ( ! self::is_seo_post( $post_id ) ) {
			return array( false, array( 'ok' => false, 'reason' => 'unknown-post' ) );
		}
		if ( function_exists( 'update_post_meta' ) && $post_id > 0 ) {
			update_post_meta( $post_id, $mapped['key'], $mapped['value'] );
		}
		return array(
			true,
			array(
				'ok'      => true,
				'applied' => true,
				'field'   => $field,
				'stored'  => (string) $mapped['value'],
			),
		);
	}

	/**
	 * True when $post_id is a real post/page — the only object types that carry
	 * SEO meta. Fails closed for a missing id, a non-post type (attachment,
	 * revision, nav_menu_item, …), or when get_post is unavailable.
	 */
	private static function is_seo_post( int $post_id ): bool {
		if ( $post_id <= 0 || ! function_exists( 'get_post' ) ) {
			return false;
		}
		$post = get_post( $post_id );
		if ( ! is_object( $post ) || ! isset( $post->post_type ) ) {
			return false;
		}
		return in_array( (string) $post->post_type, array( 'post', 'page' ), true );
	}

	/**
	 * Map one allow-listed field+value to its `_iwseo_*` meta key and its sanitized
	 * value, REUSING the suite's sanitize_post_meta ceilings/cleaners (no forked
	 * sanitizer). Returns { key:'', value:'' } for any non-allow-listed field.
	 *
	 * @return array{key:string, value:string}
	 */
	private function map_fix( string $field, string $value ): array {
		$in  = array();
		$key = '';
		switch ( $field ) {
			case 'title':
				$in['title'] = $value;
				$key         = IWSL_SEO_Suite::META_TITLE;
				break;
			case 'desc':
				$in['desc'] = $value;
				$key        = IWSL_SEO_Suite::META_DESC;
				break;
			case 'focuskw':
				$in['focuskw'] = $value;
				$key           = IWSL_SEO_Suite::META_FOCUSKW;
				break;
			case 'noindex':
				$in['noindex'] = self::truthy( $value );
				$key           = IWSL_SEO_Suite::META_NOINDEX;
				break;
			default:
				return array( 'key' => '', 'value' => '' );
		}
		$sanitized = $this->suite()->sanitize_post_meta( $in );
		return array( 'key' => $key, 'value' => isset( $sanitized[ $key ] ) ? (string) $sanitized[ $key ] : '' );
	}

	// ── validators (referenced by the command registry allow-list) ────────────────

	/** `seo.audit.run`: optional `limit` 1..200, no stray keys. */
	public static function validate_audit_params( $params ): bool {
		if ( ! $params instanceof stdClass ) {
			return false;
		}
		$vars = get_object_vars( $params );
		if ( array() !== array_diff_key( $vars, array( 'limit' => 1 ) ) ) {
			return false;
		}
		if ( isset( $vars['limit'] ) && ! self::is_int_in( $vars['limit'], 1, IWSL_SEO_Audit::MAX_ITEMS ) ) {
			return false;
		}
		return true;
	}

	/** `seo.alt.backfill`: optional `limit` 1..200 + optional bool `dry_run`, no stray keys. */
	public static function validate_backfill_params( $params ): bool {
		if ( ! $params instanceof stdClass ) {
			return false;
		}
		$vars = get_object_vars( $params );
		if ( array() !== array_diff_key( $vars, array( 'limit' => 1, 'dry_run' => 1 ) ) ) {
			return false;
		}
		if ( isset( $vars['limit'] ) && ! self::is_int_in( $vars['limit'], 1, self::MAX_BATCH ) ) {
			return false;
		}
		if ( isset( $vars['dry_run'] ) && ! is_bool( $vars['dry_run'] ) ) {
			return false;
		}
		return true;
	}

	/** `seo.fix.apply`: EXACTLY { post_id:int>0, field:enum, value:string≤400 } — strict. */
	public static function validate_fix_params( $params ): bool {
		if ( ! $params instanceof stdClass ) {
			return false;
		}
		$vars = get_object_vars( $params );
		if ( array() !== array_diff_key( $vars, array( 'post_id' => 1, 'field' => 1, 'value' => 1 ) ) ) {
			return false;
		}
		if ( ! isset( $vars['post_id'], $vars['field'], $vars['value'] ) ) {
			return false;
		}
		if ( ! is_int( $vars['post_id'] ) || $vars['post_id'] <= 0 ) {
			return false;
		}
		if ( ! is_string( $vars['field'] ) || ! in_array( $vars['field'], self::FIX_FIELDS, true ) ) {
			return false;
		}
		if ( ! is_string( $vars['value'] ) ) {
			return false;
		}
		$len = function_exists( 'mb_strlen' ) ? mb_strlen( $vars['value'] ) : strlen( $vars['value'] );
		return $len <= self::MAX_FIX_VALUE;
	}

	// ── small pure helpers ────────────────────────────────────────────────────────

	/** Strict integer-in-range check (rejects floats/strings/booleans). */
	private static function is_int_in( $value, int $min, int $max ): bool {
		return is_int( $value ) && $value >= $min && $value <= $max;
	}

	/** Read a clamped int param, or the default when absent/ill-typed. */
	private static function param_int( $params, string $key, int $default, int $min, int $max ): int {
		if ( $params instanceof stdClass ) {
			$vars = get_object_vars( $params );
			if ( isset( $vars[ $key ] ) && is_int( $vars[ $key ] ) ) {
				return max( $min, min( $max, $vars[ $key ] ) );
			}
		}
		return $default;
	}

	/** Read a bool param, or the default when absent/ill-typed. */
	private static function param_bool( $params, string $key, bool $default ): bool {
		if ( $params instanceof stdClass ) {
			$vars = get_object_vars( $params );
			if ( isset( $vars[ $key ] ) && is_bool( $vars[ $key ] ) ) {
				return $vars[ $key ];
			}
		}
		return $default;
	}

	/** Coerce a fix `value` string into a boolean for the noindex toggle. */
	private static function truthy( string $value ): bool {
		$v = strtolower( trim( $value ) );
		return '' !== $v && '0' !== $v && 'false' !== $v && 'off' !== $v && 'no' !== $v;
	}

	// ── engine composition (memoized) ─────────────────────────────────────────────

	/** A fresh IWSL_SEO_Audit over the same gate + store (durable last-audit lives there). */
	private function audit(): IWSL_SEO_Audit {
		return new IWSL_SEO_Audit( $this->entitlements, $this->store );
	}

	/** Memoized IWSL_SEO_Suite — used only for its pure sanitizer + settings reads. */
	private function suite(): IWSL_SEO_Suite {
		if ( null === $this->suite ) {
			$this->suite = new IWSL_SEO_Suite( $this->entitlements, $this->store );
		}
		return $this->suite;
	}

	// ── guarded WordPress gathers (degrade to 0/null off-WP) ──────────────────────

	/** A usable $wpdb handle with the methods/props the counts need, or null. */
	private function wpdb() {
		$wpdb = isset( $GLOBALS['wpdb'] ) ? $GLOBALS['wpdb'] : null;
		if ( is_object( $wpdb )
			&& method_exists( $wpdb, 'prepare' ) && method_exists( $wpdb, 'get_var' )
			&& method_exists( $wpdb, 'esc_like' )
			&& isset( $wpdb->postmeta ) && isset( $wpdb->posts ) ) {
			return $wpdb;
		}
		return null;
	}

	/** Bounded COUNT of posts carrying a non-empty value for a meta key. */
	private function count_nonempty_meta( string $key ): int {
		$wpdb = $this->wpdb();
		if ( null === $wpdb ) {
			return 0;
		}
		return (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key = %s AND meta_value <> ''", $key ) );
	}

	/** Bounded COUNT of posts whose meta key equals an exact value. */
	private function count_meta_value( string $key, string $value ): int {
		$wpdb = $this->wpdb();
		if ( null === $wpdb ) {
			return 0;
		}
		return (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key = %s AND meta_value = %s", $key, $value ) );
	}

	/** Bounded COUNT of published posts/pages (the audit corpus size). */
	private function count_published(): int {
		$wpdb = $this->wpdb();
		if ( null === $wpdb ) {
			return 0;
		}
		return (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_status = 'publish' AND post_type IN ('post','page')" );
	}

	/** Alt coverage: total image attachments and how many still lack alt text. */
	private function gather_alt(): array {
		$wpdb = $this->wpdb();
		if ( null === $wpdb ) {
			return array( 'images' => 0, 'missing' => 0 );
		}
		$like   = $wpdb->esc_like( 'image/' ) . '%';
		$images = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = 'attachment' AND post_mime_type LIKE %s", $like ) );
		$with   = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->posts} p INNER JOIN {$wpdb->postmeta} m ON m.post_id = p.ID AND m.meta_key = %s WHERE p.post_type = 'attachment' AND p.post_mime_type LIKE %s AND m.meta_value <> ''",
				self::ALT_META_KEY,
				$like
			)
		);
		return array( 'images' => $images, 'missing' => max( 0, $images - $with ) );
	}

	/** Just the count of image attachments still missing alt (for backfill `remaining`). */
	private function count_missing_alt(): int {
		$alt = $this->gather_alt();
		return (int) $alt['missing'];
	}

	/** Suite per-post `_iwseo_score` average + a good/ok/poor/none histogram. */
	private function gather_suite_score(): ?array {
		$wpdb = $this->wpdb();
		if ( null === $wpdb ) {
			return null;
		}
		$key   = IWSL_SEO_Suite::META_SCORE;
		$numer = "meta_key = %s AND meta_value REGEXP '^[0-9]+$'";
		$avg   = $wpdb->get_var( $wpdb->prepare( "SELECT ROUND(AVG(CAST(meta_value AS UNSIGNED))) FROM {$wpdb->postmeta} WHERE {$numer}", $key ) );
		$good  = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE {$numer} AND CAST(meta_value AS UNSIGNED) >= 70", $key ) );
		$ok    = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE {$numer} AND CAST(meta_value AS UNSIGNED) BETWEEN 40 AND 69", $key ) );
		$poor  = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE {$numer} AND CAST(meta_value AS UNSIGNED) < 40", $key ) );
		$none  = max( 0, $this->count_published() - $good - $ok - $poor );
		return array(
			'avg'       => null === $avg ? null : (int) $avg,
			'histogram' => array( 'good' => $good, 'ok' => $ok, 'poor' => $poor, 'none' => $none ),
		);
	}

	/** Sitemap glance from the suite settings: active + the index URL when live. */
	private function gather_sitemap(): array {
		$active = ! empty( $this->suite()->settings()['sitemap_enabled'] );
		$url    = null;
		if ( $active && function_exists( 'home_url' ) ) {
			$url = rtrim( (string) home_url(), '/' ) . '/sitemap_index.xml';
		}
		return array( 'active' => $active, 'url' => $url );
	}

	/** Focus-keyphrase coverage: pages WITH a keyphrase vs published without one. */
	private function gather_keywords(): array {
		$set       = $this->count_nonempty_meta( IWSL_SEO_Suite::META_FOCUSKW );
		$published = $this->count_published();
		return array(
			'set'        => $set,
			'missing'    => max( 0, $published - $set ),
			// Cannibalization (same keyphrase on two pages) needs a value fetch, not a
			// COUNT — deferred to the audit corpus pass (B6) to keep status bounded.
			'duplicates' => 0,
		);
	}

	/** Structured-data glance: site rep configured + how many posts carry a page type. */
	private function gather_schema(): array {
		$org  = $this->suite()->settings()['org'] ?? array();
		$name = is_array( $org ) && isset( $org['name'] ) ? (string) $org['name'] : '';
		return array(
			'site_representation' => '' !== trim( $name ),
			'typed_posts'         => $this->count_nonempty_meta( IWSL_SEO_Suite::META_PAGE_TYPE ),
			'published'           => $this->count_published(),
		);
	}

	/** Third-party SEO plugins active alongside the suite (two-engine conflict, A6). */
	private function detect_conflicts(): array {
		if ( ! function_exists( 'get_option' ) ) {
			return array();
		}
		$active = get_option( 'active_plugins', array() );
		if ( ! is_array( $active ) ) {
			return array();
		}
		$known = array(
			'wordpress-seo/wp-seo.php',
			'seo-by-rank-math/rank-math.php',
			'all-in-one-seo-pack/all_in_one_seo_pack.php',
		);
		$found = array();
		foreach ( $known as $file ) {
			if ( in_array( $file, $active, true ) ) {
				$found[] = $file;
			}
		}
		return $found;
	}

	/** Attachment records missing alt, bounded to $limit, for the backfill planner. */
	private function gather_missing_alt_attachments( int $limit ): array {
		$wpdb = $this->wpdb();
		if ( null === $wpdb || ! method_exists( $wpdb, 'get_col' ) || ! function_exists( 'get_post' ) ) {
			return array();
		}
		$limit = max( 1, min( self::MAX_BATCH, $limit ) );
		$like  = $wpdb->esc_like( 'image/' ) . '%';
		$ids   = $wpdb->get_col(
			$wpdb->prepare(
				"SELECT p.ID FROM {$wpdb->posts} p LEFT JOIN {$wpdb->postmeta} m ON m.post_id = p.ID AND m.meta_key = %s WHERE p.post_type = 'attachment' AND p.post_mime_type LIKE %s AND ( m.meta_id IS NULL OR m.meta_value = '' OR m.meta_value IS NULL ) ORDER BY p.ID DESC LIMIT %d",
				self::ALT_META_KEY,
				$like,
				$limit
			)
		);
		if ( ! is_array( $ids ) ) {
			return array();
		}
		$out = array();
		foreach ( $ids as $raw_id ) {
			$out[] = $this->attachment_record( (int) $raw_id );
		}
		return $out;
	}

	/** Build the { id, current_alt, title, filename, parent_title } record for one attachment. */
	private function attachment_record( int $id ): array {
		$current_alt  = function_exists( 'get_post_meta' ) ? (string) get_post_meta( $id, self::ALT_META_KEY, true ) : '';
		$title        = '';
		$parent_title = '';
		$filename     = '';
		$post         = function_exists( 'get_post' ) ? get_post( $id ) : null;
		if ( is_object( $post ) ) {
			$title  = isset( $post->post_title ) ? (string) $post->post_title : '';
			$parent = isset( $post->post_parent ) ? (int) $post->post_parent : 0;
			if ( $parent > 0 && function_exists( 'get_the_title' ) ) {
				$parent_title = (string) get_the_title( $parent );
			}
		}
		if ( function_exists( 'get_attached_file' ) ) {
			$file = get_attached_file( $id );
			if ( is_string( $file ) && '' !== $file ) {
				$filename = basename( $file );
			}
		}
		return array(
			'id'           => $id,
			'current_alt'  => $current_alt,
			'title'        => $title,
			'filename'     => $filename,
			'parent_title' => $parent_title,
		);
	}
}
