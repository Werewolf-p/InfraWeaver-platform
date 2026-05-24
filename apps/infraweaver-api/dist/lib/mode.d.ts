export type ApiMode = 'live' | 'deployment';
export declare function getMode(): Promise<ApiMode>;
export declare function setMode(mode: ApiMode): Promise<void>;
export declare function registerBroadcastFn(fn: (mode: ApiMode) => void): void;
//# sourceMappingURL=mode.d.ts.map