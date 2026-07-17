<?php
/**
 * One entry in the IWSL command registry (§7). A handler binds a wire method to
 * its params validator, its runner, and the two cross-cutting flags
 * `handle_command` needs (§8): whether the PREPARE response signs under the
 * current confirmed key, and whether the site wipes itself after answering.
 *
 * IWSL_Plugin derives BOTH `allowed_methods()` (verifier allow-list) and
 * `execute()` (dispatch) from an array of these, so the method set has a single
 * definition point instead of a parallel allow-list + switch that can drift.
 *
 * Runners are supplied by IWSL_Plugin (closures scoped to that class), so they
 * reach its private store/rotation/debug surface without widening visibility.
 */
final class IWSL_Command_Handler {

	/** @var string wire method (e.g. `health.check`). */
	public $method;

	/**
	 * Params validator, or null to require empty params (§6.3). Matches the
	 * `array<string, callable|null>` shape IWSL_Verifier consumes.
	 *
	 * @var callable|null
	 */
	public $validator;

	/**
	 * PREPARE-style method whose response is signed by the CURRENT confirmed key
	 * rather than the (soon-to-be) signing key — §8 chain of custody.
	 *
	 * @var bool
	 */
	public $signs_with_current_kid;

	/** @var bool §8 kill switch: wipe all local state after building the response. */
	public $wipes_after;

	/**
	 * @var callable(IWSL_Plugin, stdClass): array{0: bool, 1: array}
	 */
	private $runner;

	/**
	 * @param callable      $runner                 (IWSL_Plugin, stdClass) => [bool $ok, array $result]
	 * @param callable|null $validator              params validator (null = empty params)
	 * @param bool          $signs_with_current_kid response signs under the current confirmed kid
	 * @param bool          $wipes_after            wipe local state after responding
	 */
	public function __construct(
		string $method,
		callable $runner,
		?callable $validator = null,
		bool $signs_with_current_kid = false,
		bool $wipes_after = false
	) {
		$this->method                 = $method;
		$this->runner                 = $runner;
		$this->validator              = $validator;
		$this->signs_with_current_kid = $signs_with_current_kid;
		$this->wipes_after            = $wipes_after;
	}

	/**
	 * Run the command against the plugin context.
	 *
	 * @return array{0: bool, 1: array}
	 */
	public function run( IWSL_Plugin $plugin, stdClass $envelope ): array {
		return ( $this->runner )( $plugin, $envelope );
	}
}
