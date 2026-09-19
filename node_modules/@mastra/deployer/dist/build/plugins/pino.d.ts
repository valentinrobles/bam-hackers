export declare function pino(): {
    name: string;
    resolveId(this: import("rollup").PluginContext, id: string, importee: string | undefined): Promise<{
        id: string;
        external: true;
        moduleSideEffects: false;
    } | undefined>;
    renderChunk(this: import("rollup").PluginContext, code: string, chunk: import("rollup").RenderedChunk): {
        code: string;
        map: null;
    } | undefined;
};
//# sourceMappingURL=pino.d.ts.map