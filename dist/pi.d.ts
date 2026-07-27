export interface PiEvent {
    type: string;
    toolName?: string;
    isError?: boolean;
    args?: Record<string, unknown>;
    message?: {
        role?: string;
        content?: Array<{
            type?: string;
            text?: string;
            thinking?: string;
        }>;
        usage?: {
            input?: number;
            output?: number;
            totalTokens?: number;
        };
        stopReason?: string;
        errorMessage?: string;
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
    /** The backend's own error, when a turn ended with stopReason "error". */
    backendError: string;
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
    /** Stream the model's reasoning, replies and tool calls to the terminal. */
    watch?: boolean;
    /**
     * Run pi with discovery of skills, extensions, prompt templates and themes
     * turned off. Default true.
     *
     * pi injects the name+description of EVERY installed skill into the system
     * prompt of every session, and loads discovered extensions on startup. On a
     * machine that has a handful of global skills that is a few hundred tokens of
     * irrelevant context re-sent on every feature call, plus the startup cost of
     * scanning for them dozens of times per build. The harness wants only its own
     * prompt and the files it attaches, so discovery is off unless asked for.
     */
    isolate?: boolean;
    /**
     * Skip pi's startup network operations (catalog/update checks). Default true:
     * the backends this harness drives are local, and the model is pinned with
     * --provider/--model, so nothing at startup needs the network.
     */
    offline?: boolean;
}
/**
 * Live view of a turn.
 *
 * pi re-sends the WHOLE message on every `message_update`, so printing an
 * update verbatim reprints everything written so far. Each content part is
 * tracked by index and only the new tail is emitted, which turns the stream
 * back into something that reads like typing.
 */
export declare function createWatcher(write?: (s: string) => void): (event: PiEvent) => void;
export declare function parseEvents(jsonl: string): PiEvent[];
/**
 * pi reports a failed request inside the event stream, not through its exit
 * code: the turn ends with `stopReason: "error"` and an `errorMessage`, and pi
 * still exits 0. The message body is usually `<status>: <provider JSON>`, whose
 * only readable part is the inner `message` field.
 */
export declare function readableBackendError(raw: string): string;
export declare function analyzeEvents(events: PiEvent[]): {
    writeCalls: number;
    toolErrors: number;
    totalTokens: number;
    finalText: string;
    backendError: string;
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
