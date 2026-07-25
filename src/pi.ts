/**
 * Driving the pi coding agent and reading its event stream.
 *
 * pi runs with `-p --mode json`, which emits one JSON event per line. That
 * gives far better signals than a bare exit code:
 *
 *   - did the model call any write tool? (if not, it did nothing at all)
 *   - did any tool error?
 *   - how many tokens went in, which is how you spot context overflow
 *
 * A local model very often "answers" by describing the code instead of writing
 * it. The exit code in that case is 0. Counting write-tool calls is the only
 * way to tell the difference.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./proc.js";

/** pi tool names that actually modify the repository. */
const WRITE_TOOLS = new Set([
  "edit",
  "write",
  "multi_edit",
  "apply_patch",
  "create_file",
  "str_replace",
]);

export interface PiEvent {
  type: string;
  toolName?: string;
  isError?: boolean;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input?: number; output?: number; totalTokens?: number };
  };
  messages?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
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

export function parseEvents(jsonl: string): PiEvent[] {
  const events: PiEvent[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed) as PiEvent);
    } catch {
      /* partial line from a killed process */
    }
  }
  return events;
}

export function analyzeEvents(events: PiEvent[]): {
  writeCalls: number;
  toolErrors: number;
  totalTokens: number;
  finalText: string;
} {
  let writeCalls = 0;
  let toolErrors = 0;
  let totalTokens = 0;
  let finalText = "";

  for (const e of events) {
    if (e.type === "tool_execution_end") {
      if (e.isError === true) toolErrors += 1;
      else if (e.toolName && WRITE_TOOLS.has(e.toolName)) writeCalls += 1;
    }
    const usage = e.message?.usage?.totalTokens;
    if (typeof usage === "number" && usage > totalTokens) totalTokens = usage;
    if (e.type === "agent_end") {
      const last = e.messages?.[e.messages.length - 1];
      const text = last?.content?.filter((c) => c.type === "text").map((c) => c.text ?? "");
      if (text && text.length > 0) finalText = text.join("\n");
    }
  }
  return { writeCalls, toolErrors, totalTokens, finalText };
}

const HINT_PATTERNS: Array<[RegExp, string]> = [
  [/context length|context window|too many tokens|maximum context/i, "context window exceeded — raise the served context length"],
  [/model .{0,40}not found|no such model/i, "model not found on the backend"],
  [/ECONNREFUSED|connection refused/i, "connection refused — the inference server is not reachable"],
  [/rate limit/i, "rate limited by the backend"],
  [/unsupported|invalid.{0,20}role|developer role/i, "the backend rejected a request field (check the pi compat flags)"],
];

export function extractHints(raw: string): string[] {
  const hints = new Set<string>();
  for (const [re, message] of HINT_PATTERNS) if (re.test(raw)) hints.add(message);
  return [...hints];
}

export async function runPi(prompt: string, options: PiOptions): Promise<PiRunResult> {
  const args = ["-p", "--mode", "json", "--approve"];
  if (options.provider) args.push("--provider", options.provider);
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.saveSession && options.sessionName) {
    args.push("--name", options.sessionName);
  } else {
    args.push("--no-session");
  }
  // A fresh session per call is deliberate: carrying context between features
  // fills the window with stale noise and the local model starts truncating
  // exactly what matters. AGENTS.md is discovered by pi automatically, so it is
  // never attached by hand — that would just duplicate it.
  for (const file of options.attachments ?? []) args.push(`@${file}`);
  args.push(prompt); // the whole prompt as a single argument

  const result = await run(options.piBin, args, {
    cwd: options.cwd,
    timeoutSeconds: options.timeoutSeconds,
    outFile: options.rawPath,
  });

  let raw = "";
  try {
    raw = readFileSync(options.rawPath, "utf8");
  } catch {
    raw = result.stdout;
  }
  const events = parseEvents(raw);
  const analysis = analyzeEvents(events);

  return {
    code: result.code,
    timedOut: result.timedOut,
    aborted: result.aborted,
    ...analysis,
    events,
    rawPath: options.rawPath,
    hints: extractHints(raw),
  };
}

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
export async function probeToolCalling(
  options: Omit<PiOptions, "rawPath" | "cwd" | "timeoutSeconds"> & { timeoutSeconds?: number },
): Promise<{ ok: boolean; writeCalls: number; wroteFile: boolean; finalText: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-probe-"));
  try {
    const rawPath = join(dir, "probe.jsonl");
    const result = await runPi(
      "Create a file named hello.txt containing exactly the text HI. Use the write tool. Do not explain.",
      {
        ...options,
        cwd: dir,
        timeoutSeconds: options.timeoutSeconds ?? 300,
        rawPath,
      },
    );
    let wroteFile = false;
    try {
      wroteFile = readFileSync(join(dir, "hello.txt"), "utf8").includes("HI");
    } catch {
      wroteFile = false;
    }
    return {
      ok: result.writeCalls > 0 && wroteFile,
      writeCalls: result.writeCalls,
      wroteFile,
      finalText: result.finalText,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Register a local model with pi by merging into ~/.pi/agent/models.json. */
export interface PiModelRegistration {
  providerName: string;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  compat?: Record<string, boolean> | undefined;
}

export function registerModel(
  modelsJsonPath: string,
  reg: PiModelRegistration,
): { backupPath: string | null } {
  let data: {
    providers?: Record<
      string,
      {
        baseUrl?: string;
        api?: string;
        apiKey?: string;
        compat?: Record<string, boolean>;
        models?: Array<Record<string, unknown>>;
      }
    >;
    [k: string]: unknown;
  } = {};

  let backupPath: string | null = null;
  try {
    const existing = readFileSync(modelsJsonPath, "utf8");
    data = JSON.parse(existing) as typeof data;
    backupPath = `${modelsJsonPath}.bak.${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    writeFileSync(backupPath, existing);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // A malformed models.json breaks every provider in pi, not just ours.
      throw new Error(
        `${modelsJsonPath} exists but is not valid JSON. Fix or move it before continuing.`,
      );
    }
  }

  data.providers ??= {};
  const provider = (data.providers[reg.providerName] ??= {});
  provider.baseUrl = reg.baseUrl;
  provider.api = "openai-completions";
  provider.apiKey = provider.apiKey ?? "local";
  if (reg.compat) provider.compat = { ...provider.compat, ...reg.compat };

  const models = (provider.models ?? []).filter((m) => m["id"] !== reg.modelId);
  models.push({
    id: reg.modelId,
    input: ["text"],
    reasoning: reg.reasoning,
    contextWindow: reg.contextWindow,
    maxTokens: reg.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  provider.models = models;

  writeFileSync(modelsJsonPath, JSON.stringify(data, null, 2) + "\n");
  return { backupPath };
}

export async function piSeesModel(
  piBin: string,
  provider: string,
  modelId: string,
): Promise<boolean> {
  const result = await run(piBin, ["--list-models"], { timeoutSeconds: 60 });
  if (result.code !== 0) return false;
  const clean = result.stdout.replace(/\[[0-9;]*[A-Za-z]/g, "");
  return clean
    .split("\n")
    .some((line) => {
      const cols = line.trim().split(/\s+/);
      return cols[0] === provider && cols[1] === modelId;
    });
}
