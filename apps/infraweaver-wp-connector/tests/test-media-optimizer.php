<?php
/**
 * Lossless Image Optimization (gate flag `image_optimization`): the generic
 * engine (IWSL_Media_Optimizer) + the WebP-lossless converter.
 *
 * Runs under the zero-dependency harness: the WordPress functions the optimizer
 * touches (get_posts / get_attached_file / *_post_meta / *_transient) are stubbed
 * against in-memory registries below, and $base_dir + a fixed clock are injected.
 *
 * A RECORDING FAKE converter proves the entitlement gate blocks BEFORE any codec
 * is asked to run. The real image roundtrip is engine-guarded and SKIPS cleanly
 * when neither Imagick nor GD-WebP-lossless is available — every gate / guard /
 * idempotency assertion runs without any image engine.
 */

// ── in-memory WordPress stubs (harness only) ──────────────────────────────────

$GLOBALS['iwsl_mo_attachments'] = array(); // id => [ 'path' => str, 'mime' => str ]
$GLOBALS['iwsl_mo_meta']        = array(); // id => [ meta_key => value ]
$GLOBALS['iwsl_mo_transients']  = array(); // key => value

function iwsl_mo_reset(): void {
	$GLOBALS['iwsl_mo_attachments'] = array();
	$GLOBALS['iwsl_mo_meta']        = array();
	$GLOBALS['iwsl_mo_transients']  = array();
}

if ( ! function_exists( 'get_posts' ) ) {
	function get_posts( array $args = array() ) {
		$want = isset( $args['post_mime_type'] ) ? (array) $args['post_mime_type'] : array();
		$per  = isset( $args['posts_per_page'] ) ? (int) $args['posts_per_page'] : -1;
		$ids  = array();
		foreach ( $GLOBALS['iwsl_mo_attachments'] as $id => $att ) {
			if ( array() === $want || in_array( $att['mime'], $want, true ) ) {
				$ids[] = (int) $id;
			}
		}
		sort( $ids ); // orderby ID ASC
		return $per > 0 ? array_slice( $ids, 0, $per ) : $ids;
	}
}
if ( ! function_exists( 'get_attached_file' ) ) {
	function get_attached_file( int $id ) {
		return isset( $GLOBALS['iwsl_mo_attachments'][ $id ] ) ? $GLOBALS['iwsl_mo_attachments'][ $id ]['path'] : '';
	}
}
if ( ! function_exists( 'get_post_meta' ) ) {
	function get_post_meta( int $id, string $key, bool $single = false ) {
		if ( isset( $GLOBALS['iwsl_mo_meta'][ $id ][ $key ] ) ) {
			return $GLOBALS['iwsl_mo_meta'][ $id ][ $key ];
		}
		return $single ? '' : array();
	}
}
if ( ! function_exists( 'update_post_meta' ) ) {
	function update_post_meta( int $id, string $key, $value ): bool {
		$GLOBALS['iwsl_mo_meta'][ $id ][ $key ] = $value;
		return true;
	}
}
if ( ! function_exists( 'get_transient' ) ) {
	function get_transient( string $key ) {
		return array_key_exists( $key, $GLOBALS['iwsl_mo_transients'] ) ? $GLOBALS['iwsl_mo_transients'][ $key ] : false;
	}
}
if ( ! function_exists( 'set_transient' ) ) {
	function set_transient( string $key, $value, int $ttl = 0 ): bool {
		$GLOBALS['iwsl_mo_transients'][ $key ] = $value;
		return true;
	}
}
if ( ! function_exists( 'delete_transient' ) ) {
	function delete_transient( string $key ): bool {
		unset( $GLOBALS['iwsl_mo_transients'][ $key ] );
		return true;
	}
}

// ── helpers: PNG synthesis + fixtures ─────────────────────────────────────────

function iwsl_mo_png_sig(): string {
	return "\x89PNG\r\n\x1a\n";
}
function iwsl_mo_png_chunk( string $type, string $data ): string {
	return pack( 'N', strlen( $data ) ) . $type . $data . pack( 'N', crc32( $type . $data ) );
}
function iwsl_mo_ihdr( int $w, int $h, int $colortype = 6 ): string {
	// width, height, bit-depth 8, colour type, compression 0, filter 0, interlace 0.
	return pack( 'N', $w ) . pack( 'N', $h ) . chr( 8 ) . chr( $colortype ) . chr( 0 ) . chr( 0 ) . chr( 0 );
}
/** A fully valid RGBA PNG (real IDAT via zlib) — parseable by getimagesize and any decoder. */
function iwsl_mo_valid_png( int $w = 4, int $h = 4 ): string {
	$raw = '';
	for ( $y = 0; $y < $h; $y++ ) {
		$raw .= chr( 0 ); // filter: none
		for ( $x = 0; $x < $w; $x++ ) {
			$raw .= chr( ( $x * 37 ) % 256 ) . chr( ( $y * 37 ) % 256 ) . chr( 120 ) . chr( 255 );
		}
	}
	return iwsl_mo_png_sig()
		. iwsl_mo_png_chunk( 'IHDR', iwsl_mo_ihdr( $w, $h, 6 ) )
		. iwsl_mo_png_chunk( 'IDAT', gzcompress( $raw, 9 ) )
		. iwsl_mo_png_chunk( 'IEND', '' );
}
function iwsl_mo_tempdir(): string {
	$dir = sys_get_temp_dir() . '/iwsl-mo-' . bin2hex( random_bytes( 6 ) );
	mkdir( $dir, 0700, true );
	return $dir;
}
/** Extract the per-item refusal/skip reasons from a run summary. */
function iwsl_mo_reasons( array $summary ): array {
	$out = array();
	foreach ( ( $summary['items'] ?? array() ) as $item ) {
		if ( isset( $item['reason'] ) ) {
			$out[] = (string) $item['reason'];
		}
	}
	return $out;
}

