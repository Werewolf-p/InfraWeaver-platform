import { readFile } from 'node:fs/promises'

import * as k8s from '@kubernetes/client-node'

export interface NodeState {
  clusterId: string
  agentPrivateKeyPem: string
  hubPublicKeyBase64: string
  registeredAt: string
}

const STATE_SECRET_NAME = 'infraweaver-node-state'
const SERVICE_ACCOUNT_NAMESPACE_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/namespace'

const kubeConfig = new k8s.KubeConfig()
kubeConfig.loadFromCluster()
const coreApi: any = kubeConfig.makeApiClient(k8s.CoreV1Api)

function encodeSecretValue(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

function decodeSecretValue(data: Record<string, string> | undefined, key: string): string | null {
  const raw = data?.[key]
  if (!raw) {
    return null
  }

  return Buffer.from(raw, 'base64').toString('utf8')
}

function isNotFoundError(error: unknown): boolean {
  const candidate = error as {
    code?: number          // v1.x ResponseError direct property
    statusCode?: number
    status?: number
    body?: { code?: number } | string
    response?: { statusCode?: number; status?: number }
    message?: string
  }

  // Check for 404 in all known error formats (v0.x and v1.x)
  if ([candidate?.code, candidate?.statusCode, candidate?.status,
       candidate?.response?.statusCode, candidate?.response?.status].includes(404)) {
    return true
  }

  // v1.x body may be a JSON string with code field
  if (typeof candidate?.body === 'string') {
    try {
      const parsed = JSON.parse(candidate.body)
      if (parsed?.code === 404) return true
    } catch { /* not JSON */ }
  } else if (typeof candidate?.body === 'object' && candidate.body !== null) {
    if ((candidate.body as { code?: number }).code === 404) return true
  }

  return false
}

async function getNamespace(): Promise<string> {
  if (process.env.POD_NAMESPACE) {
    return process.env.POD_NAMESPACE
  }

  try {
    return (await readFile(SERVICE_ACCOUNT_NAMESPACE_PATH, 'utf8')).trim()
  } catch {
    return 'default'
  }
}

async function readStateSecret(namespace: string): Promise<any | null> {
  try {
    const response = await coreApi.readNamespacedSecret({ name: STATE_SECRET_NAME, namespace })
    return response?.body ?? response
  } catch (error) {
    if (isNotFoundError(error)) {
      return null
    }

    throw new Error(`Failed to read state secret: ${(error as Error).message}`)
  }
}

export async function loadState(): Promise<NodeState | null> {
  const namespace = await getNamespace()
  const secret = await readStateSecret(namespace)

  if (!secret?.data) {
    return null
  }

  const clusterId = decodeSecretValue(secret.data, 'clusterId')
  const agentPrivateKeyPem = decodeSecretValue(secret.data, 'agentPrivateKeyPem')
  const hubPublicKeyBase64 = decodeSecretValue(secret.data, 'hubPublicKeyBase64')
  const registeredAt = decodeSecretValue(secret.data, 'registeredAt')

  if (!clusterId || !agentPrivateKeyPem || !hubPublicKeyBase64 || !registeredAt) {
    return null
  }

  return {
    clusterId,
    agentPrivateKeyPem,
    hubPublicKeyBase64,
    registeredAt,
  }
}

export async function saveState(state: NodeState): Promise<void> {
  const namespace = await getNamespace()
  const existingSecret = await readStateSecret(namespace)

  const secretBody = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: STATE_SECRET_NAME,
      namespace,
      ...(existingSecret?.metadata?.resourceVersion
        ? { resourceVersion: existingSecret.metadata.resourceVersion }
        : {}),
    },
    type: 'Opaque',
    data: {
      clusterId: encodeSecretValue(state.clusterId),
      agentPrivateKeyPem: encodeSecretValue(state.agentPrivateKeyPem),
      hubPublicKeyBase64: encodeSecretValue(state.hubPublicKeyBase64),
      registeredAt: encodeSecretValue(state.registeredAt),
    },
  }

  if (existingSecret) {
    await coreApi.replaceNamespacedSecret({ name: STATE_SECRET_NAME, namespace, body: secretBody })
    return
  }

  await coreApi.createNamespacedSecret({ namespace, body: secretBody })
}
