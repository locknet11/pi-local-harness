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
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./proc.js";
import { color } from "./ui.js";
/** pi tool names that actually modify the repository. */
const WRITE_TOOLS = new Set([
    "edit",
    "write",
    "multi_edit",
    "apply_patch",
    "create_file",
    "str_replace",
]);
/**
 * Live view of a turn.
 *
 * pi re-sends the WHOLE message on every `message_update`, so printing an
 * update verbatim reprints everything written so far. Each content part is
 * tracked by index and only the new tail is emitted, which turns the stream
 * back into something that reads like typing.
 */
export function createWatcher(write = (s) => process.stdout.write(s)) {
    const shown = new Map();
    let lastKind = "";
    const emit = (kind, index, full) => {
        const already = shown.get(index) ?? 0;
        if (full.length <= already)
            return;
        const delta = full.slice(already);
        shown.set(index, full.length);
        if (kind !== lastKind) {
            write(`\n${color.dim(kind === "thinking" ? "· thinking " : "· model ")}\n`);
            lastKind = kind;
        }
        write(kind === "thinking" ? color.dim(delta) : delta);
    };
    return (event) => {
        if (event.type === "message_update") {
            const parts = event.message?.content ?? [];
            parts.forEach((part, index) => {
                if (part.type === "thinking" && typeof part.thinking === "string") {
                    emit("thinking", index, part.thinking);
                }
                else if (part.type === "text" && typeof part.text === "string") {
                    emit("text", index, part.text);
                }
            });
            return;
        }
        if (event.type === "tool_execution_start") {
            // The arguments can be a whole file; one line of it is enough to follow along.
            const detail = Object.entries(event.args ?? {})
                .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, " ").slice(0, 60)}`)
                .join(" ");
            write(`\n${color.cyan(`▸ ${event.toolName ?? "tool"}`)} ${color.dim(detail)}\n`);
            lastKind = "";
            return;
        }
        if (event.type === "tool_execution_end") {
            write(event.isError === true ? color.red("  ✖ tool failed\n") : color.dim("  ✔\n"));
            lastKind = "";
            return;
        }
        if (event.type === "agent_settled")
            write("\n");
    };
}
export function parseEvents(jsonl) {
    const events = [];
    for (const line of jsonl.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{"))
            continue;
        try {
            events.push(JSON.parse(trimmed));
        }
        catch {
            /* partial line from a killed process */
        }
    }
    return events;
}
/**
 * pi reports a failed request inside the event stream, not through its exit
 * code: the turn ends with `stopReason: "error"` and an `errorMessage`, and pi
 * still exits 0. The message body is usually `<status>: <provider JSON>`, whose
 * only readable part is the inner `message` field.
 */
export function readableBackendError(raw) {
    const match = /^(\d{3}):\s*(\{[\s\S]*\})\s*$/.exec(raw.trim());
    if (!match?.[2])
        return raw.trim();
    try {
        const body = JSON.parse(match[2]);
        const inner = body.error?.message ?? body.message;
        if (typeof inner === "string" && inner !== "")
            return `${match[1]}: ${inner}`;
    }
    catch {
        /* not JSON after all — fall through */
    }
    return raw.trim();
}
export function analyzeEvents(events) {
    let writeCalls = 0;
    let toolErrors = 0;
    let totalTokens = 0;
    let finalText = "";
    let backendError = "";
    for (const e of events) {
        if (e.message?.stopReason === "error" && typeof e.message.errorMessage === "string") {
            backendError = readableBackendError(e.message.errorMessage);
        }
        if (e.type === "tool_execution_end") {
            if (e.isError === true)
                toolErrors += 1;
            else if (e.toolName && WRITE_TOOLS.has(e.toolName))
                writeCalls += 1;
        }
        const usage = e.message?.usage?.totalTokens;
        if (typeof usage === "number" && usage > totalTokens)
            totalTokens = usage;
        if (e.type === "agent_end") {
            const last = e.messages?.[e.messages.length - 1];
            const text = last?.content?.filter((c) => c.type === "text").map((c) => c.text ?? "");
            if (text && text.length > 0)
                finalText = text.join("\n");
        }
    }
    return { writeCalls, toolErrors, totalTokens, finalText, backendError };
}
const HINT_PATTERNS = [
    [
        /(context (length|window)|maximum context).{0,40}(exceed|too (long|large|many)|overflow)|exceeds? the (maximum )?context/i,
        "context window exceeded — raise the served context length",
    ],
    [/"?model"?[^\n]{0,40}\b(not found|does not exist|unknown model)/i, "model not found on the backend"],
    [/ECONNREFUSED|connection refused/i, "connection refused — the inference server is not reachable"],
    [/\brate.?limit(ed|ing)?\b/i, "rate limited by the backend"],
    [
        /(unsupported|unrecognized|invalid)[^\n]{0,40}\b(developer|role|reasoning_effort|parameter)\b/i,
        "the backend rejected a request field (check the pi compat flags)",
    ],
];
/**
 * Backend problems worth surfacing.
 *
 * Only lines that actually look like errors are scanned. The model's own
 * reasoning text routinely contains words like "invalid" and "context length",
 * and matching those produced confident warnings about problems that did not
 * exist — noise that makes the real warnings worthless.
 */
export function extractHints(raw) {
    const hints = new Set();
    const errorish = raw
        .split("\n")
        .filter((line) => /\b(error|err|failed|failure|exception|status.?[45]\d\d)\b/i.test(line))
        .join("\n");
    if (errorish === "")
        return [];
    for (const [re, message] of HINT_PATTERNS)
        if (re.test(errorish))
            hints.add(message);
    return [...hints];
}
/**
 * Events worth keeping.
 *
 * pi emits a `message_update` per streamed token, and each one carries the
 * ENTIRE message so far — so a single long turn produced a 13.7 MB log in
 * testing. Keeping all of it means quadratic disk growth and re-parsing
 * megabytes of JSON for a handful of numbers. Only these types carry
 * information the harness acts on.
 */
const KEEP_EVENT_TYPES = new Set([
    "session",
    "agent_start",
    "turn_start",
    "turn_end",
    "tool_execution_start",
    "tool_execution_end",
    "agent_end",
    "agent_settled",
    "compaction_start",
    "compaction_end",
    "auto_retry_start",
    "auto_retry_end",
    "error",
]);
/** Text scanned for backend hints; bounded so a runaway turn cannot eat RAM. */
const HINT_BUFFER_LIMIT = 256 * 1024;
export async function runPi(prompt, options) {
    const args = ["-p", "--mode", "json", "--approve"];
    if (options.provider)
        args.push("--provider", options.provider);
    if (options.model)
        args.push("--model", options.model);
    if (options.thinking)
        args.push("--thinking", options.thinking);
    if (options.saveSession && options.sessionName) {
        args.push("--name", options.sessionName);
    }
    else {
        args.push("--no-session");
    }
    // A fresh session per call is deliberate: carrying context between features
    // fills the window with stale noise and the local model starts truncating
    // exactly what matters. AGENTS.md is discovered by pi automatically, so it is
    // never attached by hand — that would just duplicate it.
    for (const file of options.attachments ?? [])
        args.push(`@${file}`);
    args.push(prompt); // the whole prompt as a single argument
    // Parse while streaming and keep only the events that matter, instead of
    // buffering every token-level update and re-reading it afterwards.
    const events = [];
    let pending = "";
    let hintBuffer = "";
    // Append kept events as they arrive, so a stalled run can still be watched
    // with `tail -f` — while staying orders of magnitude smaller than the raw
    // token-level stream.
    let sink = null;
    try {
        sink = createWriteStream(options.rawPath, { flags: "w" });
    }
    catch {
        sink = null;
    }
    const addHintText = (text) => {
        if (hintBuffer.length < HINT_BUFFER_LIMIT)
            hintBuffer += text.slice(0, 4096) + "\n";
    };
    const watch = options.watch === true ? createWatcher() : null;
    const consumeLine = (line) => {
        const trimmed = line.trim();
        if (trimmed === "")
            return;
        let event = null;
        if (trimmed.startsWith("{")) {
            try {
                event = JSON.parse(trimmed);
            }
            catch {
                event = null;
            }
        }
        // Before the KEEP filter: the live view is driven by the token-level
        // updates the harness deliberately does not store.
        if (watch && event !== null)
            watch(event);
        // Scan only what the machinery said, never what the model wrote. A brief
        // asking for "rate limiting" produced an AGENTS.md full of the phrase, and
        // the scanner reported the backend as rate limited on a run that succeeded.
        if (event === null) {
            addHintText(trimmed); // not an event at all: a crash, a stack trace
        }
        else if (event.type === "error") {
            addHintText(trimmed);
        }
        else if (event.message?.stopReason === "error" && event.message.errorMessage) {
            addHintText(event.message.errorMessage);
        }
        if (event === null || !KEEP_EVENT_TYPES.has(event.type))
            return;
        events.push(event);
        sink?.write(trimmed + "\n");
    };
    const result = await run(options.piBin, args, {
        cwd: options.cwd,
        timeoutSeconds: options.timeoutSeconds,
        onStdout: (chunk) => {
            pending += chunk;
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines)
                consumeLine(line);
        },
    });
    consumeLine(pending);
    // Anything the child wrote to stderr never reaches onStdout.
    if (result.stderr) {
        hintBuffer += result.stderr.slice(0, HINT_BUFFER_LIMIT);
    }
    sink?.end();
    const analysis = analyzeEvents(events);
    return {
        code: result.code,
        timedOut: result.timedOut,
        aborted: result.aborted,
        ...analysis,
        events,
        rawPath: options.rawPath,
        // The guessed hints are keyword matches over raw output and do misfire; when
        // the backend told us exactly what went wrong, that is the only thing worth
        // printing.
        hints: analysis.backendError === "" ? extractHints(hintBuffer) : [],
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
export async function probeToolCalling(options) {
    const dir = mkdtempSync(join(tmpdir(), "pi-harness-probe-"));
    try {
        const rawPath = join(dir, "probe.jsonl");
        const result = await runPi("Create a file named hello.txt containing exactly the text HI. Use the write tool. Do not explain.", {
            ...options,
            cwd: dir,
            timeoutSeconds: options.timeoutSeconds ?? 300,
            rawPath,
        });
        let wroteFile = false;
        try {
            wroteFile = readFileSync(join(dir, "hello.txt"), "utf8").includes("HI");
        }
        catch {
            wroteFile = false;
        }
        return {
            ok: result.writeCalls > 0 && wroteFile,
            writeCalls: result.writeCalls,
            wroteFile,
            finalText: result.finalText,
        };
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
export function registerModel(modelsJsonPath, reg) {
    let data = {};
    let backupPath = null;
    try {
        const existing = readFileSync(modelsJsonPath, "utf8");
        data = JSON.parse(existing);
        backupPath = `${modelsJsonPath}.bak.${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
        writeFileSync(backupPath, existing);
    }
    catch (err) {
        if (err.code !== "ENOENT") {
            // A malformed models.json breaks every provider in pi, not just ours.
            throw new Error(`${modelsJsonPath} exists but is not valid JSON. Fix or move it before continuing.`);
        }
    }
    data.providers ??= {};
    const provider = (data.providers[reg.providerName] ??= {});
    provider.baseUrl = reg.baseUrl;
    provider.api = "openai-completions";
    provider.apiKey = provider.apiKey ?? "local";
    // The provider definition is authoritative for compat. Merging into whatever
    // was there before would leave stale flags behind — and a stale
    // `supportsReasoningEffort: false` silently stops pi from ever sending the
    // field that turns thinking off.
    if (reg.compat)
        provider.compat = { ...reg.compat };
    else
        delete provider.compat;
    const models = (provider.models ?? []).filter((m) => m["id"] !== reg.modelId);
    models.push({
        id: reg.modelId,
        input: ["text"],
        reasoning: reg.reasoning,
        contextWindow: reg.contextWindow,
        maxTokens: reg.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(reg.thinkingLevelMap ? { thinkingLevelMap: reg.thinkingLevelMap } : {}),
    });
    provider.models = models;
    writeFileSync(modelsJsonPath, JSON.stringify(data, null, 2) + "\n");
    return { backupPath };
}
export async function piSeesModel(piBin, provider, modelId) {
    const result = await run(piBin, ["--list-models"], { timeoutSeconds: 60 });
    if (result.code !== 0)
        return false;
    const clean = result.stdout.replace(/\[[0-9;]*[A-Za-z]/g, "");
    return clean
        .split("\n")
        .some((line) => {
        const cols = line.trim().split(/\s+/);
        return cols[0] === provider && cols[1] === modelId;
    });
}
//# sourceMappingURL=pi.js.map