/** Unlocked entitlement gate: active + fresh heartbeat + image_optimization flag. */
function iwsl_mo_unlocked_entitlements( int $now ): IWSL_Entitlements {
	$store = new IWSL_Memory_Store();
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 60000 ); // 1 min ago — fresh
	$store->set( 'entitlements', array( 'plus' => true, 'image_optimization' => true ) );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** A recording fake converter — proves whether convert() was reached, and by how much it "shrinks". */
final class IWSL_Recording_Converter implements IWSL_Media_Converter {

	/** @var int */
	public $convert_calls = 0;

	/** @var float dest size = ratio * source size. */
	private $ratio;

	/** @var string */
	private $conv_id;

	public function __construct( float $ratio = 0.5, string $id = 'webp_lossless' ) {
		$this->ratio   = $ratio;
		$this->conv_id = $id;
	}

	public function id(): string {
		return $this->conv_id;
	}
	public function label(): string {
		return 'Recording fake';
	}
	public function accepts(): array {
		return array( 'image/png' );
	}
	public function availability(): array {
		return array( 'ok' => true, 'engine' => 'fake', 'reason' => '' );
	}
	public function convert( string $source_path, string $dest_path ): array {
		$this->convert_calls++;
		$in  = (int) filesize( $source_path );
		$out = (int) max( 1, (int) round( $in * $this->ratio ) );
		file_put_contents( $dest_path, str_repeat( 'a', $out ) );
		return array( 'ok' => true, 'bytes_in' => $in, 'bytes_out' => $out, 'reason' => '' );
	}
}

$NOW = 10000000;

// ── 1. Gate blocks a lower tier: convert() must NEVER run ─────────────────────

// (a) image_optimization flag ABSENT (Basic shape has only `plus`).
iwsl_mo_reset();
$dir  = iwsl_mo_tempdir();
$fake = new IWSL_Recording_Converter( 0.5 );
$store = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $NOW - 60000 );
$store->set( 'entitlements', array( 'plus' => true ) ); // image_optimization absent
$ent = new IWSL_Entitlements( $store, static function () use ( $NOW ): int {
	return $NOW; } );
$opt = new IWSL_Media_Optimizer( $ent, $dir, static function () use ( $NOW ): int {
	return $NOW; }, array( 'webp_lossless' => $fake ) );
$r = $opt->run( 'webp_lossless' );
iwsl_assert_same( 'entitlement-locked', $r['reason'], 'gate blocks: image_optimization flag absent → entitlement-locked' );
iwsl_assert_same( 0, $r['converted'], 'gate blocks (absent flag): converted=0' );
iwsl_assert_same( 0, $fake->convert_calls, 'gate blocks (absent flag): fake convert() NEVER called' );

// (b) state != active, even WITH the flag true.
iwsl_mo_reset();
$fake_b  = new IWSL_Recording_Converter( 0.5 );
$store_b = new IWSL_Memory_Store();
$store_b->set( 'state', 'pending' );
$store_b->set( 'last_verified_at', $NOW - 60000 );
$store_b->set( 'entitlements', array( 'plus' => true, 'image_optimization' => true ) );
$ent_b = new IWSL_Entitlements( $store_b, static function () use ( $NOW ): int {
	return $NOW; } );
$opt_b = new IWSL_Media_Optimizer( $ent_b, $dir, static function () use ( $NOW ): int {
	return $NOW; }, array( 'webp_lossless' => $fake_b ) );
$r_b = $opt_b->run();
iwsl_assert_same( 'entitlement-locked', $r_b['reason'], 'gate blocks: state!=active → entitlement-locked despite flag' );
iwsl_assert_same( 0, $fake_b->convert_calls, 'gate blocks (not active): convert() NEVER called' );

// (c) stale heartbeat, even WITH the flag true.
iwsl_mo_reset();
$fake_c  = new IWSL_Recording_Converter( 0.5 );
$store_c = new IWSL_Memory_Store();
$store_c->set( 'state', 'active' );
$store_c->set( 'last_verified_at', $NOW - 10800000 ); // 3h ago — stale
$store_c->set( 'entitlements', array( 'plus' => true, 'image_optimization' => true ) );
$ent_c = new IWSL_Entitlements( $store_c, static function () use ( $NOW ): int {
	return $NOW; } );
$opt_c = new IWSL_Media_Optimizer( $ent_c, $dir, static function () use ( $NOW ): int {
	return $NOW; }, array( 'webp_lossless' => $fake_c ) );
$r_c = $opt_c->run();
iwsl_assert_same( 'entitlement-locked', $r_c['reason'], 'gate blocks: stale heartbeat → entitlement-locked despite flag' );
iwsl_assert_same( 0, $fake_c->convert_calls, 'gate blocks (stale heartbeat): convert() NEVER called' );

// ── 2. Unlock → the batch actually proceeds ───────────────────────────────────

iwsl_mo_reset();
$dir2 = iwsl_mo_tempdir();
$png2 = $dir2 . '/photo.png';
file_put_contents( $png2, iwsl_mo_valid_png( 6, 6 ) );
$hash_before                            = hash_file( 'sha256', $png2 );
$GLOBALS['iwsl_mo_attachments'][101]    = array( 'path' => $png2, 'mime' => 'image/png' );
$fake2                                  = new IWSL_Recording_Converter( 0.4 );
$opt2                                   = new IWSL_Media_Optimizer(
	iwsl_mo_unlocked_entitlements( $NOW ),
	$dir2,
	static function () use ( $NOW ): int {
		return $NOW; },
	array( 'webp_lossless' => $fake2 )
);
$r2 = $opt2->run();
iwsl_assert_same( true, $r2['ok'], 'unlock: run proceeds (ok=true)' );
iwsl_assert_same( 1, $r2['converted'], 'unlock: one image converted' );
iwsl_assert_same( 1, $fake2->convert_calls, 'unlock: fake convert() called exactly once' );
iwsl_assert( is_file( $dir2 . '/photo-png.webp' ), 'unlock: derivative written alongside the original (ext folded into name)' );
iwsl_assert( is_file( $png2 ), 'unlock: original still present' );
iwsl_assert_same( $hash_before, hash_file( 'sha256', $png2 ), 'unlock: original bytes unchanged (never modified)' );

