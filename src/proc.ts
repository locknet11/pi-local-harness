/**
 * Process execution with real timeouts and real cancellation.
 *
 * The bash version of this harness had to reimplement timeout(1), flock(1) and
 * setsid(1) because macOS ships none of them. Node gives us all three properties
 * directly:
 *
 *   - `detached: true` puts the child in its own process group, so killing
 *     `-pid` also kills the grandchildren. pi spawns shells for its bash tool,
 *     and without this those survive and keep holding the GPU.
 *   - a timer plus an explicit kill gives an accurate timeout with a
 *     TERM-then-KILL escalation.
 *   - signals are handled by the event loop, so Ctrl+C is never swallowed.
 */
import { spawn, type SpawnOptions } from "node:child_process";
import { accessSync, constants, createWriteStream, existsSync, type WriteStream } from "node:fs";
import { join } from "node:path";

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
class StopFlag {
  private stopped = false;
  private count = 0;
  private listeners = new Set<() => void>();

  request(): number {
    this.stopped = true;
    this.count += 1;
    for (const l of this.listeners) l();
    return this.count;
  }
  get isStopped(): boolean {
    return this.stopped;
  }
  get signalCount(): number {
    return this.count;
  }
  onStop(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  reset(): void {
    this.stopped = false;
    this.count = 0;
  }
}

export const stopFlag = new StopFlag();

const activeChildren = new Set<number>();

/** Kill a whole process group, falling back to the bare pid. */
export function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export function killAllChildren(signal: NodeJS.Signals = "SIGTERM"): void {
  for (const pid of activeChildren) killTree(pid, signal);
}

export function installSignalHandlers(onStop: (count: number) => void): void {
  const handler = () => {
    const count = stopFlag.request();
    onStop(count);
    if (count >= 2) {
      killAllChildren("SIGKILL");
      process.exit(130);
    }
    killAllChildren("SIGTERM");
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  process.on("SIGHUP", handler);
}

export async function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const {
    timeoutSeconds = 0,
    cwd,
    env,
    outFile,
    shell = false,
    killGraceSeconds = 15,
    onStdout,
  } = options;

  return new Promise<RunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const spawnOpts: SpawnOptions = {
      cwd,
      env: env ?? process.env,
      // Own process group, so the timeout can take down the whole tree.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    };

    const child = shell
      ? spawn("bash", ["-lc", command], spawnOpts)
      : spawn(command, args, spawnOpts);

    let sink: WriteStream | null = null;
    if (outFile) {
      try {
        sink = createWriteStream(outFile, { flags: "a" });
      } catch {
        sink = null;
      }
    }

    if (child.pid !== undefined) activeChildren.add(child.pid);

    child.stdout?.on("data", (b: Buffer) => {
      const s = b.toString();
      stdout += s;
      sink?.write(s);
      onStdout?.(s);
    });
    child.stderr?.on("data", (b: Buffer) => {
      const s = b.toString();
      stderr += s;
      sink?.write(s);
    });

    let killTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;

    if (timeoutSeconds > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) killTree(child.pid, "SIGTERM");
        graceTimer = setTimeout(() => {
          if (child.pid !== undefined) killTree(child.pid, "SIGKILL");
        }, killGraceSeconds * 1000);
      }, timeoutSeconds * 1000);
    }

    const unsubscribe = stopFlag.onStop(() => {
      if (child.pid !== undefined) killTree(child.pid, "SIGTERM");
    });

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      unsubscribe();
      if (child.pid !== undefined) activeChildren.delete(child.pid);
      sink?.end();
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        aborted: stopFlag.isStopped && !timedOut,
      });
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      stderr += String(err.message ?? err);
      // ENOENT is the "command not found" of spawn: report it as 127 so the
      // caller can tell a broken environment from failing tests.
      finish(err.code === "ENOENT" ? 127 : 1);
    });
    child.on("close", (code, signal) => {
      if (timedOut) return finish(124);
      if (code === null) return finish(signal === "SIGKILL" ? 137 : 143);
      finish(code);
    });
  });
}

/** Interruptible sleep: resolves early when a stop is requested. */
export function sleep(seconds: number): Promise<void> {
  if (seconds <= 0 || stopFlag.isStopped) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      unsubscribe();
      resolve();
    }, seconds * 1000);
    const unsubscribe = stopFlag.onStop(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * Does this command line actually have a runnable executable?
 *
 * Leading `VAR=value` assignments and `env` must be skipped. A command such as
 *   PYTHONPATH=. .venv/bin/pytest -q
 * is perfectly valid — the scaffold phase generates exactly that — but naive
 * "take the first token" logic reads `PYTHONPATH=.` and wrongly declares the
 * command missing, which aborts the whole run.
 */
export function commandExecutable(commandLine: string): boolean {
  const tokens = commandLine.trim().split(/\s+/);
  let exe: string | undefined;
  for (const tok of tokens) {
    if (tok === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
    exe = tok;
    break;
  }
  if (!exe) return false;

  if (exe.includes("/")) {
    // Relative or absolute path: it is not on PATH, so check the file itself.
    try {
      accessSync(exe, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const target = exe;
  return (process.env["PATH"] ?? "")
    .split(":")
    .some((p) => p !== "" && existsSync(join(p, target)));
}
