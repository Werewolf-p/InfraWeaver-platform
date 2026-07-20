<?php
/**
 * The one shipped IWSL_Redirect_Matcher: a byte-exact equality of the two
 * already-normalized paths. No regex, no decode, no case folding — a source
 * matches a request only when their normalized bytes are identical. This is the
 * fail-closed matcher the spec asks for (`/a%2Fb` never equals `/a/b`); prefix and
 * regex strategies would each be one more class plus one registry line.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Exact_Path_Matcher implements IWSL_Redirect_Matcher {

	public function id(): string {
		return 'exact';
	}

	public function label(): string {
		return 'Exact path';
	}

	public function matches( string $rule_source, string $request_path ): bool {
		return $rule_source === $request_path;
	}
}
