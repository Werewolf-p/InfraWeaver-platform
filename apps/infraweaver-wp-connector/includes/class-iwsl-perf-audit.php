<?php
/**
 * FREE "Load-Time Audit" feature — a read-only, first-party page-speed diagnostic.
 *
 * WHAT IT MEASURES (and, honestly, what it does NOT). Every front-end page view by
 * a non-admin visitor is timed with WordPress's OWN request timer — the exact
 * `microtime(true) - $GLOBALS['timestart']` that core's admin-footer "N queries in
 * X seconds" line reports. That number is the SERVER GENERATION TIME: how long PHP
 * took to build the HTML, from the very start of the WordPress bootstrap to
 * `shutdown`. It is the server portion of Time To First Byte. It deliberately does
 * NOT include DNS, TLS, network transfer, browser parsing, CSS/JS execution, or
 * image loading — those happen in the visitor's browser and cannot be observed
 * in-process without a synthetic external fetch (which this plugin's trust model
 * forbids: no exec, no outbound HTTP, no SSRF surface). Labelling it "server
 * response time" rather than "page load time" is the honest framing; the admin UI
 * says exactly this so the number is never over-claimed.
 *
 * WHY THIS IS ACCURATE. It is not an estimate or a synthetic probe: it is the real
 * wall-clock generation time of real visitor requests, sampled passively, using the
 * same clock WordPress itself trusts. Alongside it we record `get_num_queries()`
 * (the authoritative `$wpdb->num_queries` counter) and `memory_get_peak_usage(true)`
 * — both exact, both free. Aggregation (per-URL average / max, site average) is a
 * pure fold, unit-tested with no WordPress present.
 *
 * FREE TIER. There is NO entitlement gate here — this is available to every site,
 * on any plan, and takes no IWSL_Entitlements dependency (mirrors the wp-config
 * editor, the other ungated admin surface). It is therefore NOT a switchable tier
 * feature and never appears in IWSL_Feature_Switches; instead it carries its own
 * local, admin-flippable on/off (`enabled`, default on) so the tiny per-request
 * option write can be stopped at will. Purging `iwsl_*` on unlink drops the samples
 * and resets to the default (on), which is correct.
 *
 * SAFETY. In-process only — no exec/shell_exec/proc_open, no network, no writes to
 * anything but this one non-autoloaded option. The collector runs ONLY for real
 * front-end HTML GET views (admin / AJAX / cron / REST / feed / robots / 404 and
 * logged-in administrators are all excluded, the last because the admin bar skews
 * the very number we measure). The per-URL map is hard-capped at MAX_PATHS so a
 * spider hitting unique query-less URLs cannot grow it without bound.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Perf_Audit {

	/** IWSL_Store key holding the whole audit state (enabled + samples). */
	const OPTION = 'perf_audit';

	/** admin-post actions + matching nonce actions. */
	const RESET_ACTION  = 'iwsl_perf_audit_reset';
	const RESET_NONCE   = 'iwsl_perf_audit_reset';
	const TOGGLE_ACTION = 'iwsl_perf_audit_toggle';
	const TOGGLE_NONCE  = 'iwsl_perf_audit_toggle';

	/** Hard cap on distinct URLs tracked — bounds the stored map. */
	const MAX_PATHS = 100;

	/** Longest stored path (characters) — bounds a single key. */
	const PATH_MAX_LEN = 300;

	/** Server-generation-time thresholds (milliseconds). */
	const SLOW_MS      = 800;   // avg above this → slow-server-generation
	const VERY_SLOW_MS = 2000;  // avg above this → the "very slow" severity note

	/** Above this many DB queries per request → high-query-count. */
	const QUERY_MAX = 80;

	/** How many slowest URLs the report table shows. */
	const REPORT_ROWS = 25;

	/** @var IWSL_Store */
	private $store;

	/** @var callable():int current unix ms (injectable for tests). */
	private $now_ms;

	/**
	 * @param IWSL_Store    $store  Persistence (the site's own options). No
	 *                              entitlement gate — this is a free feature.
	 * @param callable|null $now_ms Optional clock override (unix ms).
	 */
	public function __construct( IWSL_Store $store, ?callable $now_ms = null ) {
		$this->store  = $store;
		$this->now_ms = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
	}

	/** Wire the passive front-end collector. Guarded so the harness can call it harmlessly. */
	public function register(): void {
		if ( function_exists( 'add_action' ) ) {
			// PHP_INT_MAX priority: run as late as possible so the timer captures
			// essentially the whole request. `shutdown` fires after the response.
			add_action( 'shutdown', array( $this, 'on_shutdown' ), PHP_INT_MAX );
		}
	}

	// ── collector (front-end, passive, self-excluding) ─────────────────────────

	/**
	 * `shutdown` handler. Records ONE real server-generation sample for a qualifying
	 * front-end view. Every disqualifying condition returns early and writes nothing.
	 */
	public function on_shutdown(): void {
		if ( ! $this->is_enabled() ) {
			return;
		}
		if ( ! self::is_measurable_request() ) {
			return;
		}
		$timestart = isset( $GLOBALS['timestart'] ) ? (float) $GLOBALS['timestart'] : 0.0;
		if ( $timestart <= 0.0 ) {
			return; // no trustworthy start stamp → refuse to invent a number.
		}
		$gen_ms  = ( microtime( true ) - $timestart ) * 1000.0;
		$queries = function_exists( 'get_num_queries' ) ? (int) get_num_queries() : 0;
		$peak    = function_exists( 'memory_get_peak_usage' ) ? (int) memory_get_peak_usage( true ) : 0;
		$path    = self::normalize_path( isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '/' );

		$state = $this->state();
		$next  = self::fold_sample( $state, $path, $gen_ms, $queries, $peak, ( $this->now_ms )(), self::MAX_PATHS );
		$this->store->set( self::OPTION, $next );
	}

	/**
	 * Is this request one we may measure? Front-end HTML GET, real visitor. Excludes
	 * admin, AJAX, cron, REST, feed, robots, trackback, 404, and logged-in admins
	 * (whose admin bar inflates generation time). All checks are function_exists- or
	 * constant-guarded so the predicate is safe outside WordPress (returns false).
	 */
	private static function is_measurable_request(): bool {
		$method = isset( $_SERVER['REQUEST_METHOD'] ) ? strtoupper( (string) $_SERVER['REQUEST_METHOD'] ) : 'GET';
		if ( 'GET' !== $method ) {
			return false;
		}
		if ( function_exists( 'is_admin' ) && is_admin() ) {
			return false;
		}
		if ( function_exists( 'wp_doing_ajax' ) ? wp_doing_ajax() : ( defined( 'DOING_AJAX' ) && DOING_AJAX ) ) {
			return false;
		}
		if ( defined( 'DOING_CRON' ) && DOING_CRON ) {
			return false;
		}
		if ( defined( 'REST_REQUEST' ) && REST_REQUEST ) {
			return false;
		}
		// The main query must have resolved for the conditional tags below to be
		// meaningful. `wp` firing also means this was a real page render, not a
		// request that redirected or exited early — those aren't page views.
		if ( function_exists( 'did_action' ) && ! did_action( 'wp' ) ) {
			return false;
		}
		if ( function_exists( 'is_feed' ) && is_feed() ) {
			return false;
		}
		if ( function_exists( 'is_robots' ) && is_robots() ) {
			return false;
		}
		if ( function_exists( 'is_trackback' ) && is_trackback() ) {
			return false;
		}
		if ( function_exists( 'is_404' ) && is_404() ) {
			return false;
		}
		// Admins carry the admin bar + extra queries — measuring them would report a
		// slower page than a real visitor ever sees. Exclude them (mirrors Statistics).
		if ( function_exists( 'current_user_can' ) && current_user_can( 'manage_options' ) ) {
			return false;
		}
		return true;
	}

	/**
	 * Normalize a request URI to the stored key: strip the query string and fragment,
	 * collapse to a leading-slash path, cap the length. Query-less so `/shop?p=2` and
	 * `/shop?p=9` fold into one `/shop` row rather than exploding the map.
	 */
	public static function normalize_path( string $uri ): string {
		$uri = trim( $uri );
		$q   = strpos( $uri, '?' );
		if ( false !== $q ) {
			$uri = substr( $uri, 0, $q );
		}
		$h = strpos( $uri, '#' );
		if ( false !== $h ) {
			$uri = substr( $uri, 0, $h );
		}
		if ( '' === $uri || '/' !== $uri[0] ) {
			$uri = '/' . $uri;
		}
		if ( function_exists( 'mb_substr' ) ) {
			$uri = mb_substr( $uri, 0, self::PATH_MAX_LEN );
		} else {
			$uri = substr( $uri, 0, self::PATH_MAX_LEN );
		}
		return $uri;
	}

	// ── pure aggregation core (no WordPress, no I/O — unit-tested) ──────────────

	/**
	 * Fold ONE sample into the audit state, returning a NEW state (never mutating
	 * the input). A new URL is added only while the map is below MAX_PATHS; past the
	 * cap, samples for already-known URLs still update, and a dropped new URL bumps
	 * `overflow` so the UI can say the tracked set is capped.
	 *
	 * @param array  $state    Prior state (enabled/since/samples/overflow).
	 * @param string $path     Normalized URL key.
	 * @param float  $gen_ms   Server generation time for this request (ms).
	 * @param int    $queries  DB queries for this request.
	 * @param int    $peak_mem Peak memory for this request (bytes).
	 * @param int    $now_ms   Wall clock (unix ms) for since/last stamps.
	 * @param int    $max      URL cap.
	 * @return array New state.
	 */
	public static function fold_sample( array $state, string $path, float $gen_ms, int $queries, int $peak_mem, int $now_ms, int $max = self::MAX_PATHS ): array {
		$gen_ms  = max( 0.0, $gen_ms );
		$queries = max( 0, $queries );
		$peak    = max( 0, $peak_mem );

		$next             = self::normalize_state( $state );
		$next['enabled']  = $next['enabled']; // preserved by normalize.
		if ( 0 === (int) $next['since'] ) {
			$next['since'] = $now_ms;
		}

		$samples = $next['samples'];
		if ( ! array_key_exists( $path, $samples ) ) {
			if ( count( $samples ) >= max( 1, $max ) ) {
				$next['overflow'] = (int) $next['overflow'] + 1;
				return $next; // map full → count the miss, add nothing.
			}
			$samples[ $path ] = array(
				'count'   => 0,
				'sum_ms'  => 0.0,
				'max_ms'  => 0.0,
				'last_ms' => 0.0,
				'last_at' => 0,
				'sum_q'   => 0,
				'max_q'   => 0,
				'max_mem' => 0,
			);
		}

		$agg              = $samples[ $path ];
		$agg['count']     = (int) $agg['count'] + 1;
		$agg['sum_ms']    = (float) $agg['sum_ms'] + $gen_ms;
		$agg['max_ms']    = max( (float) $agg['max_ms'], $gen_ms );
		$agg['last_ms']   = $gen_ms;
		$agg['last_at']   = $now_ms;
		$agg['sum_q']     = (int) $agg['sum_q'] + $queries;
		$agg['max_q']     = max( (int) $agg['max_q'], $queries );
		$agg['max_mem']   = max( (int) $agg['max_mem'], $peak );
		$samples[ $path ] = $agg;

		$next['samples'] = $samples;
		return $next;
	}

	/**
	 * The pure per-URL judgement over one aggregate row. Returns issue codes. No
	 * WordPress, no I/O — the testable brain of the report.
	 *
	 * @param array $agg { count:int, sum_ms:float, max_q:int, ... }
	 * @return string[]
	 */
	public static function evaluate_path( array $agg ): array {
		$count = isset( $agg['count'] ) ? (int) $agg['count'] : 0;
		$issues = array();
		if ( $count <= 0 ) {
			return $issues;
		}
		$avg_ms = (float) $agg['sum_ms'] / $count;
		if ( $avg_ms > self::VERY_SLOW_MS ) {
			$issues[] = 'very-slow-server-generation';
		} elseif ( $avg_ms > self::SLOW_MS ) {
			$issues[] = 'slow-server-generation';
		}
		if ( (int) ( $agg['max_q'] ?? 0 ) > self::QUERY_MAX ) {
			$issues[] = 'high-query-count';
		}
		return $issues;
	}

	/**
	 * Build the immutable report from the stored state: site-wide roll-up plus the
	 * slowest URLs (by average generation time) capped at $rows. Pure over the state.
	 *
	 * @param array $state Prior state.
	 * @param int   $rows  Table cap.
	 * @return array Report summary.
	 */
	public static function build_report( array $state, int $rows = self::REPORT_ROWS ): array {
		$rows    = max( 1, min( self::MAX_PATHS, $rows ) );
		$norm    = self::normalize_state( $state );
		$samples = $norm['samples'];

		$total_samples = 0;
		$total_ms      = 0.0;
		$slow_paths    = 0;
		$items         = array();
		foreach ( $samples as $path => $agg ) {
			$count = (int) $agg['count'];
			if ( $count <= 0 ) {
				continue;
			}
			$avg           = (float) $agg['sum_ms'] / $count;
			$total_samples += $count;
			$total_ms      += (float) $agg['sum_ms'];
			$issues        = self::evaluate_path( $agg );
			if ( array() !== $issues ) {
				$slow_paths++;
			}
			$items[] = array(
				'path'    => (string) $path,
				'count'   => $count,
				'avg_ms'  => (int) round( $avg ),
				'max_ms'  => (int) round( (float) $agg['max_ms'] ),
				'last_ms' => (int) round( (float) $agg['last_ms'] ),
				'avg_q'   => (int) round( (float) $agg['sum_q'] / $count ),
				'max_q'   => (int) $agg['max_q'],
				'max_mem' => (int) $agg['max_mem'],
				'issues'  => $issues,
				'_avg'    => $avg, // private sort key, stripped below.
			);
		}

		// Slowest first (average generation time desc), then cap.
		usort(
			$items,
			static function ( array $a, array $b ): int {
				return $b['_avg'] <=> $a['_avg'];
			}
		);
		$worst_path    = isset( $items[0] ) ? $items[0]['path'] : '';
		$worst_avg_ms  = isset( $items[0] ) ? $items[0]['avg_ms'] : 0;
		$paths_tracked = count( $items );
		$items         = array_slice( $items, 0, $rows );
		foreach ( $items as $i => $row ) {
			unset( $items[ $i ]['_avg'] );
		}

		return array(
			'ok'            => true,
			'enabled'       => (bool) $norm['enabled'],
			'since'         => (int) $norm['since'],
			'total_samples' => $total_samples,
			'paths_tracked' => $paths_tracked,
			'overflow'      => (int) $norm['overflow'],
			'capped'        => $paths_tracked >= self::MAX_PATHS || (int) $norm['overflow'] > 0,
			'avg_ms'        => $total_samples > 0 ? (int) round( $total_ms / $total_samples ) : 0,
			'slow_paths'    => $slow_paths,
			'worst_path'    => $worst_path,
			'worst_avg_ms'  => $worst_avg_ms,
			'items'         => array_values( $items ),
			'max_paths'     => self::MAX_PATHS,
			'thresholds'    => array(
				'slow_ms'      => self::SLOW_MS,
				'very_slow_ms' => self::VERY_SLOW_MS,
				'query_max'    => self::QUERY_MAX,
			),
		);
	}

	/** Human labels for the issue codes (render only). @return array<string,string> */
	public static function labels(): array {
		return array(
			'slow-server-generation'      => 'Slow server response (avg > ' . self::SLOW_MS . ' ms)',
			'very-slow-server-generation' => 'Very slow server response (avg > ' . self::VERY_SLOW_MS . ' ms)',
			'high-query-count'            => 'High database query count (> ' . self::QUERY_MAX . ' per load)',
		);
	}

	// ── state helpers ──────────────────────────────────────────────────────────

	/** Coerce any stored blob into the canonical state shape. Pure, defensive. */
	public static function normalize_state( $raw ): array {
		$state = is_array( $raw ) ? $raw : array();
		$out   = array(
			'enabled'  => array_key_exists( 'enabled', $state ) ? (bool) $state['enabled'] : true,
			'since'    => isset( $state['since'] ) ? (int) $state['since'] : 0,
			'overflow' => isset( $state['overflow'] ) ? (int) $state['overflow'] : 0,
			'samples'  => array(),
		);
		$samples = isset( $state['samples'] ) && is_array( $state['samples'] ) ? $state['samples'] : array();
		foreach ( $samples as $path => $agg ) {
			if ( ! is_string( $path ) || ! is_array( $agg ) ) {
				continue;
			}
			$out['samples'][ $path ] = array(
				'count'   => isset( $agg['count'] ) ? (int) $agg['count'] : 0,
				'sum_ms'  => isset( $agg['sum_ms'] ) ? (float) $agg['sum_ms'] : 0.0,
				'max_ms'  => isset( $agg['max_ms'] ) ? (float) $agg['max_ms'] : 0.0,
				'last_ms' => isset( $agg['last_ms'] ) ? (float) $agg['last_ms'] : 0.0,
				'last_at' => isset( $agg['last_at'] ) ? (int) $agg['last_at'] : 0,
				'sum_q'   => isset( $agg['sum_q'] ) ? (int) $agg['sum_q'] : 0,
				'max_q'   => isset( $agg['max_q'] ) ? (int) $agg['max_q'] : 0,
				'max_mem' => isset( $agg['max_mem'] ) ? (int) $agg['max_mem'] : 0,
			);
		}
		return $out;
	}

	/** The current audit state from the store, normalized. */
	private function state(): array {
		return self::normalize_state( $this->store->get( self::OPTION, array() ) );
	}

	/** Is passive collection switched on? Default true (missing key = on). */
	public function is_enabled(): bool {
		return (bool) $this->state()['enabled'];
	}

	/** Flip collection on/off, preserving samples. Returns the new state. */
	public function set_enabled( bool $on ): array {
		$state            = $this->state();
		$state['enabled'] = $on;
		$this->store->set( self::OPTION, $state );
		return $state;
	}

	/** Clear all samples, keeping the enabled flag. Returns the reset state. */
	public function reset_samples(): array {
		$state = array(
			'enabled'  => $this->is_enabled(),
			'since'    => 0,
			'overflow' => 0,
			'samples'  => array(),
		);
		$this->store->set( self::OPTION, $state );
		return $state;
	}

	/**
	 * Teardown for an uninstall/unlink sweep: delete the whole audit state option
	 * key — samples, since, overflow, AND the enabled flag — entirely. Unlike
	 * reset_samples() (which preserves the enabled flag for an in-place clear),
	 * purge() removes the option so nothing of this FREE feature's footprint
	 * survives; a fresh read afterwards falls back to normalize_state()'s defaults
	 * (enabled ON). Idempotent + cheap: deleting an absent key is a single no-op
	 * store call.
	 *
	 * @return array{ ok:bool, deleted:bool }
	 */
	public function purge(): array {
		$had = null !== $this->store->get( self::OPTION, null );
		$this->store->delete( self::OPTION );
		return array( 'ok' => true, 'deleted' => $had );
	}

	// ── admin-post handlers (capability + nonce) ───────────────────────────────

	/** Toggle collection. cap + nonce, then PRG back to the Plus page. */
	public function handle_toggle(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::TOGGLE_NONCE );
		$on = ! $this->is_enabled();
		$this->set_enabled( $on );
		wp_safe_redirect( add_query_arg( 'iwsl_perf_toggled', $on ? '1' : '0', iwsl_plus_redirect_base() ) );
		exit;
	}

	/** Reset samples. cap + nonce, then PRG back to the Plus page. */
	public function handle_reset(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::RESET_NONCE );
		$this->reset_samples();
		wp_safe_redirect( add_query_arg( 'iwsl_perf_reset', '1', iwsl_plus_redirect_base() ) );
		exit;
	}

	// ── admin render (presentation only) ───────────────────────────────────────

	/** Render the Load-Time Audit section: status, controls, and the slowest-URL table. */
	public function render_section(): void {
		$report = self::build_report( $this->state() );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( 'Load-Time Audit', 'infraweaver-connector' ) . '</h2>';
		echo '<p>' . esc_html__( 'Measures how long your server takes to build each page for real visitors, using WordPress\'s own request timer — the same one behind the “queries in X seconds” note. This is the server response time (the server part of load time); it does not include your visitors\' network or browser. Read-only: nothing is ever changed.', 'infraweaver-connector' ) . '</p>';

		if ( isset( $_GET['iwsl_perf_reset'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-success inline" style="margin-top:12px;padding:10px;"><p>' . esc_html__( 'Samples cleared. New page views will start a fresh measurement.', 'infraweaver-connector' ) . '</p></div>';
		}
		if ( isset( $_GET['iwsl_perf_toggled'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			$now_on = '1' === (string) $_GET['iwsl_perf_toggled']; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-info inline" style="margin-top:12px;padding:10px;"><p>'
				. esc_html( $now_on ? __( 'Measurement turned on.', 'infraweaver-connector' ) : __( 'Measurement turned off. Existing samples are kept.', 'infraweaver-connector' ) )
				. '</p></div>';
		}

		$enabled = (bool) $report['enabled'];
		$meta    = $enabled
			? sprintf(
				/* translators: 1: sample count, 2: URL count. */
				__( 'Measuring. %1$d page views recorded across %2$d URLs.', 'infraweaver-connector' ),
				(int) $report['total_samples'],
				(int) $report['paths_tracked']
			)
			: __( 'Measurement is off. Turn it on to start recording server response times.', 'infraweaver-connector' );

		echo '<div class="iwsl-primary">';
		echo '<span class="iwsl-primary__meta">' . esc_html( $meta ) . '</span>';
		$this->render_controls( $enabled );
		echo '</div>';

		echo '<details class="iwsl-adv"><summary>' . esc_html__( 'Advanced settings', 'infraweaver-connector' ) . '</summary><div class="iwsl-adv__body">';
		echo '<p class="description">' . esc_html__( 'Scope and thresholds are fixed and read-only:', 'infraweaver-connector' ) . '</p>';
		echo '<ul style="list-style:disc;margin:0 0 0 18px;">';
		echo '<li>' . esc_html__( 'Only real front-end page views by logged-out visitors are timed (admin, AJAX, cron, REST, feeds and 404s are ignored).', 'infraweaver-connector' ) . '</li>';
		echo '<li>' . esc_html( sprintf( 'A page is flagged slow above %d ms average server response, very slow above %d ms.', self::SLOW_MS, self::VERY_SLOW_MS ) ) . '</li>';
		echo '<li>' . esc_html( sprintf( 'Database queries above %d per load are flagged.', self::QUERY_MAX ) ) . '</li>';
		echo '<li>' . esc_html( sprintf( 'Up to %d distinct URLs are tracked; the slowest %d are shown.', self::MAX_PATHS, self::REPORT_ROWS ) ) . '</li>';
		echo '</ul>';
		echo '</div></details>';

		$this->render_report_table( $report );
	}

	/** The two nonce-protected control buttons: toggle measurement + reset samples. */
	private function render_controls( bool $enabled ): void {
		echo '<span class="iwsl-primary__actions" style="display:inline-flex;gap:8px;margin-top:8px;">';

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin:0;">';
		wp_nonce_field( self::TOGGLE_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::TOGGLE_ACTION ) . '">';
		echo '<button type="submit" class="button button-primary">'
			. esc_html( $enabled ? __( 'Turn measurement off', 'infraweaver-connector' ) : __( 'Turn measurement on', 'infraweaver-connector' ) )
			. '</button>' . iwsl_field_help( 'Start or stop timing real visitor page views. Turning it off keeps the numbers already collected.' );
		echo '</form>';

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin:0;">';
		wp_nonce_field( self::RESET_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::RESET_ACTION ) . '">';
		echo '<button type="submit" class="button">' . esc_html__( 'Reset samples', 'infraweaver-connector' ) . '</button>'
			. iwsl_field_help( 'Throw away all collected timings and start fresh — useful after you make a speed change.' );
		echo '</form>';

		echo '</span>';
	}

	/** Render the slowest-URL table from the report. Read-only; escapes everything. */
	private function render_report_table( array $report ): void {
		$items = isset( $report['items'] ) && is_array( $report['items'] ) ? $report['items'] : array();

		if ( array() === $items ) {
			echo '<p style="margin-top:12px;">' . esc_html__( 'No measurements yet. Open your site in a logged-out browser (or wait for visitors) and the slowest pages will appear here.', 'infraweaver-connector' ) . '</p>';
			return;
		}

		echo '<p style="margin-top:12px;" class="description">'
			. esc_html(
				sprintf(
					/* translators: 1: site average ms, 2: sample count, 3: slow-page count. */
					__( 'Site average server response: %1$d ms across %2$d page views. %3$d URL(s) flagged.', 'infraweaver-connector' ),
					(int) $report['avg_ms'],
					(int) $report['total_samples'],
					(int) $report['slow_paths']
				)
			);
		if ( ! empty( $report['capped'] ) ) {
			echo ' ' . esc_html( sprintf( 'Tracking is capped at %d URLs.', (int) $report['max_paths'] ) );
		}
		echo '</p>';

		$labels = self::labels();
		echo '<table class="widefat striped" style="max-width:1000px;margin-top:12px;"><thead><tr>';
		echo '<th>' . esc_html__( 'URL', 'infraweaver-connector' ) . '</th>';
		echo '<th>' . esc_html__( 'Views', 'infraweaver-connector' ) . '</th>';
		echo '<th>' . esc_html__( 'Avg', 'infraweaver-connector' ) . '</th>';
		echo '<th>' . esc_html__( 'Max', 'infraweaver-connector' ) . '</th>';
		echo '<th>' . esc_html__( 'Queries', 'infraweaver-connector' ) . '</th>';
		echo '<th>' . esc_html__( 'Notes', 'infraweaver-connector' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $items as $item ) {
			if ( ! is_array( $item ) ) {
				continue;
			}
			$issues = isset( $item['issues'] ) && is_array( $item['issues'] ) ? $item['issues'] : array();
			echo '<tr>';
			echo '<td><code>' . esc_html( (string) $item['path'] ) . '</code></td>';
			echo '<td>' . esc_html( (string) (int) $item['count'] ) . '</td>';
			echo '<td>' . esc_html( sprintf( '%d ms', (int) $item['avg_ms'] ) ) . '</td>';
			echo '<td>' . esc_html( sprintf( '%d ms', (int) $item['max_ms'] ) ) . '</td>';
			echo '<td>' . esc_html( sprintf( '%d', (int) $item['max_q'] ) ) . '</td>';
			echo '<td>';
			if ( array() === $issues ) {
				echo '<span style="color:#46803a;">' . esc_html__( 'OK', 'infraweaver-connector' ) . '</span>';
			} else {
				echo '<ul style="list-style:disc;margin:0 0 0 18px;">';
				foreach ( $issues as $code ) {
					$text = isset( $labels[ $code ] ) ? $labels[ $code ] : (string) $code;
					echo '<li>' . esc_html( $text ) . '</li>';
				}
				echo '</ul>';
			}
			echo '</td></tr>';
		}
		echo '</tbody></table>';
	}
}
