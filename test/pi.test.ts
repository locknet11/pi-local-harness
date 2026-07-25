import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeEvents, extractHints, parseEvents, registerModel } from "../src/pi.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const event = (o: unknown) => JSON.stringify(o);

describe("event stream analysis", () => {
  it("ignores non-JSON noise in the stream", () => {
    const events = parseEvents(
      ["not json", event({ type: "agent_start" }), "", "{broken"].join("\n"),
    );
    expect(events).toHaveLength(1);
  });

  it("counts successful write-tool calls", () => {
    const events = parseEvents(
      [
        event({ type: "tool_execution_end", toolName: "write", isError: false }),
        event({ type: "tool_execution_end", toolName: "edit", isError: false }),
        event({ type: "tool_execution_end", toolName: "read", isError: false }),
      ].join("\n"),
    );
    expect(analyzeEvents(events).writeCalls).toBe(2);
  });

  it("does not count a failed write as work done", () => {
    const events = parseEvents(
      event({ type: "tool_execution_end", toolName: "write", isError: true }),
    );
    const a = analyzeEvents(events);
    expect(a.writeCalls).toBe(0);
    expect(a.toolErrors).toBe(1);
  });

  it("detects the model that describes instead of writing", () => {
    // Exit code 0, plausible prose, zero tools: the most common local-model
    // failure and invisible without this check.
    const events = parseEvents(
      [
        event({ type: "agent_start" }),
        event({
          type: "turn_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "You would create a file called impl.py..." }],
            usage: { totalTokens: 900 },
          },
        }),
      ].join("\n"),
    );
    expect(analyzeEvents(events).writeCalls).toBe(0);
  });

  it("reports peak token usage", () => {
    const events = parseEvents(
      [
        event({ type: "turn_end", message: { usage: { totalTokens: 1200 } } }),
        event({ type: "turn_end", message: { usage: { totalTokens: 8400 } } }),
      ].join("\n"),
    );
    expect(analyzeEvents(events).totalTokens).toBe(8400);
  });

  it("extracts the final assistant text", () => {
    const events = parseEvents(
      event({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: "all done" }] }],
      }),
    );
    expect(analyzeEvents(events).finalText).toBe("all done");
  });

  // pi exits 0 when every request to the backend failed. Without reading the
  // stopReason, a 26B model that cannot be loaded looks exactly like a model
  // that chose not to write anything, and the harness retries it three times.
  it("reports a turn that ended with a backend error", () => {
    const events = parseEvents(
      event({
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage:
            '400: {"message":"Failed to load model \\"google/gemma-4-26b\\". Error: Model loading was stopped due to insufficient system resources.","type":"invalid_request_error"}',
        },
      }),
    );
    const analysis = analyzeEvents(events);
    expect(analysis.backendError).toBe(
      "400: Failed to load model \"google/gemma-4-26b\". Error: Model loading was stopped due to insufficient system resources.",
    );
    expect(analysis.writeCalls).toBe(0);
  });

  it("leaves a plain error message alone", () => {
    const events = parseEvents(
      event({ type: "turn_end", message: { stopReason: "error", errorMessage: "socket hang up" } }),
    );
    expect(analyzeEvents(events).backendError).toBe("socket hang up");
  });

  it("reports no backend error for a normal turn", () => {
    const events = parseEvents(event({ type: "turn_end", message: { stopReason: "stop" } }));
    expect(analyzeEvents(events).backendError).toBe("");
  });
});

describe("streaming log size", () => {
  it("keeps only actionable events, not per-token updates", async () => {
    // pi emits a message_update per streamed token, each carrying the whole
    // message so far. Storing them all produced a 13.7 MB file for ONE call.
    const { runPi } = await import("../src/pi.js");
    const fake = join(dir, "fake-pi.cjs");
    writeFileSync(
      fake,
      `#!/usr/bin/env node
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "agent_start" });
const big = "x".repeat(2000);
for (let i = 0; i < 500; i++) {
  emit({ type: "message_update", message: { content: [{ type: "text", text: big }] } });
}
emit({ type: "tool_execution_end", toolName: "write", isError: false });
emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
`,
    );
    chmodSync(fake, 0o755);
    const rawPath = join(dir, "out.jsonl");
    const result = await runPi("go", {
      piBin: fake,
      provider: "fake",
      model: "fake",
      cwd: dir,
      timeoutSeconds: 60,
      rawPath,
    });

    expect(result.writeCalls).toBe(1);
    expect(result.finalText).toBe("done");
    // 500 x 2 kB of updates were emitted; the stored log must stay tiny.
    const stored = readFileSync(rawPath, "utf8");
    expect(stored.length).toBeLessThan(20_000);
    expect(stored).not.toContain("message_update");
  });

  it("prefers the backend's own error over the guessed hints", async () => {
    // The keyword hints are a guess over raw output, and they do misfire: a
    // failed model load once came out as "rate limited by the backend". When
    // the backend actually said what went wrong, that is the only report.
    const { runPi } = await import("../src/pi.js");
    const fake = join(dir, "fake-pi-error.cjs");
    writeFileSync(
      fake,
      `#!/usr/bin/env node
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "agent_start" });
emit({ type: "turn_end", message: { role: "assistant", stopReason: "error",
  errorMessage: '429: {"message":"failed: rate limit reached","type":"error"}' } });
emit({ type: "agent_settled" });
`,
    );
    chmodSync(fake, 0o755);
    const result = await runPi("go", {
      piBin: fake,
      provider: "fake",
      model: "fake",
      cwd: dir,
      timeoutSeconds: 60,
      rawPath: join(dir, "err.jsonl"),
    });

    expect(result.code).toBe(0);
    expect(result.backendError).toBe("429: failed: rate limit reached");
    expect(result.hints).toEqual([]);
  });
});