// ── 3. Lossless roundtrip — ENGINE-GUARDED, skips cleanly with no engine ──────

$gd_roundtrip = function_exists( 'imagecreatefrompng' )
	&& function_exists( 'imagecreatefromwebp' )
	&& function_exists( 'imagecreatetruecolor' )
	&& defined( 'IMG_WEBP_LOSSLESS' );
$imagick_roundtrip = extension_loaded( 'imagick' ) && class_exists( 'Imagick' );

if ( $gd_roundtrip ) {
	$rt_dir = iwsl_mo_tempdir();
	$src    = $rt_dir . '/src.png';
	$dst    = $rt_dir . '/src.webp';
	$w      = 5;
	$h      = 5;
	$im     = imagecreatetruecolor( $w, $h );
	imagealphablending( $im, false );
	imagesavealpha( $im, true );
	for ( $y = 0; $y < $h; $y++ ) {
		for ( $x = 0; $x < $w; $x++ ) {
			$alpha = ( 0 === ( ( $x + $y ) % 3 ) ) ? 127 : 0; // include transparency
			$color = imagecolorallocatealpha( $im, ( $x * 40 ) % 256, ( $y * 40 ) % 256, 90, $alpha );
			imagesetpixel( $im, $x, $y, $color );
		}
	}
	imagepng( $im, $src );
	imagedestroy( $im );
	$hash_src_before = hash_file( 'sha256', $src );

	$converter = new IWSL_WebP_Lossless_Converter();
	$res       = $converter->convert( $src, $dst );
	iwsl_assert_same( true, $res['ok'], 'roundtrip: converter reports ok' );
	iwsl_assert( is_file( $dst ), 'roundtrip: WebP derivative written' );
	iwsl_assert_same( $hash_src_before, hash_file( 'sha256', $src ), 'roundtrip: source bytes hash unchanged' );

	$a = imagecreatefrompng( $src );
	$b = imagecreatefromwebp( $dst );
	imagealphablending( $a, false );
	imagealphablending( $b, false );
	$pixels_equal = ( imagesx( $a ) === imagesx( $b ) ) && ( imagesy( $a ) === imagesy( $b ) );
	if ( $pixels_equal ) {
		for ( $y = 0; $y < $h && $pixels_equal; $y++ ) {
			for ( $x = 0; $x < $w; $x++ ) {
				if ( imagecolorat( $a, $x, $y ) !== imagecolorat( $b, $x, $y ) ) {
					$pixels_equal = false;
					break;
				}
			}
		}
	}
	imagedestroy( $a );
	imagedestroy( $b );
	iwsl_assert( $pixels_equal, 'roundtrip: WebP-lossless is pixel-for-pixel identical to the PNG' );
} elseif ( $imagick_roundtrip ) {
	$rt_dir = iwsl_mo_tempdir();
	$src    = $rt_dir . '/src.png';
	$dst    = $rt_dir . '/src.webp';
	$make   = new Imagick();
	$make->newImage( 5, 5, new ImagickPixel( 'rgba(120,90,60,1)' ), 'png' );
	$make->writeImage( $src );
	$make->clear();
	$hash_src_before = hash_file( 'sha256', $src );

	$converter = new IWSL_WebP_Lossless_Converter();
	$res       = $converter->convert( $src, $dst );
	iwsl_assert_same( true, $res['ok'], 'roundtrip(imagick): converter reports ok' );
	iwsl_assert( is_file( $dst ), 'roundtrip(imagick): WebP derivative written' );
	iwsl_assert_same( $hash_src_before, hash_file( 'sha256', $src ), 'roundtrip(imagick): source bytes hash unchanged' );

	$a         = new Imagick( $src );
	$b         = new Imagick( $dst );
	$identical = ( 0.0 === $a->compareImages( $b, Imagick::METRIC_ABSOLUTEERRORMETRIC )[1] );
	$a->clear();
	$b->clear();
	iwsl_assert( $identical, 'roundtrip(imagick): WebP-lossless is pixel-for-pixel identical to the PNG' );
} else {
	echo "  [skip] lossless roundtrip — no WebP engine (imagick / gd-webp-lossless) in this PHP\n";
}

// ── 4. Path traversal / symlink escape refused; nothing written ───────────────

iwsl_mo_reset();
$base4        = iwsl_mo_tempdir();
$outside_dir  = iwsl_mo_tempdir(); // a sibling dir, NOT inside $base4
$outside_png  = $outside_dir . '/evil.png';
file_put_contents( $outside_png, iwsl_mo_valid_png( 4, 4 ) );
// (a) attachment whose resolved path is OUTSIDE the base dir.
$GLOBALS['iwsl_mo_attachments'][201] = array( 'path' => $outside_png, 'mime' => 'image/png' );
// (b) a symlink INSIDE the base dir pointing OUT — realpath must catch the escape.
$link = $base4 . '/link.png';
symlink( $outside_png, $link );
$GLOBALS['iwsl_mo_attachments'][202] = array( 'path' => $link, 'mime' => 'image/png' );

