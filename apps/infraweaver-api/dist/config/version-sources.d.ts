export type VersionSource = {
    type: 'helm';
    repoUrl: string;
    chartName: string;
} | {
    type: 'docker';
    image: string;
} | {
    type: 'ghcr';
    owner: string;
    repo: string;
    packageName: string;
};
export type VersionSourceType = VersionSource['type'];
export declare const VERSION_SOURCES: Record<string, VersionSource>;
//# sourceMappingURL=version-sources.d.ts.map