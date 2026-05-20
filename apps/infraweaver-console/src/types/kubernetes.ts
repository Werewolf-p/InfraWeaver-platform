export interface KubernetesPod {
  name: string;
  namespace: string;
  status: string;
  containers: string[];
  nodeName?: string;
  createdAt: string;
  restartCount?: number;
}

export interface KubernetesDeployment {
  name: string;
  namespace: string;
  replicas: number;
  readyReplicas?: number;
  availableReplicas?: number;
  updatedReplicas?: number;
  image?: string;
}

export interface KubernetesServicePort {
  name?: string;
  port: number;
  targetPort?: number | string;
  protocol?: string;
}

export interface KubernetesService {
  name: string;
  namespace: string;
  type: string;
  clusterIP?: string;
  ports: KubernetesServicePort[];
}

export interface KubernetesVolume {
  name: string;
  namespace?: string;
  capacity?: string;
  accessModes?: string[];
  storageClassName?: string;
  status?: string;
}

export interface KubernetesCertificate {
  name: string;
  namespace: string;
  ready: boolean;
  issuer?: string;
  dnsNames?: string[];
  notAfter?: string;
  secretName?: string;
}