$fake4 = new IWSL_Recording_Converter( 0.5 );
$opt4  = new IWSL_Media_Optimizer(
	iwsl_mo_unlocked_entitlements( $NOW ),
	$base4,
	static function () use ( $NOW ): int {
		return $NOW; },
	array( 'webp_lossless' => $fake4 )
);
$r4      = $opt4->run();
$reasons = iwsl_mo_reasons( $r4 );
iwsl_assert_same( 0, $r4['converted'], 'path escape: nothing converted' );
iwsl_assert_same( 2, $r4['refused'], 'path escape: both sources refused' );
iwsl_assert_same( 0, $fake4->convert_calls, 'path escape: convert() NEVER called' );
iwsl_assert( in_array( 'path-escape', $reasons, true ), 'path escape: refused with reason path-escape' );
iwsl_assert( ! is_file( $base4 . '/link-png.webp' ), 'path escape: no derivative written for the symlink' );
iwsl_assert( ! is_file( $outside_dir . '/evil-png.webp' ), 'path escape: no derivative written outside base' );

// ── 5. Decompression bomb + oversize refused BEFORE decode ────────────────────

iwsl_mo_reset();
$base5 = iwsl_mo_tempdir();
// (a) signature + IHDR only, declaring 20000×20000 — no IDAT, never decoded.
$bomb = $base5 . '/bomb.png';
file_put_contents( $bomb, iwsl_mo_png_sig() . iwsl_mo_png_chunk( 'IHDR', iwsl_mo_ihdr( 20000, 20000, 6 ) ) );
$GLOBALS['iwsl_mo_attachments'][301] = array( 'path' => $bomb, 'mime' => 'image/png' );
// (b) a small valid header truncated out to > 25 MB on disk (sparse).
$big = $base5 . '/big.png';
file_put_contents( $big, iwsl_mo_png_sig() . iwsl_mo_png_chunk( 'IHDR', iwsl_mo_ihdr( 10, 10, 6 ) ) );
$fp = fopen( $big, 'r+' );
ftruncate( $fp, 26 * 1024 * 1024 + 1 );
fclose( $fp );
$GLOBALS['iwsl_mo_attachments'][302] = array( 'path' => $big, 'mime' => 'image/png' );

$fake5 = new IWSL_Recording_Converter( 0.5 );
$opt5  = new IWSL_Media_Optimizer(
	iwsl_mo_unlocked_entitlements( $NOW ),
	$base5,
	static function () use ( $NOW ): int {
		return $NOW; },
	array( 'webp_lossless' => $fake5 )
);
$r5       = $opt5->run();
$reasons5 = iwsl_mo_reasons( $r5 );
iwsl_assert_same( 0, $r5['converted'], 'bomb: nothing converted' );
iwsl_assert_same( 0, $fake5->convert_calls, 'bomb: convert() NEVER called (refused pre-decode)' );
iwsl_assert(
	in_array( 'too-many-pixels', $reasons5, true ) || in_array( 'dimension-too-large', $reasons5, true ),
	'bomb: 20000×20000 refused on MAX_PIXELS / MAX_DIMENSION'
);
iwsl_assert( in_array( 'too-large', $reasons5, true ), 'bomb: > 25 MB source refused on MAX_SOURCE_BYTES' );
iwsl_assert( ! is_file( $base5 . '/bomb-png.webp' ), 'bomb: no derivative written for the pixel bomb' );
iwsl_assert( ! is_file( $base5 . '/big-png.webp' ), 'bomb: no derivative written for the oversize source' );

// ── 6. MIME spoof refused (extension is not trusted) ──────────────────────────

iwsl_mo_reset();
$base6 = iwsl_mo_tempdir();
$spoof = $base6 . '/notreally.png';
file_put_contents( $spoof, "this is plain ascii text, not a PNG at all\n" );
$GLOBALS['iwsl_mo_attachments'][401] = array( 'path' => $spoof, 'mime' => 'image/png' );

$fake6 = new IWSL_Recording_Converter( 0.5 );
$opt6  = new IWSL_Media_Optimizer(
	iwsl_mo_unlocked_entitlements( $NOW ),
	$base6,
	static function () use ( $NOW ): int {
		return $NOW; },
	array( 'webp_lossless' => $fake6 )
);
$r6       = $opt6->run();
$reasons6 = iwsl_mo_reasons( $r6 );
iwsl_assert_same( 0, $fake6->convert_calls, 'mime spoof: convert() NEVER called' );
iwsl_assert(
	in_array( 'unreadable-image', $reasons6, true ) || in_array( 'mime-mismatch', $reasons6, true ),
	'mime spoof: a .png-named text file is refused on content sniff'
);
iwsl_assert( ! is_file( $base6 . '/notreally-png.webp' ), 'mime spoof: no derivative written' );

// ── 7. Keep-only-if-smaller + idempotency ─────────────────────────────────────

// (a) converter returns bytes_out >= bytes_in → derivative removed, skipped:no-savings.
iwsl_mo_reset();
$base7a = iwsl_mo_tempdir();
$png7a  = $base7a . '/keep.png';
file_put_contents( $png7a, iwsl_mo_valid_png( 8, 8 ) );
$GLOBALS['iwsl_mo_attachments'][501] = array( 'path' => $png7a, 'mime' => 'image/png' );
$fake_big = new IWSL_Recording_Converter( 2.0 ); // dest 2x source → no savings
$opt7a    = new IWSL_Media_Optimizer(
	iwsl_mo_unlocked_entitlements( $NOW ),
	$base7a,
	static function () use ( $NOW ): int {
		return $NOW; },
	array( 'webp_lossless' => $fake_big )
);
$r7a       = $opt7a->run();
$reasons7a = iwsl_mo_reasons( $r7a );
iwsl_assert_same( 1, $fake_big->convert_calls, 'keep-if-smaller: converter ran once' );
iwsl_assert_same( 0, $r7a['converted'], 'keep-if-smaller: nothing kept (no savings)' );
iwsl_assert_same( 1, $r7a['skipped'], 'keep-if-smaller: one skipped' );
iwsl_assert( in_array( 'no-savings', $reasons7a, true ), 'keep-if-smaller: reason no-savings' );
iwsl_assert( ! is_file( $base7a . '/keep-png.webp' ), 'keep-if-smaller: oversized derivative removed' );
iwsl_assert( ! is_file( $base7a . '/keep-png.webp.iwsltmp' ), 'keep-if-smaller: temp file cleaned up' );

