import "server-only";
import { makeCoreApi } from "@/lib/kube-client";
import {
  fromB64u,
  generateIwKeyPair,
  iwPublicKeys,
  toB64u,
  type IwKeyPair,
  type IwPublicKeys,
} from "@/lib/iwsl";
import { isK8sNotFound } from "./k8s-errors";

/**
 * INTERIM IW signing-key custody (design §9 / §13 phase 3).
 *
 * The final architecture keeps IW-SK inside an isolated signer service backed
 * by OpenBao; until that service exists (build phase 3), enrollment still
 * needs IW-SK to sign `.iwenroll` bundles. This module holds the cluster
 * keypair in a single k8s Secret in the console namespace — the same custody
 * tier as every other console-managed credential — and is the ONE place the
 * secret key is touched, so swapping in the signer later replaces this module
 * without touching the enrollment flow.
 */

const CONSOLE_NAMESPACE = process.env.CONSOLE_NAMESPACE ?? process.env.POD_NAMESPACE ?? "infraweaver-console";
const SECRET_NAME = process.env.IWSL_KEYS_SECRET_NAME ?? "infraweaver-iwsl-iw-keys";

/** Epoch the interim keypair is minted under; rotation arrives with phase 7. */
const INITIAL_IW_KID = 1;

export interface LoadedIwKeys {
  keys: IwKeyPair;
  kid: number;
}

interface IwKeysSecret {
  data?: Record<string, string | undefined>;
}

function b64ToBytes(value: string | undefined, field: string): Uint8Array {
  if (!value) throw new Error(`IWSL key secret is missing '${field}'`);
  // k8s Secret data values are standard base64; the keys inside are b64url.
  return fromB64u(Buffer.from(value, "base64").toString("utf8"));
}

function parseSecret(secret: IwKeysSecret): LoadedIwKeys {
  const kidRaw = secret.data?.kid ? Buffer.from(secret.data.kid, "base64").toString("utf8") : `${INITIAL_IW_KID}`;
  const kid = Number.parseInt(kidRaw, 10);
  return {
    kid: Number.isFinite(kid) && kid >= 1 ? kid : INITIAL_IW_KID,
    keys: {
      ed25519SecretKey: b64ToBytes(secret.data?.ed25519Sk, "ed25519Sk"),
      ed25519PublicKey: b64ToBytes(secret.data?.ed25519Pk, "ed25519Pk"),
      slhdsaSecretKey: b64ToBytes(secret.data?.slhdsaSk, "slhdsaSk"),
      slhdsaPublicKey: b64ToBytes(secret.data?.slhdsaPk, "slhdsaPk"),
    },
  };
}

async function readKeysSecret(): Promise<LoadedIwKeys | null> {
  const core = makeCoreApi();
  try {
    const secret = (await core.readNamespacedSecret({
      name: SECRET_NAME,
      namespace: CONSOLE_NAMESPACE,
    })) as IwKeysSecret;
    return parseSecret(secret);
  } catch (err) {
    if (isK8sNotFound(err)) return null;
    throw err;
  }
}

async function createKeysSecret(): Promise<LoadedIwKeys> {
  const keys = generateIwKeyPair();
  const core = makeCoreApi();
  const body = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: SECRET_NAME,
      namespace: CONSOLE_NAMESPACE,
      labels: {
        "app.kubernetes.io/managed-by": "infraweaver-console",
        "infraweaver.io/component": "iwsl",
      },
    },
    type: "Opaque",
    stringData: {
      kid: `${INITIAL_IW_KID}`,
      ed25519Sk: toB64u(keys.ed25519SecretKey),
      ed25519Pk: toB64u(keys.ed25519PublicKey),
      slhdsaSk: toB64u(keys.slhdsaSecretKey),
      slhdsaPk: toB64u(keys.slhdsaPublicKey),
    },
  };
  try {
    await core.createNamespacedSecret({ namespace: CONSOLE_NAMESPACE, body });
    return { keys, kid: INITIAL_IW_KID };
  } catch (err) {
    // Two first-enrollments raced: the loser re-reads the winner's keypair so
    // both requests sign with the same cluster identity.
    const existing = await readKeysSecret();
    if (existing) return existing;
    throw err;
  }
}

/** The cluster IW keypair, minting it on first use. */
export async function loadOrCreateIwKeys(): Promise<LoadedIwKeys> {
  return (await readKeysSecret()) ?? createKeysSecret();
}

/** Public halves only — safe for fingerprint display and bundle contents. */
export async function loadIwPublicKeys(): Promise<{ pks: IwPublicKeys; kid: number }> {
  const { keys, kid } = await loadOrCreateIwKeys();
  return { pks: iwPublicKeys(keys), kid };
}
