export interface GitFile {
    content: string;
    sha: string;
}
export interface AppTreeEntry {
    path: string;
    sha: string;
}
export declare function isOnedev(): boolean;
export declare function githubGetTree(): Promise<AppTreeEntry[]>;
export declare function githubGetFile(filePath: string): Promise<GitFile | null>;
export declare function githubPutFile(filePath: string, content: string, message: string, sha: string): Promise<string>;
export declare function onedevGetTreeAndFiles(): Promise<Array<{
    path: string;
    content: string;
    sha: string;
}>>;
export declare function onedevGetFile(filePath: string): Promise<GitFile | null>;
export declare function onedevPutFile(filePath: string, content: string, message: string): Promise<string>;
//# sourceMappingURL=git-provider.d.ts.map