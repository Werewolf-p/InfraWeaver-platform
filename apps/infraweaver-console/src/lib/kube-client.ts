import * as k8s from "@kubernetes/client-node";

/** Singleton KubeConfig. Loaded once per process. */
let _kc: k8s.KubeConfig | null = null;

export function makeKc(): k8s.KubeConfig {
  if (_kc) return _kc;
  _kc = new k8s.KubeConfig();
  if (process.env.KUBECONFIG) {
    _kc.loadFromFile(process.env.KUBECONFIG);
  } else {
    try { _kc.loadFromCluster(); } catch { _kc.loadFromDefault(); }
  }
  return _kc;
}

export function makeCoreApi() { return makeKc().makeApiClient(k8s.CoreV1Api); }
export function makeAppsApi() { return makeKc().makeApiClient(k8s.AppsV1Api); }
export function makeCustomApi() { return makeKc().makeApiClient(k8s.CustomObjectsApi); }
export function makeBatchApi() { return makeKc().makeApiClient(k8s.BatchV1Api); }
export function makeRbacApi() { return makeKc().makeApiClient(k8s.RbacAuthorizationV1Api); }
export function makeNetworkApi() { return makeKc().makeApiClient(k8s.NetworkingV1Api); }
