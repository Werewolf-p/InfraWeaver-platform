import * as k8s from '@kubernetes/client-node'

import type { HeartbeatStatus } from '../types/index.js'

const kubeConfig = new k8s.KubeConfig()
kubeConfig.loadFromCluster()

const coreApi: any = kubeConfig.makeApiClient(k8s.CoreV1Api)
const customObjectsApi: any = kubeConfig.makeApiClient(k8s.CustomObjectsApi)
const metricsClient: any = typeof (k8s as any).Metrics === 'function' ? new (k8s as any).Metrics(kubeConfig) : null

function unwrapBody<T>(result: any): T {
  return (result?.body ?? result) as T
}

function extractNodeRoles(labels: Record<string, string> = {}): string[] {
  const roles = Object.keys(labels)
    .filter((key) => key.startsWith('node-role.kubernetes.io/'))
    .map((key) => key.replace('node-role.kubernetes.io/', ''))
    .filter(Boolean)

  if (labels['node-role.kubernetes.io/control-plane'] !== undefined && !roles.includes('control-plane')) {
    roles.push('control-plane')
  }

  if (labels['node-role.kubernetes.io/master'] !== undefined && !roles.includes('master')) {
    roles.push('master')
  }

  return roles.length > 0 ? roles : ['worker']
}

function getNodeConditionStatus(node: any, type: string): string | undefined {
  return node?.status?.conditions?.find((condition: any) => condition.type === type)?.status
}

function getAddresses(node: any): Record<string, string | undefined> {
  const addresses = Array.isArray(node?.status?.addresses) ? node.status.addresses : []
  return {
    internalIP: addresses.find((address: any) => address.type === 'InternalIP')?.address,
    externalIP: addresses.find((address: any) => address.type === 'ExternalIP')?.address,
    hostname: addresses.find((address: any) => address.type === 'Hostname')?.address,
  }
}

function buildNodeSummary(node: any) {
  const labels = node?.metadata?.labels ?? {}
  const addresses = getAddresses(node)
  const ready = getNodeConditionStatus(node, 'Ready') === 'True'

  return {
    name: node?.metadata?.name,
    status: ready ? 'Ready' : 'NotReady',
    ready,
    roles: extractNodeRoles(labels),
    cpu: node?.status?.capacity?.cpu,
    memory: node?.status?.capacity?.memory,
    podCapacity: node?.status?.capacity?.pods,
    kernelVersion: node?.status?.nodeInfo?.kernelVersion,
    kubeletVersion: node?.status?.nodeInfo?.kubeletVersion,
    osImage: node?.status?.nodeInfo?.osImage,
    architecture: node?.status?.nodeInfo?.architecture,
    containerRuntimeVersion: node?.status?.nodeInfo?.containerRuntimeVersion,
    internalIP: addresses.internalIP,
    externalIP: addresses.externalIP,
    hostname: addresses.hostname,
    instanceType: labels['node.kubernetes.io/instance-type'] ?? labels['beta.kubernetes.io/instance-type'],
    zone: labels['topology.kubernetes.io/zone'] ?? labels['failure-domain.beta.kubernetes.io/zone'],
    createdAt: node?.metadata?.creationTimestamp,
  }
}

function getContainerReadiness(pod: any): string {
  const statuses = Array.isArray(pod?.status?.containerStatuses) ? pod.status.containerStatuses : []
  const readyCount = statuses.filter((status: any) => status.ready).length
  return `${readyCount}/${statuses.length}`
}

function buildPodSummary(pod: any) {
  return {
    name: pod?.metadata?.name,
    namespace: pod?.metadata?.namespace,
    status: pod?.status?.phase,
    phase: pod?.status?.phase,
    ready: getContainerReadiness(pod),
    containers: Array.isArray(pod?.spec?.containers)
      ? pod.spec.containers.map((container: any) => container.name)
      : [],
    restarts: Array.isArray(pod?.status?.containerStatuses)
      ? pod.status.containerStatuses.reduce((total: number, status: any) => total + (status.restartCount ?? 0), 0)
      : 0,
    nodeName: pod?.spec?.nodeName,
    podIP: pod?.status?.podIP,
    hostIP: pod?.status?.hostIP,
    startTime: pod?.status?.startTime,
    qosClass: pod?.status?.qosClass,
  }
}

function getEventTimestamp(event: any): number {
  const value = event?.eventTime ?? event?.lastTimestamp ?? event?.firstTimestamp ?? event?.metadata?.creationTimestamp
  return value ? Date.parse(value) : 0
}

function buildEventSummary(event: any) {
  return {
    type: event?.type,
    reason: event?.reason,
    message: event?.message,
    namespace: event?.metadata?.namespace,
    name: event?.metadata?.name,
    count: event?.count,
    involvedObject: {
      kind: event?.involvedObject?.kind,
      name: event?.involvedObject?.name,
      namespace: event?.involvedObject?.namespace,
    },
    firstTimestamp: event?.firstTimestamp,
    lastTimestamp: event?.lastTimestamp,
    eventTime: event?.eventTime,
  }
}

function buildMetricSummary(metric: any) {
  return {
    name: metric?.metadata?.name,
    timestamp: metric?.timestamp,
    window: metric?.window,
    cpu: metric?.usage?.cpu,
    memory: metric?.usage?.memory,
  }
}

export async function listNodes(): Promise<Array<Record<string, unknown>>> {
  const response = unwrapBody<any>(await coreApi.listNode())
  const items = Array.isArray(response?.items) ? response.items : []
  return items.map((node: any) => buildNodeSummary(node))
}

export async function listPods(): Promise<Array<Record<string, unknown>>> {
  const response = unwrapBody<any>(await coreApi.listPodForAllNamespaces())
  const items = Array.isArray(response?.items) ? response.items : []
  return items.map((pod: any) => buildPodSummary(pod))
}

export async function listEvents(limit = 100): Promise<Array<Record<string, unknown>>> {
  const response = unwrapBody<any>(await coreApi.listEventForAllNamespaces())
  const items = Array.isArray(response?.items) ? response.items : []

  return items
    .sort((left: any, right: any) => getEventTimestamp(right) - getEventTimestamp(left))
    .slice(0, limit)
    .map((event: any) => buildEventSummary(event))
}

export async function listNodeMetrics(): Promise<Array<Record<string, unknown>>> {
  if (metricsClient && typeof metricsClient.getNodeMetrics === 'function') {
    const response = unwrapBody<any>(await metricsClient.getNodeMetrics())
    const items = Array.isArray(response?.items) ? response.items : []
    return items.map((metric: any) => buildMetricSummary(metric))
  }

  const response = unwrapBody<any>(
    await customObjectsApi.listClusterCustomObject('metrics.k8s.io', 'v1beta1', 'nodes'),
  )
  const items = Array.isArray(response?.items) ? response.items : []
  return items.map((metric: any) => buildMetricSummary(metric))
}

export async function getClusterStatus(): Promise<HeartbeatStatus> {
  const [nodes, pods] = await Promise.all([listNodes(), listPods()])

  return {
    ready: true,
    nodeCount: nodes.length,
    podCount: pods.length,
  }
}
