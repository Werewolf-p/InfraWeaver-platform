<?php
/**
 * PNG → WebP LOSSLESS converter. The only source MIME accepted is image/png:
 * WebP-lossless reliably shrinks PNGs while preserving every pixel, whereas
 * transcoding a JPEG to WebP-lossless typically GROWS the file 2–4x (a JPEG is
 * already lossy-compressed), so JPEG is deliberately excluded from accepts().
 *
 * Engine selection happens at runtime, Imagick preferred:
 *
 *   - Imagick keeps the ICC colour profile (no stripImage) and exposes the
 *     libwebp `webp:exact` knob, which stops the encoder rewriting the RGB of
 *     fully-transparent pixels — required for strict pixel-for-pixel fidelity.
 *   - GD is the fallback. It CAN encode lossless WebP via IMG_WEBP_LOSSLESS
 *     (a constant that exists only since PHP 8.1.0), but it DROPS ICC / colour
 *     metadata: the raw pixels are preserved, colour-management is not — which
 *     is exactly why Imagick is preferred when both are available.
 *
 * We deliberately do NOT use WP_Image_Editor: it exposes no lossless flag, so
 * routing WebP encoding through it would silently produce a lossy derivative.
 *
 * Nothing here shells out and nothing touches the source file — the source is
 * only ever read.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_WebP_Lossless_Converter implements IWSL_Media_Converter {

	/** Best-effort Imagick decode limits (§C) — constant names vary by build. */
	const IMAGICK_MAX_WIDTH  = 16383;
	const IMAGICK_MAX_HEIGHT = 16383;
	const IMAGICK_MAX_AREA   = 40000000;
	const IMAGICK_MAX_TIME   = 20; // seconds

	public function id(): string {
		return 'webp_lossless';
	}

	public function label(): string {
		return 'PNG → WebP (lossless)';
	}

	/** PNG only — see the class docblock for why JPEG is excluded. */
	public function accepts(): array {
		return array( 'image/png' );
	}

	/**
	 * Side-effect-free capability probe. Imagick wins when it advertises the WEBP
	 * coder; GD qualifies only when imagewebp() exists AND IMG_WEBP_LOSSLESS is
	 * defined (PHP >= 8.1) AND gd_info() confirms WebP support.
	 *
	 * @return array{ ok:bool, engine:string, reason:string }
	 */
	public function availability(): array {
		if ( self::imagick_available() ) {
			return array( 'ok' => true, 'engine' => 'imagick-webp', 'reason' => '' );
		}
		if ( self::gd_available() ) {
			return array( 'ok' => true, 'engine' => 'gd-webp-lossless', 'reason' => '' );
		}
		// Distinguish "no engine at all" from "GD present but too old for the
		// lossless flag" so the admin panel can tell the operator what to fix.
		if ( function_exists( 'imagewebp' ) && ! defined( 'IMG_WEBP_LOSSLESS' ) ) {
			return array( 'ok' => false, 'engine' => 'none', 'reason' => 'gd-lossless-requires-php81' );
		}
		return array( 'ok' => false, 'engine' => 'none', 'reason' => 'no-webp-engine' );
	}

	/** True when Imagick is loaded and advertises the WEBP coder. */
	private static function imagick_available(): bool {
		if ( ! extension_loaded( 'imagick' ) || ! class_exists( 'Imagick' ) ) {
			return false;
		}
		$formats = Imagick::queryFormats( 'WEBP' );
		return is_array( $formats ) && array() !== $formats;
	}

	/** True when GD can write LOSSLESS WebP (needs the PHP 8.1 constant). */
	private static function gd_available(): bool {
		if ( ! function_exists( 'imagewebp' ) || ! defined( 'IMG_WEBP_LOSSLESS' ) ) {
			return false;
		}
		if ( ! function_exists( 'gd_info' ) ) {
			return false;
		}
		$info = gd_info();
		return is_array( $info ) && ! empty( $info['WebP Support'] );
	}

	/**
	 * Encode $source to $dest as lossless WebP. Writes $dest only.
	 *
	 * @return array{ ok:bool, bytes_in:int, bytes_out:int, reason:string }
	 */
	public function convert( string $source_path, string $dest_path ): array {
		$bytes_in = (int) @filesize( $source_path );
		$avail    = $this->availability();
		if ( empty( $avail['ok'] ) ) {
			return array( 'ok' => false, 'bytes_in' => $bytes_in, 'bytes_out' => 0, 'reason' => (string) $avail['reason'] );
		}
		if ( 'imagick-webp' === $avail['engine'] ) {
			return $this->convert_imagick( $source_path, $dest_path, $bytes_in );
		}
		return $this->convert_gd( $source_path, $dest_path, $bytes_in );
	}

	/**
	 * Imagick path: ping the header first (a second, engine-level dimension
	 * check on top of the optimizer's getimagesize gauntlet), keep the ICC
	 * profile, and set webp:lossless + webp:exact for strict pixel preservation.
	 *
	 * @return array{ ok:bool, bytes_in:int, bytes_out:int, reason:string }
	 */
	private function convert_imagick( string $source_path, string $dest_path, int $bytes_in ): array {
		$img = null;
		try {
			$img = new Imagick();
			self::apply_imagick_limits( $img );
			// Header-only inspection before committing to a full decode.
			$img->pingImage( $source_path );
			$img->readImage( $source_path );
			$img->setImageFormat( 'webp' );
			$img->setOption( 'webp:lossless', 'true' );
			// Preserve RGB under fully-transparent pixels — without this libwebp
			// may rewrite them, breaking a strict pixel-for-pixel comparison.
			$img->setOption( 'webp:exact', 'true' );
			// Intentionally NO stripImage(): keep the ICC colour profile.
			$written = $img->writeImage( $dest_path );
			$img->clear();
			$img->destroy();
			if ( ! $written ) {
				return array( 'ok' => false, 'bytes_in' => $bytes_in, 'bytes_out' => 0, 'reason' => 'imagick-write-failed' );
			}
		} catch ( Exception $e ) {
			if ( $img instanceof Imagick ) {
				$img->clear();
				$img->destroy();
			}
			// Never leak internal engine detail into the summary.
			return array( 'ok' => false, 'bytes_in' => $bytes_in, 'bytes_out' => 0, 'reason' => 'imagick-error' );
		}
		clearstatcache( true, $dest_path );
		return array(
			'ok'        => true,
			'bytes_in'  => $bytes_in,
			'bytes_out' => (int) @filesize( $dest_path ),
			'reason'    => '',
		);
	}

	/**
	 * GD fallback. Preserves pixels and alpha; drops ICC (see class docblock).
	 * Uses defined('IMG_WEBP_LOSSLESS') — never the literal flag value.
	 *
	 * @return array{ ok:bool, bytes_in:int, bytes_out:int, reason:string }
	 */
	private function convert_gd( string $source_path, string $dest_path, int $bytes_in ): array {
		$im = @imagecreatefrompng( $source_path );
		if ( false === $im ) {
			return array( 'ok' => false, 'bytes_in' => $bytes_in, 'bytes_out' => 0, 'reason' => 'gd-decode-failed' );
		}
		if ( ! imageistruecolor( $im ) ) {
			imagepalettetotruecolor( $im );
		}
		imagealphablending( $im, false );
		imagesavealpha( $im, true );
		$ok = imagewebp( $im, $dest_path, IMG_WEBP_LOSSLESS );
		imagedestroy( $im );
		if ( ! $ok ) {
			return array( 'ok' => false, 'bytes_in' => $bytes_in, 'bytes_out' => 0, 'reason' => 'gd-encode-failed' );
		}
		clearstatcache( true, $dest_path );
		return array(
			'ok'        => true,
			'bytes_in'  => $bytes_in,
			'bytes_out' => (int) @filesize( $dest_path ),
			'reason'    => '',
		);
	}

	/**
	 * Best-effort Imagick resource limits (§C decode-bomb defence). Each
	 * RESOURCETYPE_* constant is guarded with defined() because the set present
	 * varies by ImageMagick build — a missing one simply isn't clamped here (the
	 * optimizer's engine-independent getimagesize caps remain authoritative).
	 */
	private static function apply_imagick_limits( Imagick $img ): void {
		if ( defined( 'Imagick::RESOURCETYPE_WIDTH' ) ) {
			$img->setResourceLimit( Imagick::RESOURCETYPE_WIDTH, self::IMAGICK_MAX_WIDTH );
		}
		if ( defined( 'Imagick::RESOURCETYPE_HEIGHT' ) ) {
			$img->setResourceLimit( Imagick::RESOURCETYPE_HEIGHT, self::IMAGICK_MAX_HEIGHT );
		}
		if ( defined( 'Imagick::RESOURCETYPE_AREA' ) ) {
			$img->setResourceLimit( Imagick::RESOURCETYPE_AREA, self::IMAGICK_MAX_AREA );
		}
		if ( defined( 'Imagick::RESOURCETYPE_TIME' ) ) {
			$img->setResourceLimit( Imagick::RESOURCETYPE_TIME, self::IMAGICK_MAX_TIME );
		}
	}
}
