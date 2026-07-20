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
iwsl_assert( is_file( $dir2 . '/photo.webp' ), 'unlock: derivative written alongside the original' );
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
iwsl_assert( ! is_file( $base4 . '/link.webp' ), 'path escape: no derivative written for the symlink' );
iwsl_assert( ! is_file( $outside_dir . '/evil.webp' ), 'path escape: no derivative written outside base' );

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
iwsl_assert( ! is_file( $base5 . '/bomb.webp' ), 'bomb: no derivative written for the pixel bomb' );
iwsl_assert( ! is_file( $base5 . '/big.webp' ), 'bomb: no derivative written for the oversize source' );

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
iwsl_assert( ! is_file( $base6 . '/notreally.webp' ), 'mime spoof: no derivative written' );

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
iwsl_assert( ! is_file( $base7a . '/keep.webp' ), 'keep-if-smaller: oversized derivative removed' );
iwsl_assert( ! is_file( $base7a . '/keep.webp.iwsltmp' ), 'keep-if-smaller: temp file cleaned up' );

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
iwsl_assert( is_file( $base7b . '/idem.webp' ), 'idempotency: derivative present after the first run' );

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
iwsl_assert_same( array( 'image/png' ), $registry['webp_lossless']->accepts(), 'webp_lossless accepts image/png ONLY (JPEG excluded)' );
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
