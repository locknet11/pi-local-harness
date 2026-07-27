import type { ContextInfo, LoadedModel, LocalModel, Provider, ProviderHealth } from "./types.js";
export interface CloudModel {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string>;
}
export interface CloudProviderInfo {
    name: string;
    models: CloudModel[];
}
/** Where pi caches the built-in catalogs it refreshes from upstream. */
export declare function piModelsStorePath(): string;
export declare function piAuthJsonPath(): string;
/**
 * Read pi's built-in provider catalog cache.
 *
 * The file is a map of provider name -> { models: [...] }. A missing or
 * malformed file is reported as "nothing cached" rather than thrown: doctor
 * is the place that surfaces the problem, and the harness can still drive a
 * provider whose catalog simply is not cached yet.
 */
export declare function readCloudProviders(path?: string): CloudProviderInfo[];
export declare function findCloudProvider(name: string, path?: string): CloudProviderInfo | null;
export interface CredentialStatus {
    present: boolean;
    source?: "auth.json" | "env";
    /** Env var that would satisfy this provider, for hints. */
    envVar?: string;
}
/**
 * Does pi have a usable credential for this provider?
 *
 * Mirrors pi's resolution order closely enough for a pre-flight check:
 * auth.json wins, then the provider's environment variable.
 */
export declare function credentialStatus(name: string, authPath?: string): CredentialStatus;
/**
 * A cloud provider the harness drives but does not own.
 *
 * Management operations are deliberate no-ops: there is no local server to
 * start and no model to load — pi handles connection and auth. Context info,
 * though, comes from the real catalog cache, so doctor can warn about a
 * mismatch instead of guessing.
 */
export declare class CloudProvider implements Provider {
    readonly name: string;
    readonly displayName: string;
    /** Cloud endpoints are addressed by pi, not by the harness. */
    readonly baseUrl = "";
    private readonly info;
    constructor(info: CloudProviderInfo);
    health(): Promise<ProviderHealth>;
    /** Nothing to start — pi dials the cloud endpoint itself. */
    start(): Promise<boolean>;
    listModels(): Promise<LocalModel[]>;
    /** Residency is meaningless for a hosted endpoint. */
    listLoaded(): Promise<LoadedModel[]>;
    contextInfo(modelId: string): Promise<ContextInfo>;
    ensureContext(modelId: string, contextLength: number): Promise<string>;
    unload(): Promise<boolean>;
    piCompat(): Record<string, boolean> | undefined;
    thinkingLevelMap(): Record<string, string> | undefined;
    advice(): string[];
}
