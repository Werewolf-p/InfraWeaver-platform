<?php
/**
 * Match strategy contract for the gated "301 Redirect Manager" feature. A matcher
 * is a pure, side-effect-free predicate: given a pre-normalized rule source and a
 * pre-normalized request path, it answers a single yes/no. It never reads state,
 * never talks to the network, and never decodes — the caller (IWSL_Redirects) has
 * already normalized both operands identically before asking.
 *
 * The generic engine (IWSL_Redirects) owns the entitlement gate, the save-time
 * security gauntlet, request-time re-validation, hit counting and the 404 log. A
 * matcher owns exactly one thing: deciding whether one stored source applies to
 * one incoming path. Adding a strategy (prefix, regex) is therefore one class
 * implementing this interface plus one line in IWSL_Redirects::matchers().
 */

defined( 'ABSPATH' ) || exit;

interface IWSL_Redirect_Matcher {

	/** Stable id, shape `[a-z0-9_]{1,32}`. Used as the registry key and wire token. */
	public function id(): string;

	/** Human label for the admin capability table. */
	public function label(): string;

	/**
	 * Whether $rule_source applies to $request_path. Both operands are already
	 * normalized by IWSL_Redirects::normalize_path() — the matcher does no
	 * decoding, trimming, or case folding of its own.
	 *
	 * @param string $rule_source  Normalized stored source path.
	 * @param string $request_path Normalized incoming request path.
	 */
	public function matches( string $rule_source, string $request_path ): bool;
}
