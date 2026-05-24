export interface OpenApiDocument {
    openapi: string;
    info: {
        title: string;
        version: string;
        description: string;
    };
    servers: Array<{
        url: string;
        description: string;
    }>;
    tags: Array<{
        name: string;
        description: string;
    }>;
    paths: Record<string, Record<string, unknown>>;
}
export declare function createOpenApiDocument(serverUrl?: string): OpenApiDocument;
//# sourceMappingURL=spec.d.ts.map