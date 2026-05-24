import * as k8s from '@kubernetes/client-node';
export declare function getKcForCluster(clusterId: string): Promise<k8s.KubeConfig>;
export declare function getCoreApiForCluster(clusterId: string): Promise<k8s.CoreV1Api>;
export declare function getAppsApiForCluster(clusterId: string): Promise<k8s.AppsV1Api>;
export declare function getCustomApiForCluster(clusterId: string): Promise<k8s.CustomObjectsApi>;
export declare function getMetricsApiForCluster(clusterId: string): Promise<k8s.Metrics>;
export declare function getBatchApiForCluster(clusterId: string): Promise<k8s.BatchV1Api>;
export declare function getNetworkApiForCluster(clusterId: string): Promise<k8s.NetworkingV1Api>;
export declare function getAutoscalingApiForCluster(clusterId: string): Promise<k8s.AutoscalingV2Api>;
export declare function getPolicyApiForCluster(clusterId: string): Promise<k8s.PolicyV1Api>;
//# sourceMappingURL=k8s-client.d.ts.map