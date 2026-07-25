import { type RunResult } from "./proc.js";
export interface VerifyContext {
    cwd: string;
    testCmdFile: string;
}
/** The command the agent declared when it built the scaffold. */
export declare function declaredTestCommand(ctx: VerifyContext): string | null;
export declare function detectTestCommand(cwd: string): string | null;
export interface ResolveOptions {
    configured: string;
    featureTest?: string | undefined;
}
export interface ResolvedCommand {
    command: string;
    source: "config" | "feature" | "declared" | "detected";
}
export declare function resolveTestCommand(ctx: VerifyContext, opts: ResolveOptions): ResolvedCommand | null;
export interface VerificationResult extends RunResult {
    /** Exit 127 means the command does not exist: an environment fault, not a code fault. */
    environmentBroken: boolean;
    passed: boolean;
}
export declare function runVerification(ctx: VerifyContext, command: string, timeoutSeconds: number, outFile?: string): Promise<VerificationResult>;
/**
 * Trim test output before handing it back to the model.
 *
 * Sending 3000 lines of stack trace to a local model is the fastest way to
 * blow its context window and make it lose the original task. The first error
 * is usually at the top and the summary at the bottom, so keep both ends.
 */
export declare function excerpt(output: string, maxLines?: number): string;
