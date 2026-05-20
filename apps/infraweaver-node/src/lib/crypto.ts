import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto'

export interface KeyPair {
  privateKey: KeyObject
  publicKey: KeyObject
}

export function generateKeyPair(): KeyPair {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' })
}

export function exportPublicKey(kp: KeyPair): string {
  return kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

export function exportPrivateKey(kp: KeyPair): string {
  return kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
}

export function importPublicKey(base64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' })
}

export function importPrivateKey(pem: string): KeyObject {
  return createPrivateKey({ key: pem, format: 'pem' })
}

export function signFrame(message: string, privateKey: KeyObject): string {
  const sign = createSign('SHA256')
  sign.update(message)
  sign.end()
  return sign.sign(privateKey, 'base64')
}

export function verifyFrame(message: string, signature: string, publicKey: KeyObject): boolean {
  try {
    const verify = createVerify('SHA256')
    verify.update(message)
    verify.end()
    return verify.verify(publicKey, signature, 'base64')
  } catch {
    return false
  }
}
