<?php
/**
 * Pure-PHP SLH-DSA-SHA2-192s signature VERIFICATION (FIPS 205).
 *
 * Verify-only by design: the Connector never signs post-quantum (IWSL v1.2 —
 * commands are dual-signed by InfraWeaver, responses are Ed25519-only). SHA2
 * category-3 parameter set: F/PRF on SHA-256, H/T_l/H_msg on SHA-512,
 * compressed 22-byte addresses (FIPS 205 §11.2).
 *
 * Cross-checked against @noble/post-quantum fixtures (tests/fixtures/).
 * Requires 64-bit PHP (tree indices reach 2^54).
 */

final class IWSL_SLHDSA {

	const N        = 24;    // hash output bytes
	const H_TOTAL  = 63;    // total tree height
	const D        = 7;     // hypertree layers
	const HP       = 9;     // per-layer subtree height (h')
	const A        = 14;    // FORS tree height
	const K        = 17;    // FORS tree count
	const LOG_W    = 4;     // Winternitz log2(w)
	const W        = 16;
	const WOTS_LEN1 = 48;   // 2n hex digits
	const WOTS_LEN2 = 3;
	const WOTS_LEN  = 51;
	const MSG_DIGEST_BYTES = 39; // m = 30 (md) + 7 (idx_tree) + 2 (idx_leaf)

	const PK_BYTES  = 48;
	const SIG_BYTES = 16224; // n + k(1+a)n + (h + d*len)n

	// ADRS type constants (FIPS 205 §4.2).
	const ADRS_WOTS_HASH  = 0;
	const ADRS_WOTS_PK    = 1;
	const ADRS_TREE       = 2;
	const ADRS_FORS_TREE  = 3;
	const ADRS_FORS_ROOTS = 4;

	/** @var string PK.seed padded to the SHA-256 block (64 bytes). */
	private $seed_pad_256;

	/** @var string PK.seed padded to the SHA-512 block (128 bytes). */
	private $seed_pad_512;

	private function __construct( string $pk_seed ) {
		$this->seed_pad_256 = $pk_seed . str_repeat( "\x00", 64 - self::N );
		$this->seed_pad_512 = $pk_seed . str_repeat( "\x00", 128 - self::N );
	}

	/**
	 * Verify a pure SLH-DSA signature (empty context string, no prehash).
	 *
	 * @param string $signature Raw signature bytes (16 224).
	 * @param string $message   Raw message bytes.
	 * @param string $public_key Raw public key bytes (48).
	 */
	public static function verify( string $signature, string $message, string $public_key ): bool {
		if ( PHP_INT_SIZE < 8 ) {
			return false; // 32-bit PHP cannot hold 2^54 tree indices — fail closed.
		}
		if ( strlen( $signature ) !== self::SIG_BYTES || strlen( $public_key ) !== self::PK_BYTES ) {
			return false;
		}

		$pk_seed = substr( $public_key, 0, self::N );
		$pk_root = substr( $public_key, self::N, self::N );
		$self    = new self( $pk_seed );

		// FIPS 205 §10.2: M' = toByte(0,1) || toByte(|ctx|,1) || ctx || M, ctx = "".
		$m_prime = "\x00\x00" . $message;

		$r = substr( $signature, 0, self::N );

		// H_msg (§11.2.2): MGF1-SHA-512(R || PK.seed || SHA-512(R || PK || M'), m).
		$inner  = hash( 'sha512', $r . $public_key . $m_prime, true );
		$digest = self::mgf1_sha512( $r . $pk_seed . $inner, self::MSG_DIGEST_BYTES );

		$md       = substr( $digest, 0, 30 );
		$idx_tree = self::bytes_to_int( substr( $digest, 30, 7 ) ) & ( ( 1 << 54 ) - 1 );
		$idx_leaf = self::bytes_to_int( substr( $digest, 37, 2 ) ) & ( ( 1 << self::HP ) - 1 );

		$offset = self::N;

		// ---- FORS: recover the FORS public key from the signature. ----
		$indices = self::base_2b( $md, self::A, self::K );
		$roots   = '';
		for ( $i = 0; $i < self::K; $i++ ) {
			$sk = substr( $signature, $offset, self::N );
			$offset += self::N;
			$auth = substr( $signature, $offset, self::A * self::N );
			$offset += self::A * self::N;

			$tree_index = ( $i << self::A ) + $indices[ $i ];
			$adrs       = self::adrs( 0, $idx_tree, self::ADRS_FORS_TREE, $idx_leaf, 0, $tree_index );
			$node       = $self->f( $adrs, $sk );
			$roots     .= $self->compute_root( $node, $tree_index, $auth, self::A, 0, $idx_tree, self::ADRS_FORS_TREE, $idx_leaf );
		}
		$fors_pk_adrs = self::adrs( 0, $idx_tree, self::ADRS_FORS_ROOTS, $idx_leaf, 0, 0 );
		$node         = $self->t_n( $fors_pk_adrs, $roots );

		// ---- Hypertree: d layers of WOTS+ + XMSS auth paths. ----
		for ( $layer = 0; $layer < self::D; $layer++ ) {
			$wots_sig = substr( $signature, $offset, self::WOTS_LEN * self::N );
			$offset  += self::WOTS_LEN * self::N;
			$auth     = substr( $signature, $offset, self::HP * self::N );
			$offset  += self::HP * self::N;

			$wots_pk = '';
			$lengths = self::chain_lengths( $node );
			for ( $c = 0; $c < self::WOTS_LEN; $c++ ) {
				$tmp   = substr( $wots_sig, $c * self::N, self::N );
				$start = $lengths[ $c ];
				for ( $j = $start; $j < self::W - 1; $j++ ) {
					$adrs = self::adrs( $layer, $idx_tree, self::ADRS_WOTS_HASH, $idx_leaf, $c, $j );
					$tmp  = $self->f( $adrs, $tmp );
				}
				$wots_pk .= $tmp;
			}
			$wots_pk_adrs = self::adrs( $layer, $idx_tree, self::ADRS_WOTS_PK, $idx_leaf, 0, 0 );
			$leaf         = $self->t_n( $wots_pk_adrs, $wots_pk );

			$node = $self->compute_root( $leaf, $idx_leaf, $auth, self::HP, $layer, $idx_tree, self::ADRS_TREE, 0 );

			$idx_leaf = $idx_tree & ( ( 1 << self::HP ) - 1 );
			$idx_tree = $idx_tree >> self::HP;
		}

		return hash_equals( $pk_root, $node );
	}

