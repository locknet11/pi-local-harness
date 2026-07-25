import { type ContextInfo, type LoadedModel, type LocalModel, type Provider, type ProviderHealth } from "./types.js";
export declare function findLmsBinary(): string | null;
export declare class LMStudioProvider implements Provider {
    readonly name = "lmstudio";
    readonly displayName = "LM Studio";
    readonly host: string;
    private readonly lms;
    constructor(host?: string);
    get baseUrl(): string;
    get cliAvailable(): boolean;
    private lmsRun;
    health(): Promise<ProviderHealth>;
    start(): Promise<boolean>;
    private lmsJson;
    listModels(): Promise<LocalModel[]>;
    listLoaded(): Promise<LoadedModel[]>;
    contextInfo(modelId: string): Promise<ContextInfo>;
    /**
     * Load (or reload) the model with an explicit context length. LM Studio keeps
     * the requested size for the life of the loaded instance, so this is all that
     * is needed — the model id never changes.
     */
    ensureContext(modelId: string, contextLength: number): Promise<string>;
    unload(modelId: string): Promise<boolean>;
    /**
     * Does this model actually produce reasoning content?
     *
     * pi only applies the thinking-level machinery to models declared
     * reasoning-capable, so getting this wrong means `--thinking off` is ignored
     * and the model thinks on every single call. One tiny request settles it.
     */
    supportsReasoning(modelId: string): Promise<boolean>;
    unloadAll(): Promise<boolean>;
    /**
     * LM Studio implements the OpenAI surface properly: it accepts the
     * `developer` role and `reasoning_effort` without complaint. Disabling them
     * (as Ollama needs) would be actively harmful here, because it stops pi from
     * sending `reasoning_effort` at all — which is the only way to turn thinking
     * off. Verified against LM Studio 0.3.x.
     */
    piCompat(): Record<string, boolean> | undefined;
    /**
     * pi's "off" must reach the backend as `reasoning_effort: "none"`.
     *
     * Measured with qwen3.5-9b: "minimal" and "low" still emit a full reasoning
     * dump before answering, while "none" returns the answer immediately. On a
     * laptop that is the difference between a feature taking minutes and taking
     * seconds.
     */
    thinkingLevelMap(): Record<string, string>;
    advice(): string[];
}
