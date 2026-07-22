<?php
/**
 * Controller for the gated "Broken Link Scanner" feature — the payload behind the
 * `broken_link_scan` entitlement (Pro). Kept separate from the gate
 * (IWSL_Entitlements) and from its result storage so each can be reasoned about —
 * and tested — in isolation, mirroring IWSL_Media_Optimizer and IWSL_Redirects.
 *
 * WHAT IT DOES. On an operator "Scan now", it walks up to MAX_POSTS published
 * posts/pages, extracts every `<a href>` from their content, dedupes the links,
 * and checks each unique link. INTERNAL links (same host) use a cheap existence
 * probe (url_to_postid / get_post_status) and only fall back to an HTTP check when
 * that can't resolve them; EXTERNAL links use wp_remote_head() (GET fallback) with
 * a short timeout. It reports every broken link with its post, URL, and
 * status/error. It is strictly READ-ONLY — it never modifies a post.
 *
 * TRUST MODEL. Console-authoritative: the `broken_link_scan` flag is written ONLY
 * by the dual-signed `entitlements.set` runner (§7). No self-set path, REST route,
 * AJAX endpoint, cron, or nopriv surface — a purely-local admin action plus one
 * admin-post handler. The gate is re-checked at three layers (admin page,
 * admin-post handler, and here in scan() as STATEMENT 1). scan()'s check is
 * authoritative: it survives any future caller that forgets the other two.
 * RESIDUAL RISK: the accepted `plus` threat model, bounded by heartbeat staleness.
 *
 * SAFETY / SSRF. Only http/https links are ever requested; mailto:/tel:/data:/
 * javascript:/#fragment are classified without a network call. Outbound requests
 * flow ONLY through wp_remote_* (which respect WordPress' own HTTP API, DNS and
 * redirect policy) — no raw sockets, no exec, no eval. The work is hard-bounded:
 * at most MAX_POSTS posts, MAX_LINKS total link checks, and a TIME_BUDGET_MS wall
 * clock; exceeding any of these stops the run and reports it as `partial`. The
 * post source and the HTTP fetcher are injected, so the engine runs under the
 * zero-dependency test harness with a fixed clock and no WordPress functions.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Broken_Link_Scan {

	/** The entitlement flag this whole feature gates on. */
	const FEATURE = 'broken_link_scan';

	/** admin-post action + nonce for "Scan now". */
	const ACTION = 'iwsl_bls_scan';
	const NONCE  = 'iwsl_bls_scan';

	/** Per-user PRG result transient prefix (see house rules). Holds the summary. */
	const RESULT_TRANSIENT_PREFIX = 'iwsl_bls_result_';
	/** How long the per-user last-scan transient lives (seconds). */
	const RESULT_TTL = 3600;

	/** Durable store key mirroring the last scan (survives transient expiry). */
	const LAST_SCAN_KEY = 'broken_link_scan_last';

	/** Query flag a locked layer-2 POST redirects back with. */
	const LOCKED_QUERY = 'iwsl_bls_locked';

	/** Hard cap on posts examined in one run. */
	const MAX_POSTS = 100;
	/** Hard cap on total unique links checked in one run (time-budget guard). */
	const MAX_LINKS = 200;
	/** Wall-clock budget for one run; stop and report `partial` past this. */
	const TIME_BUDGET_MS = 20000;
	/** Per-request network timeout (seconds) — short, to stay within the budget. */
	const REMOTE_TIMEOUT_S = 5;
	/** Ceiling on hrefs extracted from a single post (bounds the regex work). */
	const MAX_LINKS_PER_POST = 500;
	/** An external status at/above this is considered broken. */
	const BROKEN_STATUS_FLOOR = 400;
	/** HEAD-unfriendly statuses that trigger a GET retry (in the default fetcher). */
	const HEAD_RETRY_STATUSES = array( 0, 405, 501 );

	/** @var IWSL_Entitlements */
	private $entitlements;

	/** @var IWSL_Store durable last-scan persistence (memory store in the harness). */
	private $store;

	/** @var callable():int current unix ms. */
	private $now_ms;

	/** @var string Lowercased home host, '' outside WordPress. */
	private $home_host;

	/** @var callable():array<int,array{id:int,title:string,content:string}> */
	private $posts_provider;

	/** @var callable(string):array{code:int,error:string} low-level HTTP fetcher. */
	private $fetcher;

	/**
	 * @param IWSL_Entitlements $entitlements   The gate.
	 * @param IWSL_Store|null   $store          Durable last-scan persistence; defaults
	 *                                          to the WP store in prod, memory in the
	 *                                          harness. Injectable in tests.
	 * @param callable|null     $now_ms         Clock, mirrors IWSL_Entitlements. Injectable.
	 * @param string|null       $home_host      Home host override; defaults to a parse
	 *                                          of home_url(). Injectable in tests.
	 * @param callable|null     $posts_provider Returns [{id,title,content}]; defaults to
	 *                                          a WP get_posts()-backed provider. Injectable.
	 * @param callable|null     $fetcher        fn(url):{code,error}; defaults to a
	 *                                          wp_remote_head/get wrapper. Injectable.
	 */
	public function __construct(
		IWSL_Entitlements $entitlements,
		?IWSL_Store $store = null,
		?callable $now_ms = null,
		?string $home_host = null,
		?callable $posts_provider = null,
		?callable $fetcher = null
	) {
		$this->entitlements = $entitlements;
		$this->store        = null !== $store ? $store : self::default_store();
		$this->now_ms       = $now_ms ?? static function (): int {
			return (int) round( microtime( true ) * 1000 );
		};
		$this->home_host      = null !== $home_host ? strtolower( $home_host ) : self::default_home_host();
		$this->posts_provider = null !== $posts_provider ? $posts_provider : self::default_posts_provider();
		$this->fetcher        = null !== $fetcher ? $fetcher : self::default_fetcher();
	}

	/** The WP store under WordPress, else an in-memory fallback (never fatals the harness). */
	private static function default_store(): IWSL_Store {
		if ( function_exists( 'get_option' ) && class_exists( 'IWSL_WP_Store' ) ) {
			return new IWSL_WP_Store();
		}
		return new IWSL_Memory_Store();
	}

	/** Register the admin-post handler. Guarded so the harness can call it harmlessly. */
	public function register(): void {
		if ( function_exists( 'add_action' ) ) {
			add_action( 'admin_post_' . self::ACTION, array( $this, 'handle_scan' ) );
		}
	}

	// ── the scan (STATEMENT 1 is the authoritative gate; read-only) ─────────────

	/**
	 * Run one bounded, read-only scan. STATEMENT 1 is the authoritative entitlement
	 * gate — nothing below it runs for a locked site, so no posts are read and no
	 * network request is made. Returns a fresh immutable summary.
	 *
	 * @return array Immutable summary { ok, scanned_posts, checked_links,
	 *               broken_count, broken[], partial, elapsed_ms, max_posts, max_links }.
	 */
	public function scan(): array {
		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			return array(
				'ok'           => false,
				'reason'       => 'entitlement-locked',
				'gate'         => $gate,
				'broken_count' => 0,
				'broken'       => array(),
			);
		}

		$started = ( $this->now_ms )();
		$summary = array(
			'ok'            => true,
			'scanned_posts' => 0,
			'checked_links' => 0,
			'broken_count'  => 0,
			'broken'        => array(),
			'partial'       => false,
			'elapsed_ms'    => 0,
			'max_posts'     => self::MAX_POSTS,
			'max_links'     => self::MAX_LINKS,
			'generated_at'  => $this->now_seconds(),
		);

		$posts   = $this->posts();
		$checked = array(); // url => true — dedupe across the whole run.

		foreach ( $posts as $post ) {
			if ( $this->over_budget( $started ) ) {
				$summary['partial'] = true;
				break;
			}
			$post_id = isset( $post['id'] ) ? (int) $post['id'] : 0;
			$content = isset( $post['content'] ) && is_string( $post['content'] ) ? $post['content'] : '';
			$title   = isset( $post['title'] ) && is_string( $post['title'] ) ? $post['title'] : '';
			if ( '' === $content ) {
				$summary['scanned_posts']++;
				continue;
			}

			foreach ( $this->extract_hrefs( $content ) as $url ) {
				if ( $summary['checked_links'] >= self::MAX_LINKS ) {
					$summary['partial'] = true;
					break 2;
				}
				if ( $this->over_budget( $started ) ) {
					$summary['partial'] = true;
					break 2;
				}
				if ( ! $this->is_checkable( $url ) ) {
					continue;
				}
				if ( isset( $checked[ $url ] ) ) {
					continue; // Already checked this exact URL earlier in the run.
				}
				$checked[ $url ] = true;

				$result = $this->check_link( $url );
				$summary['checked_links']++;
				if ( ! empty( $result['broken'] ) ) {
					$summary = self::fold_broken( $summary, $post_id, $title, $url, $result['status'] );
				}
			}
			$summary['scanned_posts']++;
		}

		$summary['elapsed_ms'] = max( 0, ( $this->now_ms )() - $started );
		return $summary;
	}

	/** The last stored scan summary (durable store), or null. @return array|null */
	public function last_scan() {
		$value = $this->store->get( self::LAST_SCAN_KEY );
		return is_array( $value ) ? $value : null;
	}

	/**
	 * Delete-time teardown scrub for the Broken Link Scanner. Removes ONLY the
	 * plugin-owned durable last-scan-results option; there is nothing else to clear
	 * (the per-user PRG transient self-expires, and this engine schedules no cron).
	 * Idempotent and cheap when clean — the key is dropped only when present. This
	 * scanner is read-only and never wrote post meta, so no meta is touched.
	 *
	 * @return array{ ok:bool, options:string[], cron:string[] }
	 */
	public function purge(): array {
		$removed = array( 'ok' => true, 'options' => array(), 'cron' => array() );
		if ( null !== $this->store->get( self::LAST_SCAN_KEY, null ) ) {
			$this->store->delete( self::LAST_SCAN_KEY );
			$removed['options'][] = self::LAST_SCAN_KEY;
		}
		return $removed;
	}

	/** Normalized post list from the injected provider, capped at MAX_POSTS. @return array[] */
	private function posts(): array {
		$posts = ( $this->posts_provider )();
		if ( ! is_array( $posts ) ) {
			return array();
		}
		if ( count( $posts ) > self::MAX_POSTS ) {
			$posts = array_slice( $posts, 0, self::MAX_POSTS );
		}
		return $posts;
	}

	// ── link checking ───────────────────────────────────────────────────────────

	/**
	 * Check a single link. Internal links (same host / relative) use a cheap
	 * existence probe first, then a same-host HTTP fallback. External links use the
	 * injected fetcher directly.
	 *
	 * @return array{ broken:bool, status:int|string }
	 */
	private function check_link( string $url ): array {
		return $this->is_internal( $url )
			? $this->check_internal( $url )
			: $this->check_external( $url );
	}

	/**
	 * Internal existence check: url_to_postid → a published post is fine. When that
	 * can't resolve (archives, custom routes, files), fall back to an HTTP check
	 * against our own host (same-origin, SSRF-safe).
	 *
	 * @return array{ broken:bool, status:int|string }
	 */
	private function check_internal( string $url ): array {
		if ( function_exists( 'url_to_postid' ) ) {
			$post_id = (int) url_to_postid( $url );
			if ( $post_id > 0 ) {
				$status = function_exists( 'get_post_status' ) ? get_post_status( $post_id ) : 'publish';
				if ( 'publish' === $status ) {
					return array( 'broken' => false, 'status' => 200 );
				}
				return array( 'broken' => true, 'status' => is_string( $status ) ? $status : 'non-public' );
			}
		}
		return $this->check_external( $url );
	}

	/**
	 * External existence check via the injected fetcher. Only ever called for an
	 * http/https URL. A transport error or a >= 400 status is broken.
	 *
	 * @return array{ broken:bool, status:int|string }
	 */
	private function check_external( string $url ): array {
		$result = ( $this->fetcher )( $url );
		$error  = is_array( $result ) && isset( $result['error'] ) ? (string) $result['error'] : '';
		$code   = is_array( $result ) && isset( $result['code'] ) ? (int) $result['code'] : 0;

		if ( '' !== $error ) {
			return array( 'broken' => true, 'status' => $error );
		}
		if ( $code <= 0 ) {
			return array( 'broken' => false, 'status' => 'unchecked' ); // No verdict — don't false-positive.
		}
		if ( $code >= self::BROKEN_STATUS_FLOOR ) {
			return array( 'broken' => true, 'status' => $code );
		}
		return array( 'broken' => false, 'status' => $code );
	}

	// ── link classification ─────────────────────────────────────────────────────

	/** Whether a URL is worth a check at all: only http/https or a relative path. */
	private function is_checkable( string $url ): bool {
		$u = trim( $url );
		if ( '' === $u ) {
			return false;
		}
		if ( '#' === $u[0] ) {
			return false; // Pure fragment — same page.
		}
		$scheme = $this->scheme_of( $u );
		if ( null !== $scheme ) {
			return 'http' === $scheme || 'https' === $scheme;
		}
		// No scheme: relative or root-relative path → internal, checkable.
		return true;
	}

	/** Whether a checkable URL points at this site (same host, or relative). */
	private function is_internal( string $url ): bool {
		$host = $this->host_of( $url );
		if ( null === $host ) {
			return true; // Relative / root-relative — internal by definition.
		}
		return '' !== $this->home_host && strtolower( $host ) === $this->home_host;
	}

	/**
	 * The lowercased scheme of a URL, or null when it has none. Uses an explicit
	 * RFC-3986 scheme match rather than parse_url(), which mis-parses forms like
	 * `tel:123` (a real link we must classify as a non-http scheme, not a path).
	 */
	private function scheme_of( string $url ): ?string {
		if ( preg_match( '#^([a-zA-Z][a-zA-Z0-9+.\-]*):#', $url, $m ) ) {
			return strtolower( $m[1] );
		}
		return null;
	}

	/** The host of a URL, or null when it has none (relative). */
	private function host_of( string $url ): ?string {
		$parts = $this->parse_url_parts( $url );
		if ( null === $parts || ! isset( $parts['host'] ) || ! is_string( $parts['host'] ) ) {
			return null;
		}
		return $parts['host'];
	}

	/** Parse a URL into parts, wp_parse_url when available, else parse_url. @return array|null */
	private function parse_url_parts( string $url ): ?array {
		$parts = function_exists( 'wp_parse_url' ) ? wp_parse_url( $url ) : parse_url( $url );
		return is_array( $parts ) ? $parts : null;
	}

	// ── content extraction ──────────────────────────────────────────────────────

	/**
	 * Extract unique `<a href>` URLs from post content, decoding HTML entities so
	 * `&amp;` in a stored URL doesn't split it. Bounded to MAX_LINKS_PER_POST.
	 *
	 * @return string[]
	 */
	private function extract_hrefs( string $content ): array {
		if ( ! preg_match_all( '/<a\b[^>]*\bhref\s*=\s*(["\'])(.*?)\1/i', $content, $m ) ) {
			return array();
		}
		$out  = array();
		$seen = array();
		foreach ( $m[2] as $raw ) {
			$url = trim( html_entity_decode( (string) $raw, ENT_QUOTES | ENT_HTML5 ) );
			if ( '' === $url || isset( $seen[ $url ] ) ) {
				continue;
			}
			$seen[ $url ] = true;
			$out[]        = $url;
			if ( count( $out ) >= self::MAX_LINKS_PER_POST ) {
				break;
			}
		}
		return $out;
	}

	// ── default WP-backed providers (all guarded) ───────────────────────────────

	/**
	 * The default post source: up to MAX_POSTS published posts/pages, oldest first,
	 * as [{id,title,content}]. Empty outside WordPress.
	 *
	 * @return callable():array
	 */
	private static function default_posts_provider(): callable {
		return static function (): array {
			if ( ! function_exists( 'get_posts' ) ) {
				return array();
			}
			$ids = get_posts(
				array(
					'post_type'        => array( 'post', 'page' ),
					'post_status'      => 'publish',
					'fields'           => 'ids',
					'posts_per_page'   => self::MAX_POSTS,
					'orderby'          => 'ID',
					'order'            => 'ASC',
					'suppress_filters' => true,
				)
			);
			if ( ! is_array( $ids ) ) {
				return array();
			}
			$out = array();
			foreach ( $ids as $id ) {
				$id      = (int) $id;
				$content = function_exists( 'get_post_field' ) ? get_post_field( 'post_content', $id ) : '';
				$title   = function_exists( 'get_the_title' ) ? get_the_title( $id ) : '';
				$out[]   = array(
					'id'      => $id,
					'title'   => is_string( $title ) ? $title : '',
					'content' => is_string( $content ) ? $content : '',
				);
			}
			return $out;
		};
	}

	/**
	 * The default HTTP fetcher: wp_remote_head with a GET fallback for HEAD-
	 * unfriendly servers, normalized to { code:int, error:string }. Returns
	 * code 0 outside a WP HTTP context so nothing is falsely marked broken.
	 *
	 * @return callable(string):array
	 */
	private static function default_fetcher(): callable {
		return static function ( string $url ): array {
			if ( ! function_exists( 'wp_remote_head' ) ) {
				return array( 'code' => 0, 'error' => '' );
			}
			$args     = array( 'timeout' => self::REMOTE_TIMEOUT_S, 'redirection' => 3, 'sslverify' => true );
			$response = wp_remote_head( $url, $args );
			$norm     = self::normalize_response( $response );
			if ( '' === $norm['error']
				&& in_array( $norm['code'], self::HEAD_RETRY_STATUSES, true )
				&& function_exists( 'wp_remote_get' ) ) {
				$response = wp_remote_get( $url, $args );
				$norm     = self::normalize_response( $response );
			}
			return $norm;
		};
	}

	/**
	 * Normalize a wp_remote_* response into { code:int, error:string }.
	 *
	 * @param mixed $response
	 * @return array{code:int,error:string}
	 */
	private static function normalize_response( $response ): array {
		if ( function_exists( 'is_wp_error' ) && is_wp_error( $response ) ) {
			$msg = '';
			if ( is_object( $response ) && method_exists( $response, 'get_error_message' ) ) {
				$msg = (string) $response->get_error_message();
			}
			return array( 'code' => 0, 'error' => '' !== $msg ? $msg : 'request-failed' );
		}
		$code = function_exists( 'wp_remote_retrieve_response_code' )
			? (int) wp_remote_retrieve_response_code( $response )
			: 0;
		return array( 'code' => $code, 'error' => '' );
	}

	// ── helpers ─────────────────────────────────────────────────────────────────

	/** Whether the wall-clock budget for the run has been exceeded. */
	private function over_budget( int $started ): bool {
		return ( ( $this->now_ms )() - $started ) >= self::TIME_BUDGET_MS;
	}

	private function now_seconds(): int {
		return (int) floor( ( $this->now_ms )() / 1000 );
	}

	/**
	 * Fold one broken link into the running summary, returning a NEW summary
	 * (never mutating the input). The broken list is capped at MAX_LINKS.
	 *
	 * @param int|string $status
	 */
	private static function fold_broken( array $summary, int $post_id, string $title, string $url, $status ): array {
		$next = $summary;
		$next['broken_count']++;
		if ( count( $next['broken'] ) < self::MAX_LINKS ) {
			$next['broken'] = array_merge(
				$next['broken'],
				array(
					array(
						'post_id'    => $post_id,
						'post_title' => $title,
						'url'        => $url,
						'status'     => is_int( $status ) ? $status : (string) $status,
					),
				)
			);
		}
		return $next;
	}

	/** Lowercased home host from home_url(), '' outside WordPress. */
	private static function default_home_host(): string {
		if ( function_exists( 'home_url' ) ) {
			$home = home_url();
			if ( is_string( $home ) && '' !== $home ) {
				$parts = function_exists( 'wp_parse_url' ) ? wp_parse_url( $home ) : parse_url( $home );
				if ( is_array( $parts ) && isset( $parts['host'] ) && is_string( $parts['host'] ) ) {
					return strtolower( $parts['host'] );
				}
			}
		}
		return '';
	}

	// ── admin-post handler (LAYER 2 gate) ───────────────────────────────────────

	/**
	 * admin-post handler: run a scan. manage_options + nonce + gate re-check, then
	 * scan() (LAYER 3 inside), then persist the summary durably + as a per-user PRG
	 * transient, then POST-redirect-GET. Never runs a scan for a locked site.
	 */
	public function handle_scan(): void {
		if ( function_exists( 'current_user_can' ) && ! current_user_can( 'manage_options' ) ) {
			if ( function_exists( 'wp_die' ) ) {
				wp_die( 'You do not have permission to run this action.' );
			}
			return;
		}
		if ( function_exists( 'check_admin_referer' ) ) {
			check_admin_referer( self::NONCE );
		}

		$redirect = iwsl_plus_redirect_base();

		$gate = $this->entitlements->evaluate( self::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			$this->redirect( function_exists( 'add_query_arg' ) ? add_query_arg( self::LOCKED_QUERY, '1', $redirect ) : $redirect );
			return;
		}

		$summary = $this->scan(); // LAYER 3 inside.
		$this->store->set( self::LAST_SCAN_KEY, $summary );
		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id(), $summary, self::RESULT_TTL );
		}
		$this->redirect( $redirect );
	}

	/** wp_safe_redirect + exit, guarded for the harness. */
	private function redirect( string $location ): void {
		if ( function_exists( 'wp_safe_redirect' ) ) {
			wp_safe_redirect( $location );
			exit;
		}
	}

	// ── render (LAYER 1 gate) ───────────────────────────────────────────────────

	/**
	 * Render the broken-link-scanner section. Locked → gate reasons only.
	 * Unlocked → the "Scan now" button + the last scan result table (read from the
	 * per-user transient, falling back to the durable store).
	 */
	public function render_section(): void {
		$gate = $this->entitlements->evaluate( self::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . self::esc_html_s( 'Broken Link Scanner' ) . '</h2>';
		echo '<p>' . self::esc_html_s( 'Scan your published content for links that no longer resolve — checked entirely on this server, read-only.' ) . '</p>';

		if ( isset( $_GET[ self::LOCKED_QUERY ] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-error" style="margin-top:12px;padding:12px;"><p><strong>' . self::esc_html_s( 'The Broken Link Scanner entitlement is not granted.' ) . '</strong></p></div>';
		}

		if ( empty( $gate['unlocked'] ) ) {
			self::render_locked_notice( $gate );
			return;
		}

		// Progressive disclosure (additive): PRIMARY = the existing "Scan now"
		// button + a last-scan status meta; the per-run limits/scope move into a
		// collapsed Advanced block. The form/nonce/hidden action are unchanged.
		$last = $this->last_result_summary();
		$meta = self::esc_html_s( 'No scan yet.' );
		if ( is_array( $last ) && ! empty( $last['ok'] ) ) {
			$broken = ( isset( $last['broken'] ) && is_array( $last['broken'] ) ) ? count( $last['broken'] ) : 0;
			$meta   = self::esc_html_s( sprintf(
				'Last scan: %d posts, %d broken.',
				isset( $last['scanned_posts'] ) ? (int) $last['scanned_posts'] : 0,
				$broken
			) );
		}

		echo '<div class="iwsl-primary">';
		echo '<span class="iwsl-primary__meta">' . $meta . '</span>';
		echo '<form method="post" action="' . self::esc_attr_s( self::admin_post_url() ) . '">';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( self::NONCE );
		}
		echo '<input type="hidden" name="action" value="' . self::esc_attr_s( self::ACTION ) . '">';
		echo '<button type="submit" class="button button-primary">' . self::esc_html_s( 'Scan now' ) . '</button>' . iwsl_field_help( 'Check all your content for links that no longer work.' );
		echo '</form>';
		echo '</div>';

		echo '<details class="iwsl-adv"><summary>' . self::esc_html_s( 'Advanced settings' ) . '</summary><div class="iwsl-adv__body">';
		echo '<p class="description">' . self::esc_html_s( sprintf( 'Checks up to %d posts and %d links per run.', self::MAX_POSTS, self::MAX_LINKS ) ) . '</p>';
		echo '<p class="description">' . self::esc_html_s( 'Scope: published content only. Links are resolved on this server; nothing is modified.' ) . '</p>';
		echo '</div></details>';

		$this->render_result_table();
	}

	/** Render the most recent scan result table (transient first, then durable store). */
	private function render_result_table(): void {
		$summary = $this->last_result_summary();
		if ( ! is_array( $summary ) || empty( $summary['ok'] ) ) {
			echo '<p style="margin-top:16px;">' . self::esc_html_s( 'No scan has been run yet.' ) . '</p>';
			return;
		}

		$broken  = isset( $summary['broken'] ) && is_array( $summary['broken'] ) ? $summary['broken'] : array();
		$scanned = isset( $summary['scanned_posts'] ) ? (int) $summary['scanned_posts'] : 0;
		$links   = isset( $summary['checked_links'] ) ? (int) $summary['checked_links'] : 0;
		$partial = ! empty( $summary['partial'] );

		echo '<h3 style="margin-top:24px;">' . self::esc_html_s( 'Last scan' ) . '</h3>';
		echo '<p class="description">' . self::esc_html_s( sprintf( 'Scanned %d posts, checked %d links, found %d broken.', $scanned, $links, count( $broken ) ) );
		if ( $partial ) {
			echo ' ' . self::esc_html_s( '(Partial — the time or link budget was reached.)' );
		}
		echo '</p>';

		if ( array() === $broken ) {
			echo '<p>' . self::esc_html_s( 'No broken links found.' ) . '</p>';
			return;
		}

		echo '<table class="widefat striped" style="max-width:960px;margin-top:12px;"><thead><tr>';
		echo '<th>' . self::esc_html_s( 'Post' ) . '</th>';
		echo '<th>' . self::esc_html_s( 'URL' ) . '</th>';
		echo '<th>' . self::esc_html_s( 'Status' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $broken as $entry ) {
			if ( ! is_array( $entry ) ) {
				continue;
			}
			$title  = isset( $entry['post_title'] ) ? (string) $entry['post_title'] : '';
			$pid    = isset( $entry['post_id'] ) ? (int) $entry['post_id'] : 0;
			$url    = isset( $entry['url'] ) ? (string) $entry['url'] : '';
			$status = isset( $entry['status'] ) ? (string) $entry['status'] : '';
			$label  = '' !== $title ? $title : ( '#' . $pid );
			echo '<tr>';
			echo '<td>' . self::esc_html_s( $label ) . '</td>';
			// URL rendered as PLAIN TEXT — an admin page must never link to an
			// arbitrary stored URL.
			echo '<td>' . self::esc_html_s( $url ) . '</td>';
			echo '<td>' . self::esc_html_s( $status ) . '</td>';
			echo '</tr>';
		}
		echo '</tbody></table>';
	}

	/** The summary to display: the current user's transient, else the durable store. @return array|null */
	private function last_result_summary() {
		if ( function_exists( 'get_transient' ) && function_exists( 'get_current_user_id' ) ) {
			$value = get_transient( self::RESULT_TRANSIENT_PREFIX . (int) get_current_user_id() );
			if ( is_array( $value ) ) {
				return $value;
			}
		}
		return $this->last_scan();
	}

	/** Reason lines for a locked gate (no scan button). */
	private static function render_locked_notice( array $gate ): void {
		$messages = array(
			'not-linked'      => 'This site is not linked to the InfraWeaver console. Enroll the connector first.',
			'heartbeat-stale' => 'The signed heartbeat is stale — the console has not verified a signed command recently.',
			'requires-plus'   => 'The Broken Link Scanner entitlement is not granted — assign the Pro tier from the console.',
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>🔒 Broken Link Scanner is locked.</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) ( $gate['reasons'] ?? array() ) as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . self::esc_html_s( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	/** admin-post.php URL, guarded. */
	private static function admin_post_url(): string {
		return function_exists( 'admin_url' ) ? admin_url( 'admin-post.php' ) : 'admin-post.php';
	}

	/** esc_html with a harness-safe fallback. */
	private static function esc_html_s( string $s ): string {
		return function_exists( 'esc_html' ) ? esc_html( $s ) : htmlspecialchars( $s, ENT_QUOTES );
	}

	/** esc_attr with a harness-safe fallback. */
	private static function esc_attr_s( string $s ): string {
		return function_exists( 'esc_attr' ) ? esc_attr( $s ) : htmlspecialchars( $s, ENT_QUOTES );
	}
}