	/**
	 * Merkle auth-path walk shared by FORS ($kp = idx_leaf) and XMSS ($kp = 0
	 * unused → keypair only set for FORS type).
	 */
	private function compute_root( string $node, int $tree_index, string $auth, int $height, int $layer, int $tree, int $type, int $keypair ): string {
		for ( $h = 0; $h < $height; $h++ ) {
			$sibling    = substr( $auth, $h * self::N, self::N );
			$odd        = $tree_index & 1;
			$tree_index = $tree_index >> 1;
			$adrs       = self::adrs( $layer, $tree, $type, $keypair, $h + 1, $tree_index );
			$node       = $odd === 0
				? $this->h2( $adrs, $node . $sibling )
				: $this->h2( $adrs, $sibling . $node );
		}
		return $node;
	}

	/** WOTS+ chain start positions for a message: base-w digits + checksum digits. */
	private static function chain_lengths( string $msg ): array {
		$w1   = self::base_2b( $msg, self::LOG_W, self::WOTS_LEN1 );
		$csum = 0;
		foreach ( $w1 as $digit ) {
			$csum += self::W - 1 - $digit;
		}
		// csum <<= (8 − ((len2·lg(w)) mod 8)) mod 8  → 4 for this parameter set.
		$csum <<= ( 8 - ( ( self::WOTS_LEN2 * self::LOG_W ) % 8 ) ) % 8;
		$w2 = self::base_2b( pack( 'n', $csum ), self::LOG_W, self::WOTS_LEN2 );
		return array_merge( $w1, $w2 );
	}

	/** F — single-block tweakable hash, SHA-256 lane (§11.2.1). */
	private function f( string $adrs, string $block ): string {
		return substr( hash( 'sha256', $this->seed_pad_256 . $adrs . $block, true ), 0, self::N );
	}

	/** H — two-block tweakable hash, SHA-512 lane. */
	private function h2( string $adrs, string $blocks ): string {
		return substr( hash( 'sha512', $this->seed_pad_512 . $adrs . $blocks, true ), 0, self::N );
	}

	/** T_l — multi-block compression, SHA-512 lane. */
	private function t_n( string $adrs, string $blocks ): string {
		return substr( hash( 'sha512', $this->seed_pad_512 . $adrs . $blocks, true ), 0, self::N );
	}

	/**
	 * Compressed ADRSc (§11.2, 22 bytes):
	 * layer(1) || tree(8, BE) || type(1) || word1(4) || word2(4) || word3(4).
	 * word1 = keypair, word2 = chain (WOTS) / height (trees), word3 = hash / index.
	 */
	private static function adrs( int $layer, int $tree, int $type, int $word1, int $word2, int $word3 ): string {
		return chr( $layer ) . pack( 'J', $tree ) . chr( $type ) . pack( 'NNN', $word1, $word2, $word3 );
	}

	/** MGF1 with SHA-512 (RFC 8017 B.2.1). */
	private static function mgf1_sha512( string $seed, int $length ): string {
		$out = '';
		for ( $counter = 0; strlen( $out ) < $length; $counter++ ) {
			$out .= hash( 'sha512', $seed . pack( 'N', $counter ), true );
		}
		return substr( $out, 0, $length );
	}

	/** base_2b (FIPS 205 Algorithm 4): big-endian bit stream → $count values of $bits bits. */
	private static function base_2b( string $bytes, int $bits, int $count ): array {
		$out   = array();
		$acc   = 0;
		$avail = 0;
		$pos   = 0;
		for ( $i = 0; $i < $count; $i++ ) {
			while ( $avail < $bits ) {
				$acc   = ( $acc << 8 ) | ord( $bytes[ $pos ] );
				$pos  += 1;
				$avail += 8;
			}
			$avail -= $bits;
			$out[]  = ( $acc >> $avail ) & ( ( 1 << $bits ) - 1 );
			$acc   &= ( 1 << $avail ) - 1;
		}
		return $out;
	}

	/** Big-endian bytes → int (max 7 bytes — fits PHP 64-bit). */
	private static function bytes_to_int( string $bytes ): int {
		$value = 0;
		$len   = strlen( $bytes );
		for ( $i = 0; $i < $len; $i++ ) {
			$value = ( $value << 8 ) | ord( $bytes[ $i ] );
		}
		return $value;
	}
}