// (b) idempotency: a successful conversion then a second run skips via meta.
iwsl_mo_reset();
$base7b = iwsl_mo_tempdir();
$png7b  = $base7b . '/idem.png';
file_put_contents( $png7b, iwsl_mo_valid_png( 8, 8 ) );
$GLOBALS['iwsl_mo_attachments'][601] = array( 'path' => $png7b, 'mime' => 'image/png' );
$fake_small = new IWSL_Recording_Converter( 0.4 );
$opt7b      = new IWSL_Media_Optimizer(
	iwsl_mo_unlocked_entitlements( $NOW ),
	$base7b,
	static function () use ( $NOW ): int {
		return $NOW; },
	array( 'webp_lossless' => $fake_small )
);
$r7b1 = $opt7b->run();
iwsl_assert_same( 1, $r7b1['converted'], 'idempotency: first run converts' );
iwsl_assert_same( 1, $fake_small->convert_calls, 'idempotency: converter ran once on the first run' );
iwsl_assert( is_file( $base7b . '/idem-png.webp' ), 'idempotency: derivative present after the first run' );

$r7b2       = $opt7b->run();
$reasons7b2 = iwsl_mo_reasons( $r7b2 );
iwsl_assert_same( 0, $r7b2['converted'], 'idempotency: second run converts nothing' );
iwsl_assert_same( 1, $r7b2['skipped'], 'idempotency: second run skips the up-to-date derivative' );
iwsl_assert_same( 1, $fake_small->convert_calls, 'idempotency: converter NOT called again (skipped via meta)' );
iwsl_assert( in_array( 'already-current', $reasons7b2, true ), 'idempotency: reason already-current' );

// ── 8. Registry + capabilities sanity ─────────────────────────────────────────

$registry = IWSL_Media_Optimizer::converters();
iwsl_assert( array_key_exists( 'webp_lossless', $registry ), 'registry: webp_lossless is registered' );
iwsl_assert( $registry['webp_lossless'] instanceof IWSL_Media_Converter, 'registry: entry implements IWSL_Media_Converter' );
iwsl_assert_same( array( 'image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/tiff' ), $registry['webp_lossless']->accepts(), 'webp_lossless accepts the full smart-WebP source set' );
iwsl_assert_same( array( 'image/png', 'image/gif', 'image/bmp', 'image/tiff' ), IWSL_WebP_Lossless_Converter::lossless_mimes(), 'lossless_mimes excludes JPEG (JPEG uses quality WebP)' );
iwsl_assert_same( 'webp_lossless', $registry['webp_lossless']->id(), 'webp_lossless id shape is stable' );

// Unknown converter id is refused without any conversion (gate already unlocked).
iwsl_mo_reset();
$optU = new IWSL_Media_Optimizer(
	iwsl_mo_unlocked_entitlements( $NOW ),
	iwsl_mo_tempdir(),
	static function () use ( $NOW ): int {
		return $NOW; }
);
$rU = $optU->run( 'does_not_exist' );
iwsl_assert_same( 'unknown-converter', $rU['reason'], 'unknown converter id → refused unknown-converter' );

// ── 9. COPY mode registers the WebP as a Media Library attachment ─────────────
//
// Stubs for the attachment layer are declared HERE (not at the top) so every
// section above still exercises the no-WP path where wp_insert_attachment is
// absent — this section is the only one that proves the registration + idempotent
// self-heal behaviour.

$GLOBALS['iwsl_mo_next_id'] = 900;
if ( ! function_exists( 'wp_insert_attachment' ) ) {
	function wp_insert_attachment( array $args, $file = false, $parent = 0, $wp_error = false ) {
		$id                                    = ++$GLOBALS['iwsl_mo_next_id'];
		$GLOBALS['iwsl_mo_attachments'][ $id ] = array(
			'path' => (string) $file,
			'mime' => isset( $args['post_mime_type'] ) ? (string) $args['post_mime_type'] : '',
		);
		return $id;
	}
}
if ( ! function_exists( 'get_post' ) ) {
	function get_post( int $id ) {
		return isset( $GLOBALS['iwsl_mo_attachments'][ $id ] )
			? (object) array( 'ID' => $id, 'post_type' => 'attachment' )
			: null;
	}
}
if ( ! function_exists( 'get_post_field' ) ) {
	function get_post_field( string $field, int $id ) {
		return 0;
	}
}
if ( ! function_exists( 'wp_generate_attachment_metadata' ) ) {
	function wp_generate_attachment_metadata( int $id, string $file ) {
		return array();
	}
}
if ( ! function_exists( 'wp_update_attachment_metadata' ) ) {
	function wp_update_attachment_metadata( int $id, $data ) {
		return true;
	}
}
if ( ! function_exists( 'is_wp_error' ) ) {
	function is_wp_error( $thing ) {
		return false;
	}
}

// (a) a fresh conversion registers a new webp attachment and records its id.
iwsl_mo_reset();
$base9 = iwsl_mo_tempdir();
$png9  = $base9 . '/reg.png';
file_put_contents( $png9, iwsl_mo_valid_png( 8, 8 ) );
$GLOBALS['iwsl_mo_attachments'][701] = array( 'path' => $png9, 'mime' => 'image/png' );
$fake9                               = new IWSL_Recording_Converter( 0.4 );
$opt9                                = new IWSL_Media_Optimizer(
	iwsl_mo_unlocked_entitlements( $NOW ),
	$base9,
	static function () use ( $NOW ): int {
		return $NOW; },
	array( 'webp_lossless' => $fake9 )
);
$r9   = $opt9->run( 'webp_lossless', 200, 'copy' );
$copy = $r9['items'][0]['copy_id'] ?? 0;
iwsl_assert_same( 1, $r9['converted'], 'copy-register: image converted' );
iwsl_assert( $copy > 0, 'copy-register: a copy attachment id is reported' );
iwsl_assert( isset( $GLOBALS['iwsl_mo_attachments'][ $copy ] ), 'copy-register: the copy exists in the media registry' );
iwsl_assert_same( 'image/webp', $GLOBALS['iwsl_mo_attachments'][ $copy ]['mime'], 'copy-register: copy MIME is image/webp' );
iwsl_assert_same( $base9 . '/reg-png.webp', $GLOBALS['iwsl_mo_attachments'][ $copy ]['path'], 'copy-register: copy points at the derivative file' );
iwsl_assert_same( $copy, (int) $GLOBALS['iwsl_mo_meta'][701]['_iwsl_media_optimizer']['copy_id'], 'copy-register: copy_id persisted on the source meta' );

