export interface RunOptions {
    /** Seconds; 0 or undefined disables the timeout. */
    timeoutSeconds?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Append combined stdout+stderr here as it streams. */
    outFile?: string;
    /** Run through `bash -lc` so login-shell PATH setup (nvm, pyenv) applies. */
    shell?: boolean;
    /** Grace period between SIGTERM and SIGKILL. */
    killGraceSeconds?: number;
    onStdout?: (chunk: string) => void;
}
export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    /** True when the harness itself was asked to stop (Ctrl+C). */
    aborted: boolean;
}
/** Set once a stop is requested; every long wait checks it. */
declare class StopFlag {
    private stopped;
    private count;
    private listeners;
    request(): number;
    get isStopped(): boolean;
    get signalCount(): number;
    onStop(fn: () => void): () => void;
    reset(): void;
}
export declare const stopFlag: StopFlag;
/** Kill a whole process group, falling back to the bare pid. */
export declare function killTree(pid: number, signal?: NodeJS.Signals): void;
export declare function killAllChildren(signal?: NodeJS.Signals): void;
export declare function installSignalHandlers(onStop: (count: number) => void): void;
export declare function run(command: string, args: string[], options?: RunOptions): Promise<RunResult>;
/** Interruptible sleep: resolves early when a stop is requested. */
export declare function sleep(seconds: number): Promise<void>;
/**
 * Does this command line actually have a runnable executable?
 *
 * Leading `VAR=value` assignments and `env` must be skipped. A command such as
 *   PYTHONPATH=. .venv/bin/pytest -q
 * is perfectly valid — the scaffold phase generates exactly that — but naive
 * "take the first token" logic reads `PYTHONPATH=.` and wrongly declares the
 * command missing, which aborts the whole run.
 */
export declare function commandExecutable(commandLine: string): boolean;
export {};
