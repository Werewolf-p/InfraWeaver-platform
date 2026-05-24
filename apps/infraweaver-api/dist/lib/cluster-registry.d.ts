import type { ClusterMeta } from '../types/index.js';
export declare function listClusters(): Promise<ClusterMeta[]>;
export declare function getCluster(id: string): Promise<ClusterMeta | null>;
export declare function getClusterKubeconfig(clusterId: string): Promise<string>;
export declare function addCluster(meta: ClusterMeta, kubeconfig: string): Promise<void>;
export declare function removeCluster(id: string): Promise<void>;
export declare function updateClusterStatus(id: string, status: ClusterMeta['status']): Promise<void>;
export declare function initLocalCluster(): Promise<void>;
//# sourceMappingURL=cluster-registry.d.ts.map