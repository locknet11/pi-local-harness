import type { HarnessConfig } from "./config.js";
import { type Feature } from "./spec.js";
import type { Provider } from "./providers/types.js";
export type FeatureOutcome = 
/** verified and committed */
"completed"
/** accepted without a verification command */
 | "unverified"
/** retries exhausted */
 | "failed"
/** the environment is broken; stop everything */
 | "environment"
/** interrupted by the user */
 | "aborted";
export interface LoopContext {
    cwd: string;
    config: HarnessConfig;
    tempDir: string;
    /**
     * Optional backend handle, used only to free memory between features. The
     * loop never needs it otherwise, so tests can leave it out.
     */
    provider?: Pick<Provider, "unload"> | undefined;
}
export declare function processFeature(ctx: LoopContext, feature: Feature, checkpoint: string): Promise<FeatureOutcome>;
export interface LoopOptions {
    once?: boolean;
    onlyFeatureId?: string;
}
export interface LoopSummary {
    completed: number;
    failed: number;
    stoppedBecause: "done" | "blocked" | "environment" | "aborted" | "circuit-breaker";
}
export declare function runLoop(ctx: LoopContext, optionsInput?: LoopOptions): Promise<LoopSummary>;
/** Ensure the spec file exists and is parseable before starting a run. */
export declare function requireSpec(cwd: string, specFile: string): string;
