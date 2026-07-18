<?php
/**
 * SLH-DSA-SHA2-192f verification profile (FIPS 205 Table 2 fast-signing set).
 *
 * Same 192-bit SHA-2 hash primitives as IWSL_SLHDSA (192s) — F/PRF on SHA-256,
 * H/T_l/H_msg on SHA-512, n=24, compressed 22-byte ADRSc — so only the tree
 * parameters and the derived message-digest split differ. All verification
 * logic is inherited from IWSL_SLHDSA and reads these constants via
 * late-static-binding (static::).
 *
 * FIPS 205 Table 2: n=24, h=66, d=22, h'=3, a=8, k=33, lg w=4, m=42;
 * publicKey=48, signature=35664. Verify chosen for its cheap verify + ~30×
 * faster IW-side signing than 192s (the whole point of the migration).
 */
final class IWSL_SLHDSA_192f extends IWSL_SLHDSA {

	const H_TOTAL  = 66;
	const D        = 22;
	const HP       = 3;
	const A        = 8;
	const K        = 33;

	// Digest split for this set:
	//   MD_BYTES      = ceil(K*A/8)        = ceil(33*8/8)      = 33
	//   IDX_TREE_BITS = H_TOTAL - HP       = 66 - 3            = 63  → 8 bytes
	//   IDX_LEAF_BYTES= ceil(HP/8)         = ceil(3/8)         = 1
	const MD_BYTES        = 33;
	const IDX_TREE_BITS   = 63;
	const IDX_TREE_BYTES  = 8;
	const IDX_LEAF_BYTES  = 1;
	const MSG_DIGEST_BYTES = 42; // 33 + 8 + 1

	const SIG_BYTES = 35664; // n + k(1+a)n + (h + d*len)n
	// N, W, LOG_W, WOTS_LEN*, PK_BYTES, ADRS_* are identical to 192s (inherited).
}
