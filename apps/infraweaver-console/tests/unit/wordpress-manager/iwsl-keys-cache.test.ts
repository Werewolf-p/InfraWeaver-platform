/** @jest-environment node */
// IW signing-key custody memo: loadOrCreateIwKeys reads the ESO-projected Secret
// on nearly every addon request, so the parsed keypair is cached in-process
// (mirroring loadKubeConfig). Verifies the Secret is read once and reused, that
// invalidateIwKeysCache forces a re-read, and that a missing Secret is NOT cached
// (a later-seeded Secret must still be picked up).
jest.mock("server-only", () => ({}), { virtual: true });

const readSecretMock = jest.fn();
jest.mock("@/lib/kube-client", () => ({
  makeCoreApi: () => ({ readNamespacedSecret: readSecretMock }),
}));
jest.mock("@/lib/iwsl", () => ({
  fromB64u: () => new Uint8Array([1, 2, 3]),
  iwPublicKeys: (keys: unknown) => keys,
}));
jest.mock("@/addons/wordpress-manager/lib/k8s-errors", () => ({
  isK8sNotFound: (err: unknown) => (err as { notFound?: boolean })?.notFound === true,
  retryOnTransientApiError: (fn: () => Promise<unknown>) => fn(),
}));

import {
  loadOrCreateIwKeys,
  invalidateIwKeysCache,
} from "@/addons/wordpress-manager/lib/iwsl-keys";

function secret() {
  return {
    data: {
      kid: Buffer.from("1").toString("base64"),
      ed25519Sk: "AA==",
      ed25519Pk: "AA==",
      slhdsaSk: "AA==",
      slhdsaPk: "AA==",
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  invalidateIwKeysCache();
});

test("reads the Secret once and serves later calls from the in-process cache", async () => {
  readSecretMock.mockResolvedValue(secret());

  const first = await loadOrCreateIwKeys();
  const second = await loadOrCreateIwKeys();

  expect(readSecretMock).toHaveBeenCalledTimes(1);
  // Same memoized instance handed back, not a re-parse.
  expect(second).toBe(first);
  expect(first.kid).toBe(1);
});

test("invalidateIwKeysCache forces the next call to re-read the Secret", async () => {
  readSecretMock.mockResolvedValue(secret());

  await loadOrCreateIwKeys();
  invalidateIwKeysCache();
  await loadOrCreateIwKeys();

  expect(readSecretMock).toHaveBeenCalledTimes(2);
});

test("a missing Secret fails loud and is not cached — a later-seeded key is picked up", async () => {
  readSecretMock.mockRejectedValueOnce({ notFound: true });
  await expect(loadOrCreateIwKeys()).rejects.toThrow(/not available|not found/i);

  // Secret appears on the next sync; the failure must not have poisoned the cache.
  readSecretMock.mockResolvedValueOnce(secret());
  const loaded = await loadOrCreateIwKeys();
  expect(loaded.kid).toBe(1);
  expect(readSecretMock).toHaveBeenCalledTimes(2);
});
