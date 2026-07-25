import { type ContextInfo, type LoadedModel, type LocalModel, type Provider, type ProviderHealth } from "./types.js";
export declare class OllamaProvider implements Provider {
    readonly name = "ollama";
    readonly displayName = "Ollama";
    readonly host: string;
    constructor(host?: string);
    get baseUrl(): string;
    health(): Promise<ProviderHealth>;
    start(): Promise<boolean>;
    listModels(): Promise<LocalModel[]>;
    listLoaded(): Promise<LoadedModel[]>;
    /** Ollama normalizes tags: a model created as "foo" is listed as "foo:latest". */
    hasModel(modelId: string): Promise<boolean>;
    private show;
    contextInfo(modelId: string): Promise<ContextInfo>;
    capabilities(modelId: string): Promise<string[]>;
    /**
     * Ollama has no per-request context control over the OpenAI endpoint, so the
     * only reliable fix is a derived model with `PARAMETER num_ctx` baked in.
     */
    ensureContext(modelId: string, contextLength: number): Promise<string>;
    unload(modelId: string): Promise<boolean>;
    piCompat(): Record<string, boolean>;
    /** Not applicable: reasoning_effort is disabled by the compat flags above. */
    thinkingLevelMap(): undefined;
    advice(): string[];
}