// (b) idempotency: a second copy run reuses the existing copy — NO duplicate.
$before = count( $GLOBALS['iwsl_mo_attachments'] );
$r9b    = $opt9->run( 'webp_lossless', 200, 'copy' );
iwsl_assert_same( 'already-current', $r9b['items'][0]['reason'], 'copy-register: second run is already-current' );
iwsl_assert_same( $copy, (int) ( $r9b['items'][0]['copy_id'] ?? 0 ), 'copy-register: second run reuses the same copy id' );
iwsl_assert_same( $before, count( $GLOBALS['iwsl_mo_attachments'] ), 'copy-register: no duplicate attachment created on re-run' );

// (c) self-heal: a derivative on disk whose copy attachment was deleted is
// re-registered on the next run (models an orphan from a pre-fix conversion).
unset( $GLOBALS['iwsl_mo_attachments'][ $copy ] );          // copy attachment gone
$GLOBALS['iwsl_mo_meta'][701]['_iwsl_media_optimizer']['copy_id'] = $copy; // stale id
iwsl_assert( is_file( $base9 . '/reg-png.webp' ), 'copy-register: derivative still on disk (orphan)' );
$r9c     = $opt9->run( 'webp_lossless', 200, 'copy' );
$healed  = $r9c['items'][0]['copy_id'] ?? 0;
iwsl_assert( $healed > 0 && $healed !== $copy, 'copy-register: self-heal re-registers the orphan under a new id' );
iwsl_assert( isset( $GLOBALS['iwsl_mo_attachments'][ $healed ] ), 'copy-register: healed copy is back in the media registry' );

// ── 10. Rewrite page references + remove optimized duplicates ─────────────────
//
// Extra WP stubs (URL/metadata/delete + a tiny $wpdb) declared HERE so the
// sections above keep exercising the no-WP path. These prove the copy-mode
// companions: repoint page <img> URLs to the WebP, and delete originals that
// already have an optimized copy.

$GLOBALS['iwsl_mo_urls']    = array(); // id => full attachment URL
$GLOBALS['iwsl_mo_attmeta'] = array(); // id => attachment metadata (sizes[])
$GLOBALS['iwsl_mo_posts']   = array(); // id => post_content

if ( ! function_exists( 'wp_get_attachment_url' ) ) {
	function wp_get_attachment_url( int $id ) {
		return $GLOBALS['iwsl_mo_urls'][ $id ] ?? '';
	}
}
if ( ! function_exists( 'wp_get_attachment_metadata' ) ) {
	function wp_get_attachment_metadata( int $id ) {
		return $GLOBALS['iwsl_mo_attmeta'][ $id ] ?? array();
	}
}
if ( ! function_exists( 'wp_delete_attachment' ) ) {
	function wp_delete_attachment( int $id, bool $force = false ) {
		if ( ! isset( $GLOBALS['iwsl_mo_attachments'][ $id ] ) ) {
			return false;
		}
		unset(
			$GLOBALS['iwsl_mo_attachments'][ $id ],
			$GLOBALS['iwsl_mo_meta'][ $id ],
			$GLOBALS['iwsl_mo_urls'][ $id ],
			$GLOBALS['iwsl_mo_attmeta'][ $id ]
		);
		return (object) array( 'ID' => $id );
	}
}
if ( ! function_exists( 'clean_post_cache' ) ) {
	function clean_post_cache( int $id ) {}
}
if ( ! class_exists( 'IWSL_Fake_WPDB' ) ) {
	final class IWSL_Fake_WPDB {
		public $posts = 'wp_posts';
		public function esc_like( $s ) {
			return addcslashes( (string) $s, '_%\\' );
		}
		public function prepare( $q, ...$args ) {
			foreach ( $args as $a ) {
				$rep = is_int( $a ) ? (string) (int) $a : "'" . str_replace( "'", "''", (string) $a ) . "'";
				$q   = preg_replace( '/%[sd]/', $rep, $q, 1 );
			}
			return $q;
		}
		public function get_results( $q ) {
			$out = array();
			foreach ( $GLOBALS['iwsl_mo_posts'] as $id => $content ) {
				$out[] = (object) array( 'ID' => $id, 'post_content' => $content );
			}
			return $out;
		}
		public function update( $table, $data, $where ) {
			$GLOBALS['iwsl_mo_posts'][ (int) $where['ID'] ] = (string) $data['post_content'];
			return 1;
		}
	}
}
$GLOBALS['wpdb'] = new IWSL_Fake_WPDB();

