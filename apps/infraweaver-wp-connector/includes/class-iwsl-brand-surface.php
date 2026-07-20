<?php
/**
 * White-label surface contract for the gated "Custom login + admin white-label"
 * feature. A surface is a pure, side-effect-scoped branding target: given the
 * sanitized white-label settings map it RESOLVES the concrete, already-escaped
 * fragments it would contribute (login CSS, header URL, footer HTML, …). It never
 * echoes, never registers a hook, never talks to the network, and never shells
 * out — resolution is a pure function of the settings.
 *
 * The generic engine (IWSL_White_Label) owns the entitlement gate, the save-time
 * validation gauntlet, the WordPress hook wiring, and the per-callback gate
 * re-check that makes revoking the flag restore default behavior instantly. A
 * surface owns exactly one thing: turning the settings map into the escaped
 * output for one presentation area. Adding a new white-label area is therefore
 * one class implementing this interface plus one line in
 * IWSL_White_Label::surfaces().
 */

defined( 'ABSPATH' ) || exit;

interface IWSL_Brand_Surface {

	/** Stable id, shape `[a-z0-9_]{1,32}`. Used as the registry key and wire token. */
	public function id(): string;

	/** Human label for the admin capability table. */
	public function label(): string;

	/**
	 * The WordPress hooks this surface influences, for the admin capability table.
	 * Documentation only — the engine owns the actual add_action/add_filter wiring.
	 *
	 * @return string[]
	 */
	public function hooks(): array;

	/**
	 * Pure resolver: given the sanitized settings map, return the concrete,
	 * already-escaped fragments this surface contributes to the branding decision.
	 * Side-effect free — no echo, no hook registration, safe to call on every admin
	 * render and on every front-end request. MUST escape every dynamic value it
	 * emits so the engine can hand the fragments straight to WordPress.
	 *
	 * @param array<string, mixed> $settings The sanitized settings (IWSL_White_Label::settings()).
	 * @return array<string, mixed> At minimum: { id:string, active:bool }.
	 */
	public function resolve( array $settings ): array;
}
