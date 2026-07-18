import "server-only";
import { makeCoreApi } from "@/lib/kube-client";
import {
  fromB64u,
  iwPublicKeys,
  type IwKeyPair,
  type IwPublicKeys,
} from "@/lib/iwsl";
import { isK8sNotFound, retryOnTransientApiError } from "./k8s-errors";

/**
 * IW signing-key custody (design §9 / §13 phase 3).
 *
 * The IW keypair is now OWNED BY OpenBao and projected into the k8s Secret
 * `infraweaver-iwsl-iw-keys` by External Secrets Operator (infra manifest
 * kubernetes/catalog/infraweaver-console/base/externalsecret-iwsl-iw-keys.yaml,
 * OpenBao path `secret/iwsl/iw-keys`). This module is READ-ONLY: it loads the
 * projected key and never mints one. Self-minting was removed on the phase-3
 * cut-over — a console-side create would race the ESO-owned Secret and
 * split-brain the cluster identity, breaking every enrolled site's signature
 * verification. If the Secret is absent the key has not been seeded/synced yet;
 * we fail loud rather than silently minting a new (wrong-fingerprint) identity.
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
  // 192f keypair is projected alongside 192s once OpenBao seeds it (the fast-sign
  // migration). Absent on a pre-migration Secret — optional, so enrollment/signing
  // transparently falls back to 192s until the key is present.
  const has192f = Boolean(secret.data?.slhdsa192fSk && secret.data?.slhdsa192fPk);
  return {
    kid: Number.isFinite(kid) && kid >= 1 ? kid : INITIAL_IW_KID,
    keys: {
      ed25519SecretKey: b64ToBytes(secret.data?.ed25519Sk, "ed25519Sk"),
      ed25519PublicKey: b64ToBytes(secret.data?.ed25519Pk, "ed25519Pk"),
      slhdsaSecretKey: b64ToBytes(secret.data?.slhdsaSk, "slhdsaSk"),
      slhdsaPublicKey: b64ToBytes(secret.data?.slhdsaPk, "slhdsaPk"),
      slhdsa192fSecretKey: has192f ? b64ToBytes(secret.data?.slhdsa192fSk, "slhdsa192fSk") : undefined,
      slhdsa192fPublicKey: has192f ? b64ToBytes(secret.data?.slhdsa192fPk, "slhdsa192fPk") : undefined,
    },
  };
}

async function readKeysSecret(): Promise<LoadedIwKeys | null> {
  const core = makeCoreApi();
  try {
    // Retry a transient apiserver socket drop, same as mutateExternalSites: the
    // concurrent update-sweep signs every fleet site in near-lockstep, so this
    // shared-key read contends for connections and otherwise fails one random
    // site/run on a "socket hang up". The read is idempotent, so re-issuing is safe.
    const secret = (await retryOnTransientApiError(() =>
      core.readNamespacedSecret({
        name: SECRET_NAME,
        namespace: CONSOLE_NAMESPACE,
      }),
    )) as IwKeysSecret;
    return parseSecret(secret);
  } catch (err) {
    if (isK8sNotFound(err)) return null;
    throw err;
  }
}

/**
 * The cluster IW keypair, loaded from the ESO-projected Secret. The name is
 * kept for call-site compatibility (enrollment, public-key loading) but this no
 * longer creates a key: OpenBao owns it now (see module docstring). A missing
 * Secret means it has not been seeded/synced — fail loud, never self-mint.
 */
export async function loadOrCreateIwKeys(): Promise<LoadedIwKeys> {
  const loaded = await readKeysSecret();
  if (loaded) return loaded;
  throw new Error(
    `IWSL signing key not available: Secret '${SECRET_NAME}' not found in namespace ` +
      `'${CONSOLE_NAMESPACE}'. The key is now provisioned by OpenBao via External Secrets ` +
      `(path secret/iwsl/iw-keys). Seed OpenBao and let ESO sync the Secret before enrollment.`,
  );
}

/** Public halves only — safe for fingerprint display and bundle contents. */
export async function loadIwPublicKeys(): Promise<{ pks: IwPublicKeys; kid: number }> {
  const { keys, kid } = await loadOrCreateIwKeys();
  return { pks: iwPublicKeys(keys), kid };
}
