import type { Provider } from "./types.js";
export * from "./types.js";
export { OllamaProvider } from "./ollama.js";
export { LMStudioProvider, findLmsBinary } from "./lmstudio.js";
export type ProviderName = "ollama" | "lmstudio";
export declare function createProvider(name: string): Provider;
export declare function allProviders(): Provider[];
/**
 * Pick a backend when the user did not name one: whichever is actually running
 * and has at least one model. Preferring a live server over a configured-but-
 * dead one avoids a confusing first run.
 */
export declare function detectProvider(): Promise<Provider | null>;
