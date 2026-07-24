<?php
/**
 * Pure, bounded suggestion engine for the Site Health "404s → redirects" flow.
 * Given a ranked list of recently-not-found paths and a list of live published
 * paths, it proposes the most likely redirect TARGET for each dead path, each with
 * a coarse confidence label. It is the read-only brain behind S6: the console turns
 * an accepted suggestion into a signed `redirects.create`, so this class never
 * writes, never touches the network, and never reaches WordPress — every input is
 * supplied by the caller (the IWSL_Site_Health aggregator in production, fixtures
 * in the harness).
 *
 * BOUNDS. Hard-capped work: at most MAX_PATHS dead paths × MAX_CANDIDATES live
 * paths, each comparison a `similar_text` over two short tail slugs. The output is
 * capped at MAX_PATHS. Degenerate inputs (empty, non-string, no tail) yield fewer
 * or zero suggestions — never an error.
 *
 * HEURISTICS (cheapest first).
 *  - Exact tail-slug match (the last path segment, extension-stripped, lowercased):
 *    the strongest signal → confidence 'high', wins immediately.
 *  - Otherwise the best bounded `similar_text` ratio over tail slugs:
 *    ≥ HIGH_PCT → 'medium', ≥ LOW_PCT → 'low', below that → no suggestion.
 * Taking the TAIL segment inherently ignores date prefixes (`/2020/05/my-post`)
 * and directory moves; extension stripping covers `.html`/`.php` variants.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Redirect_Suggestions {

	/** Hard cap on dead paths considered (and on suggestions returned). */
	const MAX_PATHS = 20;

	/** Hard cap on live candidate paths compared per dead path. */
	const MAX_CANDIDATES = 200;

	/** similar_text ratio (0–100) at/above which a fuzzy match is 'medium'. */
	const HIGH_PCT = 80.0;

	/** similar_text ratio at/above which a fuzzy match is 'low' (below → dropped). */
	const LOW_PCT = 55.0;

	/** Trailing extensions stripped from a tail slug before comparison. */
	const STRIP_EXTENSIONS = array( '.html', '.htm', '.php', '.aspx', '.asp' );

	/**
	 * Propose a redirect target for each dead path. Pure + bounded.
	 *
	 * @param string[] $notfound_paths  Ranked dead paths (most-wanted first).
	 * @param string[] $published_paths Live published paths (redirect targets).
	 * @return array<int, array{path:string, target:string, confidence:string}>
	 */
	public static function suggest( array $notfound_paths, array $published_paths ): array {
		$paths      = self::clean_list( $notfound_paths, self::MAX_PATHS );
		$candidates = self::clean_list( $published_paths, self::MAX_CANDIDATES );
		if ( array() === $paths || array() === $candidates ) {
			return array();
		}

		$out = array();
		foreach ( $paths as $path ) {
			$best = self::best_candidate( $path, $candidates );
			if ( null !== $best ) {
				$out[] = array(
					'path'       => $path,
					'target'     => $best['target'],
					'confidence' => $best['confidence'],
				);
			}
		}
		return $out;
	}

	/**
	 * The best target for one dead path, or null when nothing clears LOW_PCT. An
	 * exact tail-slug match short-circuits at 'high'.
	 *
	 * @param string[] $candidates
	 * @return array{target:string, confidence:string}|null
	 */
	private static function best_candidate( string $path, array $candidates ): ?array {
		$slug = self::tail_slug( $path );
		if ( '' === $slug ) {
			return null;
		}
		$best       = null;
		$best_score = 0.0;
		foreach ( $candidates as $candidate ) {
			$cslug = self::tail_slug( $candidate );
			if ( '' === $cslug ) {
				continue;
			}
			if ( $cslug === $slug ) {
				return array( 'target' => $candidate, 'confidence' => 'high' );
			}
			$pct = 0.0;
			similar_text( $slug, $cslug, $pct );
			if ( $pct > $best_score ) {
				$best_score = $pct;
				$best       = $candidate;
			}
		}
		if ( null === $best ) {
			return null;
		}
		if ( $best_score >= self::HIGH_PCT ) {
			return array( 'target' => $best, 'confidence' => 'medium' );
		}
		if ( $best_score >= self::LOW_PCT ) {
			return array( 'target' => $best, 'confidence' => 'low' );
		}
		return null;
	}

	/**
	 * The comparison key for a path: its last non-empty segment, with any trailing
	 * extension removed and lowercased. `''` when the path has no usable tail.
	 */
	public static function tail_slug( string $path ): string {
		$trimmed = trim( $path );
		if ( '' === $trimmed ) {
			return '';
		}
		// Drop a query/fragment defensively (callers pass paths, but be safe).
		$q = strpbrk( $trimmed, '?#' );
		if ( false !== $q ) {
			$trimmed = substr( $trimmed, 0, strlen( $trimmed ) - strlen( $q ) );
		}
		$trimmed = rtrim( $trimmed, '/' );
		$pos     = strrpos( $trimmed, '/' );
		$segment = false === $pos ? $trimmed : substr( $trimmed, $pos + 1 );
		$segment = strtolower( $segment );
		foreach ( self::STRIP_EXTENSIONS as $ext ) {
			$len = strlen( $ext );
			if ( strlen( $segment ) > $len && $ext === substr( $segment, -$len ) ) {
				$segment = substr( $segment, 0, -$len );
				break;
			}
		}
		return $segment;
	}

	/**
	 * De-dupe, drop non-strings/empties, and cap the list. Order-preserving so a
	 * caller's ranking survives.
	 *
	 * @param array<int, mixed> $list
	 * @return string[]
	 */
	private static function clean_list( array $list, int $cap ): array {
		$out  = array();
		$seen = array();
		foreach ( $list as $item ) {
			if ( ! is_string( $item ) ) {
				continue;
			}
			$item = trim( $item );
			if ( '' === $item || isset( $seen[ $item ] ) ) {
				continue;
			}
			$seen[ $item ] = true;
			$out[]         = $item;
			if ( count( $out ) >= $cap ) {
				break;
			}
		}
		return $out;
	}
}