// (a) rewrite_post_references: full-size + shared sub-size URLs flip to the WebP.
iwsl_mo_reset();
$GLOBALS['iwsl_mo_urls']    = array();
$GLOBALS['iwsl_mo_attmeta'] = array();
$GLOBALS['iwsl_mo_posts']   = array();
$base10                          = iwsl_mo_tempdir();
$GLOBALS['iwsl_mo_attachments'][801] = array( 'path' => $base10 . '/hero.png', 'mime' => 'image/png' );
$GLOBALS['iwsl_mo_attachments'][802] = array( 'path' => $base10 . '/hero.webp', 'mime' => 'image/webp' );
$GLOBALS['iwsl_mo_urls'][801]    = 'http://site/u/hero.png';
$GLOBALS['iwsl_mo_urls'][802]    = 'http://site/u/hero.webp';
$GLOBALS['iwsl_mo_attmeta'][801] = array( 'sizes' => array( 'medium' => array( 'file' => 'hero-300x200.png', 'width' => 300, 'height' => 200 ) ) );
$GLOBALS['iwsl_mo_attmeta'][802] = array( 'sizes' => array( 'medium' => array( 'file' => 'hero-300x200.webp', 'width' => 300, 'height' => 200 ) ) );
$GLOBALS['iwsl_mo_posts'][1]     = '<img src="http://site/u/hero-300x200.png" srcset="http://site/u/hero.png 400w, http://site/u/hero-300x200.png 300w">';

$opt10 = new IWSL_Media_Optimizer(
	iwsl_mo_unlocked_entitlements( $NOW ),
	$base10,
	static function () use ( $NOW ): int {
		return $NOW; },
	array( 'webp_lossless' => new IWSL_Recording_Converter( 0.4 ) )
);
$rw = new ReflectionMethod( 'IWSL_Media_Optimizer', 'rewrite_post_references' );
$rw->setAccessible( true );
$posts_changed = $rw->invoke( $opt10, 801, 802, 500 );
iwsl_assert_same( 1, $posts_changed, 'rewrite: one post updated' );
iwsl_assert( false === strpos( $GLOBALS['iwsl_mo_posts'][1], '.png' ), 'rewrite: no .png URL remains in the post' );
iwsl_assert( false !== strpos( $GLOBALS['iwsl_mo_posts'][1], 'hero.webp' ), 'rewrite: full-size URL flipped to WebP' );
iwsl_assert( false !== strpos( $GLOBALS['iwsl_mo_posts'][1], 'hero-300x200.webp' ), 'rewrite: sub-size srcset URL flipped to WebP' );

// (b) remove_optimized_duplicates: original with a live copy is deleted; the
//     WebP copy survives; page references are repointed first.
iwsl_mo_reset();
$GLOBALS['iwsl_mo_urls']    = array();
$GLOBALS['iwsl_mo_attmeta'] = array();
$GLOBALS['iwsl_mo_posts']   = array();
$base11 = iwsl_mo_tempdir();
file_put_contents( $base11 . '/pic.png', iwsl_mo_valid_png( 8, 8 ) );
// The optimized copy lives at derivative_path(pic.png) = pic-png.webp (ext folded
// into the name), which is what remove_optimized_duplicates reconstructs + matches.
file_put_contents( $base11 . '/pic-png.webp', str_repeat( 'w', 128 ) );
$GLOBALS['iwsl_mo_attachments'][811] = array( 'path' => $base11 . '/pic.png', 'mime' => 'image/png' );
$GLOBALS['iwsl_mo_attachments'][812] = array( 'path' => $base11 . '/pic-png.webp', 'mime' => 'image/webp' );
$GLOBALS['iwsl_mo_meta'][811]['_iwsl_media_optimizer'] = array(
	'converter' => 'webp_lossless', 'source_size' => 100, 'source_mtime' => 1, 'copy_id' => 812,
);
$GLOBALS['iwsl_mo_urls'][811]    = 'http://site/u/pic.png';
$GLOBALS['iwsl_mo_urls'][812]    = 'http://site/u/pic.webp';
$GLOBALS['iwsl_mo_posts'][2]     = '<img src="http://site/u/pic.png">';

$opt11 = new IWSL_Media_Optimizer(
	iwsl_mo_unlocked_entitlements( $NOW ),
	$base11,
	static function () use ( $NOW ): int {
		return $NOW; },
	array( 'webp_lossless' => new IWSL_Recording_Converter( 0.4 ) )
);
// Dry run first — counts, deletes nothing.
$dd_dry = $opt11->remove_optimized_duplicates( true, true );
iwsl_assert_same( 1, $dd_dry['removed'], 'dedupe(dry): one original would be removed' );
iwsl_assert( isset( $GLOBALS['iwsl_mo_attachments'][811] ), 'dedupe(dry): original still present' );

// Live run — rewrites the page, deletes the original, keeps the WebP.
$dd = $opt11->remove_optimized_duplicates( false, true );
iwsl_assert_same( 1, $dd['removed'], 'dedupe: one original removed' );
iwsl_assert( ! isset( $GLOBALS['iwsl_mo_attachments'][811] ), 'dedupe: original attachment deleted' );
iwsl_assert( isset( $GLOBALS['iwsl_mo_attachments'][812] ), 'dedupe: WebP copy survives' );
iwsl_assert_same( 1, $dd['rewrote_posts'], 'dedupe: page reference repointed before delete' );
iwsl_assert( false !== strpos( $GLOBALS['iwsl_mo_posts'][2], 'pic.webp' ), 'dedupe: post now points at the WebP' );

// (c) an attachment with NO optimized copy is skipped, never deleted.
iwsl_mo_reset();
$GLOBALS['iwsl_mo_posts'] = array();
$base12 = iwsl_mo_tempdir();
file_put_contents( $base12 . '/lonely.png', iwsl_mo_valid_png( 4, 4 ) );
$GLOBALS['iwsl_mo_attachments'][821] = array( 'path' => $base12 . '/lonely.png', 'mime' => 'image/png' );
$opt12 = new IWSL_Media_Optimizer(
	iwsl_mo_unlocked_entitlements( $NOW ),
	$base12,
	static function () use ( $NOW ): int {
		return $NOW; },
	array( 'webp_lossless' => new IWSL_Recording_Converter( 0.4 ) )
);
$dd2 = $opt12->remove_optimized_duplicates( false, true );
iwsl_assert_same( 0, $dd2['removed'], 'dedupe: nothing removed without an optimized copy' );
iwsl_assert( isset( $GLOBALS['iwsl_mo_attachments'][821] ), 'dedupe: un-optimized original left intact' );

