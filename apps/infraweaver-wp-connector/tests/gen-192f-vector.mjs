// Emits tests/fixtures/slhdsa-192f-vector.json — a deterministic SLH-DSA-SHA2-192f
// known-answer vector for the pure-PHP IWSL_SLHDSA_192f verify test. Produced by
// @noble/post-quantum (the same KAT-backed lib whose 192s vectors the existing
// PHP verifier is cross-checked against), using the exact call convention the
// console's crypto.ts uses — sign(msg, secretKey), pure empty-context path.
//
//   cd apps/infraweaver-console && node ../infraweaver-wp-connector/tests/gen-192f-vector.mjs
//
// Deterministic (fixed seed + extraEntropy:false) so the checked-in vector is
// reproducible. TEST VECTOR ONLY — never reuse this seed.

// Absolute path into the console's node_modules — ESM resolves relative to THIS
// file's directory (the wp-connector, which has no node_modules), so we point at
// the console workspace where @noble/post-quantum is installed.
import { slh_dsa_sha2_192f } from "../../infraweaver-console/node_modules/@noble/post-quantum/slh-dsa.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const seed = new Uint8Array(72).fill(0x5a); // 3n = 72 bytes for n=24
const { secretKey, publicKey } = slh_dsa_sha2_192f.keygen(seed);

const msg = new TextEncoder().encode("iwsl-192f-reenroll-known-answer-vector");
const sig = slh_dsa_sha2_192f.sign(msg, secretKey, { extraEntropy: false });

const b64 = (u) => Buffer.from(u).toString("base64");

const vector = {
  generated_by: "apps/infraweaver-wp-connector/tests/gen-192f-vector.mjs",
  alg: "slh-dsa-192f",
  sig_bytes: sig.length,
  pk_bytes: publicKey.length,
  msg_b64: b64(msg),
  sig_b64: b64(sig),
  pk_b64: b64(publicKey),
};

// Self-check before writing: the producer must agree it is a valid signature.
if (!slh_dsa_sha2_192f.verify(sig, msg, publicKey)) {
  process.stderr.write("FATAL: noble failed to verify its own signature\n");
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "slhdsa-192f-vector.json"), `${JSON.stringify(vector, null, 1)}\n`);
process.stderr.write(`192f vector written (sig ${sig.length}B, pk ${publicKey.length}B)\n`);