describe("backend hints", () => {
  it("flags context overflow", () => {
    expect(extractHints('{"error":"context length exceeded"}')[0]).toMatch(/context window/);
  });
  it("flags a missing model and a dead server", () => {
    expect(extractHints('{"error":"model xyz not found"}').join()).toMatch(/not found/);
    expect(extractHints("Error: connect ECONNREFUSED").join()).toMatch(/not reachable/);
  });
  it("says nothing when the stream is clean", () => {
    expect(extractHints('{"type":"agent_end"}')).toEqual([]);
  });

  it("does not fire on the model's own reasoning text", () => {
    // A real false positive: the model reasoning about "invalid roles" and
    // "context length" made the harness warn about a backend problem that did
    // not exist. Noisy warnings make the real ones worthless.
    const thinking = JSON.stringify({
      type: "turn_end",
      message: {
        content: [
          {
            type: "thinking",
            thinking:
              "I should check the context length of the input and reject any invalid role in the config parser.",
          },
        ],
      },
    });
    expect(extractHints(thinking)).toEqual([]);
  });

  it("still fires when a genuine error mentions the same words", () => {
    expect(
      extractHints('{"error":{"message":"unsupported parameter: reasoning_effort"}}').join(),
    ).toMatch(/compat flags/);
  });
});

describe("registering a model with pi", () => {
  it("creates models.json when absent", () => {
    const path = join(dir, "models.json");
    registerModel(path, {
      providerName: "lmstudio",
      baseUrl: "http://localhost:1234/v1",
      modelId: "google/gemma-4-26b",
      contextWindow: 32768,
      maxTokens: 8192,
      reasoning: false,
      compat: { supportsDeveloperRole: false },
    });
    const data = JSON.parse(readFileSync(path, "utf8"));
    expect(data.providers.lmstudio.baseUrl).toBe("http://localhost:1234/v1");
    expect(data.providers.lmstudio.models[0].id).toBe("google/gemma-4-26b");
    expect(data.providers.lmstudio.compat.supportsDeveloperRole).toBe(false);
  });

  it("merges without destroying other providers or settings", () => {
    const path = join(dir, "models.json");
    writeFileSync(
      path,
      JSON.stringify({
        providers: { other: { baseUrl: "http://x/v1", models: [{ id: "keepme" }] } },
        defaultModel: "keepme",
      }),
    );
    registerModel(path, {
      providerName: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen3:8b",
      contextWindow: 32768,
      maxTokens: 8192,
      reasoning: false,
    });
    const data = JSON.parse(readFileSync(path, "utf8"));
    expect(data.providers.other.models[0].id).toBe("keepme");
    expect(data.defaultModel).toBe("keepme");
    expect(data.providers.ollama.models[0].id).toBe("qwen3:8b");
  });

  it("replaces an existing entry for the same model instead of duplicating", () => {
    const path = join(dir, "models.json");
    const reg = {
      providerName: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen3:8b",
      contextWindow: 8192,
      maxTokens: 4096,
      reasoning: false,
    };
    registerModel(path, reg);
    registerModel(path, { ...reg, contextWindow: 32768 });
    const data = JSON.parse(readFileSync(path, "utf8"));
    expect(data.providers.ollama.models).toHaveLength(1);
    expect(data.providers.ollama.models[0].contextWindow).toBe(32768);
  });

  it("makes a backup before overwriting", () => {
    const path = join(dir, "models.json");
    writeFileSync(path, JSON.stringify({ providers: {} }));
    const { backupPath } = registerModel(path, {
      providerName: "ollama",
      baseUrl: "http://x/v1",
      modelId: "m",
      contextWindow: 1,
      maxTokens: 1,
      reasoning: false,
    });
    expect(backupPath).toBeTruthy();
    expect(readFileSync(backupPath!, "utf8")).toContain("providers");
  });

  it("refuses to touch a corrupt models.json rather than destroying it", () => {
    const path = join(dir, "models.json");
    writeFileSync(path, "{ this is not json");
    expect(() =>
      registerModel(path, {
        providerName: "ollama",
        baseUrl: "http://x/v1",
        modelId: "m",
        contextWindow: 1,
        maxTokens: 1,
        reasoning: false,
      }),
    ).toThrow(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{ this is not json");
  });
});