// (d) gate blocks dedupe for a locked site — no deletion path runs.
iwsl_mo_reset();
$store_dd = new IWSL_Memory_Store();
$store_dd->set( 'state', 'active' );
$store_dd->set( 'last_verified_at', $NOW - 60000 );
$store_dd->set( 'entitlements', array( 'plus' => true ) ); // image_optimization absent
$ent_dd = new IWSL_Entitlements( $store_dd, static function () use ( $NOW ): int {
	return $NOW; } );
$opt_dd = new IWSL_Media_Optimizer( $ent_dd, iwsl_mo_tempdir(), static function () use ( $NOW ): int {
	return $NOW; }, array( 'webp_lossless' => new IWSL_Recording_Converter( 0.4 ) ) );
$dd_locked = $opt_dd->remove_optimized_duplicates( false, true );
iwsl_assert_same( false, $dd_locked['ok'], 'dedupe: locked gate refuses' );
iwsl_assert_same( 'entitlement-locked', $dd_locked['reason'], 'dedupe: reason entitlement-locked' );

// ── 11. Stem-collision fix: distinct derivative per source extension ──────────
//
// Regression: derivative_path() used to map every accepted source to <stem>.webp,
// so two originals sharing a stem but differing by extension (logo.png + logo.jpg,
// both accepted by webp_lossless) collided onto ONE derivative — the 2nd run's
// atomic rename overwrote the 1st, and two copy attachments could point at one
// file. The fix folds the extension into the name (logo.png → logo-png.webp,
// logo.jpg → logo-jpg.webp) so each source maps to its own dest, while staying
// deterministic so idempotency (is_current / existing_copy_id) still round-trips.

iwsl_mo_reset();
$GLOBALS['iwsl_mo_urls']    = array();
$GLOBALS['iwsl_mo_attmeta'] = array();
$GLOBALS['iwsl_mo_posts']   = array();
$base13 = iwsl_mo_tempdir();

$opt13 = new IWSL_Media_Optimizer(
	iwsl_mo_unlocked_entitlements( $NOW ),
	$base13,
	static function () use ( $NOW ): int {
		return $NOW; },
	array( 'webp_lossless' => new IWSL_Recording_Converter( 0.4 ) )
);

// (a) derivative_path() maps same-stem/different-extension sources to DISTINCT,
//     contained .webp dests — and is deterministic on re-resolve.
$dp = new ReflectionMethod( 'IWSL_Media_Optimizer', 'derivative_path' );
$dp->setAccessible( true );
$dest_png = $dp->invoke( $opt13, $base13 . '/logo.png' );
$dest_jpg = $dp->invoke( $opt13, $base13 . '/logo.jpg' );
$base_prefix = rtrim( $base13, '/' ) . '/';
iwsl_assert( '' !== $dest_png && '' !== $dest_jpg, 'stem-collision: both derivative paths resolve (dest dir inside base)' );
iwsl_assert( $dest_png !== $dest_jpg, 'stem-collision: same stem, different extension → DIFFERENT derivative paths' );
iwsl_assert_same( '.webp', substr( $dest_png, -5 ), 'stem-collision: png derivative ends .webp' );
iwsl_assert_same( '.webp', substr( $dest_jpg, -5 ), 'stem-collision: jpg derivative ends .webp' );
iwsl_assert( 0 === strpos( $dest_png, $base_prefix ), 'stem-collision: png derivative stays inside the uploads base' );
iwsl_assert( 0 === strpos( $dest_jpg, $base_prefix ), 'stem-collision: jpg derivative stays inside the uploads base' );
iwsl_assert_same( $dest_png, $dp->invoke( $opt13, $base13 . '/logo.png' ), 'stem-collision: re-resolving the same source yields the SAME derivative (deterministic)' );

// (b) end-to-end idempotency with the ext-folded name: a copy run of logo.png
//     registers one copy at logo-png.webp; re-running is already-current, reuses
//     the same copy id, and creates NO duplicate attachment.
$png13 = $base13 . '/logo.png';
file_put_contents( $png13, iwsl_mo_valid_png( 8, 8 ) );
$GLOBALS['iwsl_mo_attachments'][ 851 ] = array( 'path' => $png13, 'mime' => 'image/png' );
$r13a = $opt13->run( 'webp_lossless', 200, 'copy' );
$copy13 = $r13a['items'][0]['copy_id'] ?? 0;
iwsl_assert_same( 1, $r13a['converted'], 'stem-collision: logo.png copy run converts' );
iwsl_assert( is_file( $base13 . '/logo-png.webp' ), 'stem-collision: derivative written at the ext-folded path' );
iwsl_assert( $copy13 > 0, 'stem-collision: a copy attachment id is reported' );
iwsl_assert_same( $base13 . '/logo-png.webp', $GLOBALS['iwsl_mo_attachments'][ $copy13 ]['path'], 'stem-collision: copy attachment points at the ext-folded derivative' );

$attach_before = count( $GLOBALS['iwsl_mo_attachments'] );
$r13b = $opt13->run( 'webp_lossless', 200, 'copy' );
iwsl_assert_same( 'already-current', $r13b['items'][0]['reason'], 'stem-collision: re-run of the same source is already-current (idempotent)' );
iwsl_assert_same( $copy13, (int) ( $r13b['items'][0]['copy_id'] ?? 0 ), 'stem-collision: re-run reuses the same copy id' );
iwsl_assert_same( $attach_before, count( $GLOBALS['iwsl_mo_attachments'] ), 'stem-collision: re-run creates NO duplicate copy attachment' );

// This suite is the only one that installs a global $wpdb; other suites bring
// their own recording fake. Remove it so it never leaks across the shared runner.
unset( $GLOBALS['wpdb'] );
