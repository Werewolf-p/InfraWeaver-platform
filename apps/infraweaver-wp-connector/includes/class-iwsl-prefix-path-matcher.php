<?php
/**
 * An IWSL_Redirect_Matcher that matches a whole moved section by path prefix — the
 * strategy that lets one rule retire `/old-blog/*` instead of enumerating every
 * child. Like the exact matcher it is a pure, side-effect-free predicate over two
 * already-normalized paths: no decode, no case folding, no state, no network.
 *
 * SOURCE SHAPE. A prefix rule's stored source ends with the literal marker `/*`
 * (e.g. `/old-blog/*`); IWSL_Redirects only stores that shape when the rule's
 * `match` key is 'prefix' (its save-time gauntlet refuses `/*` for exact rules and
 * refuses a bare whole-site `/*`). The matcher strips the marker to a base path and
 * matches SEGMENT-WISE: the base itself, or anything strictly under `base/`. So
 * `/old/*` matches `/old` and `/old/a` but NOT `/older` — the fail-closed behaviour
 * the redirect engine relies on. Matching stays byte-exact on the encoded path
 * (`strpos`, never a decode), so `/a%2Fb` never matches `/a/b`.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Prefix_Path_Matcher implements IWSL_Redirect_Matcher {

	/** The `/*` marker a prefix source must end with. */
	const MARKER = '/*';

	public function id(): string {
		return 'prefix';
	}

	public function label(): string {
		return 'Path prefix';
	}

	/**
	 * Whether $rule_source (a normalized prefix source ending in `/*`) covers
	 * $request_path. Fail-closed: a source that does not carry the marker, or a
	 * degenerate whole-site prefix, never matches.
	 */
	public function matches( string $rule_source, string $request_path ): bool {
		if ( self::MARKER !== substr( $rule_source, -strlen( self::MARKER ) ) ) {
			return false; // Not a prefix-shaped source — fail closed.
		}
		$base = substr( $rule_source, 0, -strlen( self::MARKER ) );
		if ( '' === $base || '/' === $base ) {
			return false; // Never match a whole-site prefix.
		}
		// Segment-wise: the base path itself, or anything strictly under `base/`.
		return $request_path === $base || 0 === strpos( $request_path, $base . '/' );
	}
}
