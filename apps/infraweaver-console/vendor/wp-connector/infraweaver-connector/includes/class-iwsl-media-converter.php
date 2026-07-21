<?php
/**
 * Format-conversion strategy contract for the gated "Lossless Image Optimization"
 * feature. A converter is a pure, side-effect-scoped codec: given a
 * pre-validated source path and a destination path, it writes the DESTINATION
 * ONLY and reports byte counts. It never touches the source, never talks to the
 * network, and never shells out — engines are in-process (Imagick/GD) only.
 *
 * The generic engine (IWSL_Media_Optimizer) owns the security gauntlet, the
 * entitlement gate, batching, idempotency and the keep-only-if-smaller policy.
 * A converter owns exactly one thing: turning one accepted MIME into a smaller
 * lossless derivative. Adding a new format is therefore one class implementing
 * this interface plus one line in IWSL_Media_Optimizer::converters().
 */

defined( 'ABSPATH' ) || exit;

interface IWSL_Media_Converter {

	/** Stable id, shape `[a-z0-9_]{1,32}`. Used as the registry key and wire token. */
	public function id(): string;

	/** Human label for the admin capability table. */
	public function label(): string;

	/**
	 * Allow-listed source MIME types this converter will accept. The optimizer
	 * selects attachments by exactly these MIMEs and the gauntlet content-sniffs
	 * against them — extension is never trusted.
	 *
	 * @return string[]
	 */
	public function accepts(): array;

	/**
	 * Side-effect-free capability probe: is a usable in-process engine present?
	 * Never decodes, never writes, never allocates image buffers — safe to call
	 * on every admin render.
	 *
	 * @return array{ ok:bool, engine:string, reason:string }
	 */
	public function availability(): array;

	/**
	 * Encode $source_path into $dest_path losslessly. Writes $dest_path ONLY and
	 * MUST NOT modify, move or unlink the source — the caller has already
	 * validated both paths (containment, MIME, pixel/byte caps) before calling.
	 *
	 * @param string $source_path Pre-validated, contained, sniffed source file.
	 * @param string $dest_path   Destination the converter must create/overwrite.
	 * @return array{ ok:bool, bytes_in:int, bytes_out:int, reason:string }
	 */
	public function convert( string $source_path, string $dest_path ): array;
}
