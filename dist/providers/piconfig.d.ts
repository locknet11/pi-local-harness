import { type ContextInfo, type LoadedModel, type LocalModel, type Provider, type ProviderHealth } from "./types.js";
export interface PiConfigModel {
    id: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string>;
}
export interface PiConfigProvider {
    name: string;
    baseUrl: string;
    api?: string;
    models: PiConfigModel[];
    /** True when pi's defaultModel points into this provider. */
    isDefault: boolean;
    defaultModelId?: string;
}
export declare function piModelsJsonPath(): string;
/**
 * Read pi's global model registry.
 *
 * A malformed file is reported as "nothing configured" rather than thrown:
 * the harness has its own backends, and a broken pi config should not stop
 * `doctor` — which is the command that will point out the file is broken.
 */
export declare function readPiProviders(path?: string): PiConfigProvider[];
export declare function findPiProvider(name: string, path?: string): PiConfigProvider | null;
/**
 * A backend the harness drives but does not own.
 *
 * Every management operation is a deliberate no-op: pretending to load a model
 * or set a context on a server we know nothing about would produce a confident
 * lie in `doctor`, which is the one place that must stay trustworthy.
 */
export declare class PiRegisteredProvider implements Provider {
    readonly name: string;
    readonly displayName: string;
    readonly baseUrl: string;
    private readonly config;
    constructor(config: PiConfigProvider);
    /** pi's default model for this provider, when it has one. */
    defaultModel(): string | undefined;
    health(): Promise<ProviderHealth>;
    /** Not ours to start — it may not even be on this machine. */
    start(): Promise<boolean>;
    listModels(): Promise<LocalModel[]>;
    /** Which models are resident is a property of the server, and it is not ours. */
    listLoaded(): Promise<LoadedModel[]>;
    contextInfo(modelId: string): Promise<ContextInfo>;
    ensureContext(modelId: string, contextLength: number): Promise<string>;
    unload(): Promise<boolean>;
    piCompat(): Record<string, boolean> | undefined;
    thinkingLevelMap(): Record<string, string> | undefined;
    advice(): string[];
}
