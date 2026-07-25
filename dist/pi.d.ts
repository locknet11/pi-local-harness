export interface PiEvent {
    type: string;
    toolName?: string;
    isError?: boolean;
    message?: {
        role?: string;
        content?: Array<{
            type?: string;
            text?: string;
        }>;
        usage?: {
            input?: number;
            output?: number;
            totalTokens?: number;
        };
    };
    messages?: Array<{
        role?: string;
        content?: Array<{
            type?: string;
            text?: string;
        }>;
    }>;
    willRetry?: boolean;
}
export interface PiRunResult {
    code: number;
    timedOut: boolean;
    aborted: boolean;
    /** Successful calls to repository-modifying tools. */
    writeCalls: number;
    toolErrors: number;
    totalTokens: number;
    /** Final assistant text, for diagnostics. */
    finalText: string;
    events: PiEvent[];
    rawPath: string;
    /** Provider-side problems worth surfacing (context overflow, refused connection…). */
    hints: string[];
}
export interface PiOptions {
    piBin: string;
    provider: string;
    model: string;
    thinking?: string;
    cwd: string;
    timeoutSeconds: number;
    /** Files attached with pi's `@file` syntax. */
    attachments?: string[];
    saveSession?: boolean;
    sessionName?: string;
    rawPath: string;
}
export declare function parseEvents(jsonl: string): PiEvent[];
export declare function analyzeEvents(events: PiEvent[]): {
    writeCalls: number;
    toolErrors: number;
    totalTokens: number;
    finalText: string;
};
/**
 * Backend problems worth surfacing.
 *
 * Only lines that actually look like errors are scanned. The model's own
 * reasoning text routinely contains words like "invalid" and "context length",
 * and matching those produced confident warnings about problems that did not
 * exist — noise that makes the real warnings worthless.
 */
export declare function extractHints(raw: string): string[];
export declare function runPi(prompt: string, options: PiOptions): Promise<PiRunResult>;
/**
 * Does this model actually execute tools?
 *
 * Declaring `tools` in the backend's capabilities is not enough — that comes
 * from the chat template, not the model. qwen2.5-coder:7b declares tools and
 * still replies with
 *
 *   {"name": "write", "arguments": {"path": "hello.txt", "content": "HI"}}
 *
 * as plain text. pi never sees a tool call, nothing is written, and the exit
 * code is 0. Without this probe you find out only after a whole failed run.
 */
export declare function probeToolCalling(options: Omit<PiOptions, "rawPath" | "cwd" | "timeoutSeconds"> & {
    timeoutSeconds?: number;
}): Promise<{
    ok: boolean;
    writeCalls: number;
    wroteFile: boolean;
    finalText: string;
}>;
/** Register a local model with pi by merging into ~/.pi/agent/models.json. */
export interface PiModelRegistration {
    providerName: string;
    baseUrl: string;
    modelId: string;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
    compat?: Record<string, boolean> | undefined;
    thinkingLevelMap?: Record<string, string> | undefined;
}
export declare function registerModel(modelsJsonPath: string, reg: PiModelRegistration): {
    backupPath: string | null;
};
export declare function piSeesModel(piBin: string, provider: string, modelId: string): Promise<boolean>;
