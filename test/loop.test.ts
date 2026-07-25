/**
 * End-to-end mechanics against a FAKE pi.
 *
 * No network, no GPU, no tokens. This exercises exactly what breaks silently
 * when you only ever test against a real model: state transitions, retries,
 * rollback, and the three "green but fake" failure modes.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type HarnessConfig } from "../src/config.js";
import * as git from "../src/git.js";
import { runLoop } from "../src/loop.js";
import { run } from "../src/proc.js";
import { readSpec, summarize } from "../src/spec.js";
import { configureLogging } from "../src/ui.js";

configureLogging({ mirror: false });

const SPEC = `## feature: Add
id: F001
status: PENDING
depends: none
acceptance:
  - add works

## feature: Subtract
id: F002
status: PENDING
depends: F001
acceptance:
  - sub works

## feature: Multiply
id: F003
status: PENDING
depends: F002
acceptance:
  - mul works
`;

/**
 * Fake pi. FAKE_MODE selects the behaviour under test:
 *   good     writes code AND a test, emits write events
 *   noop     replies with prose, touches nothing (exit 0)
 *   broken   writes code that fails the suite
 *   notests  writes code but no test file, leaving the old suite green
 *   hang     never returns
 */
const FAKE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.FAKE_MODE || "good";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "session", version: 3 });
emit({ type: "agent_start" });
const write = (name) => emit({ type: "tool_execution_end", toolCallId: "1", toolName: name, isError: false });

if (mode === "hang") { setTimeout(() => {}, 1e9); }
else if (mode === "noop") {
  emit({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "You would create impl.js" }], usage: { totalTokens: 900 } } });
  emit({ type: "agent_end", messages: [] });
  emit({ type: "agent_settled" });
} else {
  if (mode === "broken") {
    fs.writeFileSync("impl.js", "broken");
    fs.mkdirSync("tests", { recursive: true });
    fs.writeFileSync("tests/test_" + Date.now() + ".js", "// test");
    try { fs.unlinkSync(".fake_pass"); } catch {}
  } else if (mode === "notests") {
    fs.appendFileSync("impl.js", "\\nfunction stub() { return 0.0; }\\n");
    fs.writeFileSync(".fake_pass", "ok");
  } else {
    fs.writeFileSync("impl.js", "ok");
    fs.mkdirSync("tests", { recursive: true });
    fs.writeFileSync("tests/test_" + Date.now() + "_" + Math.random().toString(36).slice(2) + ".js", "// test");
    fs.writeFileSync(".fake_pass", "ok");
  }
  write("write");
  emit({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { totalTokens: 2400 } } });
  emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
  emit({ type: "agent_settled" });
}
`;

let dir: string;
let fakePi: string;

async function makeProject(): Promise<void> {
  writeFileSync(join(dir, "PROJECT_SPEC.md"), SPEC);
  writeFileSync(join(dir, "AGENTS.md"), "# Rules\nTest project.\n");
  mkdirSync(join(dir, ".harness"), { recursive: true });
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["config", "user.email", "t@t.local"], { cwd: dir });
  await run("git", ["config", "user.name", "test"], { cwd: dir });
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-qm", "init"], { cwd: dir });
}

function makeConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return loadConfig(dir, {
    piBin: fakePi,
    provider: "fake",
    model: "fake-model",
    // The fake suite passes iff the fake pi left the .fake_pass marker.
    testCommand: "test -f .fake_pass",
    cooldown: 0,
    maxRetries: 2,
    maxConsecutiveFailures: 5,
    featureTimeout: 30,
    testTimeout: 30,
    ...overrides,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "loop-test-"));
  fakePi = join(dir, "fake-pi.cjs");
  writeFileSync(fakePi, FAKE_PI);
  chmodSync(fakePi, 0o755);
  await makeProject();
});
afterEach(() => {
  delete process.env["FAKE_MODE"];
  rmSync(dir, { recursive: true, force: true });
});

const ctx = () => ({ cwd: dir, config: makeConfig(), tempDir: join(dir, ".harness", "tmp", "run") });
const statuses = () => readSpec(join(dir, "PROJECT_SPEC.md")).map((f) => f.status);

describe("happy path", () => {
  it("completes the whole backlog and commits one per feature", async () => {
    process.env["FAKE_MODE"] = "good";
    const summary = await runLoop(ctx());
    expect(summary.stoppedBecause).toBe("done");
    expect(statuses()).toEqual(["COMPLETED", "COMPLETED", "COMPLETED"]);

    const logOut = await run("git", ["log", "--oneline"], { cwd: dir });
    expect(logOut.stdout.match(/feat\(F00\d\)/g)).toHaveLength(3);
  });

  it("stops after one feature with --once", async () => {
    process.env["FAKE_MODE"] = "good";
    await runLoop(ctx(), { once: true });
    expect(summarize(readSpec(join(dir, "PROJECT_SPEC.md"))).completed).toBe(1);
  });

  it("runs a single named feature and leaves the others alone", async () => {
    process.env["FAKE_MODE"] = "good";
    await runLoop(ctx(), { onlyFeatureId: "F002" });
    expect(statuses()).toEqual(["PENDING", "COMPLETED", "PENDING"]);
  });
});

describe("silent failure: the model describes instead of writing", () => {
  it("does not accept a turn that touched no files", async () => {
    process.env["FAKE_MODE"] = "noop";
    const summary = await runLoop(ctx(), { once: true });
    expect(statuses()[0]).toBe("FAILED");
    expect(summary.completed).toBe(0);
  });
});

describe("silent failure: code with no tests", () => {
  it("refuses a feature that left the suite green without adding tests", async () => {
    // The real incident: two features marked COMPLETED on top of a duplicated
    // `return 0.0` stub, because the previous feature's tests still passed.
    process.env["FAKE_MODE"] = "notests";
    await runLoop(ctx(), { once: true });
    expect(statuses()[0]).toBe("FAILED");
  });

  it("accepts it when the check is disabled", async () => {
    process.env["FAKE_MODE"] = "notests";
    const c = { cwd: dir, config: makeConfig({ requireTestChanges: false }), tempDir: join(dir, ".harness", "tmp", "run") };
    await runLoop(c, { once: true });
    expect(statuses()[0]).toBe("COMPLETED");
  });
});

describe("failing tests", () => {
  it("retries, then fails the feature and rolls the tree back", async () => {
    process.env["FAKE_MODE"] = "broken";
    await runLoop(ctx(), { once: true });
    expect(statuses()[0]).toBe("FAILED");
    // Rollback must remove the broken file, so the next feature starts clean.
    expect(existsSync(join(dir, "impl.js"))).toBe(false);
  });

  it("keeps the broken tree when rollback is disabled", async () => {
    process.env["FAKE_MODE"] = "broken";
    const c = {
      cwd: dir,
      config: makeConfig({ rollbackOnFail: false, maxRetries: 1 }),
      tempDir: join(dir, ".harness", "tmp", "run"),
    };
    await runLoop(c, { once: true });
    expect(existsSync(join(dir, "impl.js"))).toBe(true);
  });

  it("trips the global circuit breaker after repeated failures", async () => {
    // Independent features: with a dependency chain the loop would correctly
    // report "blocked" after the first failure, before the breaker can count.
    writeFileSync(
      join(dir, "PROJECT_SPEC.md"),
      SPEC.replace(/depends: F00\d/g, "depends: none"),
    );
    process.env["FAKE_MODE"] = "noop";
    const c = {
      cwd: dir,
      config: makeConfig({ maxRetries: 1, maxConsecutiveFailures: 2 }),
      tempDir: join(dir, ".harness", "tmp", "run"),
    };
    const summary = await runLoop(c);
    expect(summary.stoppedBecause).toBe("circuit-breaker");
    expect(summary.failed).toBe(2);
    // It must stop rather than burn the GPU on the rest of the backlog.
    expect(statuses()[2]).toBe("PENDING");
  });
});

describe("environment faults", () => {
  it("stops and leaves the feature PENDING when the test command is missing", async () => {
    process.env["FAKE_MODE"] = "good";
    const c = {
      cwd: dir,
      config: makeConfig({ testCommand: "no_such_runner_xyz_123" }),
      tempDir: join(dir, ".harness", "tmp", "run"),
    };
    const summary = await runLoop(c, { once: true });
    expect(summary.stoppedBecause).toBe("environment");
    // Blaming the code for a broken environment would poison the backlog.
    expect(statuses()[0]).toBe("PENDING");
  });
});

describe("timeouts", () => {
  it("kills a hung agent and fails the feature", async () => {
    process.env["FAKE_MODE"] = "hang";
    const c = {
      cwd: dir,
      config: makeConfig({ featureTimeout: 1, maxRetries: 1 }),
      tempDir: join(dir, ".harness", "tmp", "run"),
    };
    await runLoop(c, { once: true });
    expect(statuses()[0]).toBe("FAILED");
  }, 30000);
});

describe("dependencies", () => {
  it("reports blocked pending features instead of spinning", async () => {
    process.env["FAKE_MODE"] = "noop";
    const c = {
      cwd: dir,
      config: makeConfig({ maxRetries: 1, maxConsecutiveFailures: 1 }),
      tempDir: join(dir, ".harness", "tmp", "run"),
    };
    await runLoop(c); // F001 fails -> F002/F003 are unreachable
    const summary = await runLoop(c);
    expect(summary.stoppedBecause).toBe("blocked");
  });
});

describe("git integration", () => {
  it("counts test files touched since a checkpoint", async () => {
    const gitCtx = { cwd: dir };
    const ref = await git.checkpoint(gitCtx, "before");
    writeFileSync(join(dir, "src.js"), "code");
    expect(await git.testFilesChangedSince(gitCtx, ref)).toBe(0);
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests", "thing.test.js"), "test");
    expect(await git.testFilesChangedSince(gitCtx, ref)).toBe(1);
  });

  it("rolls back to a checkpoint, discarding untracked files", async () => {
    const gitCtx = { cwd: dir };
    const ref = await git.checkpoint(gitCtx, "before");
    writeFileSync(join(dir, "garbage.js"), "junk");
    expect(await git.rollbackTo(gitCtx, ref)).toBe(true);
    expect(existsSync(join(dir, "garbage.js"))).toBe(false);
  });
});

describe("resumption", () => {
  it("finishes a backlog left half-done by an earlier run", async () => {
    process.env["FAKE_MODE"] = "good";
    await runLoop(ctx(), { once: true });
    expect(statuses()[0]).toBe("COMPLETED");
    const summary = await runLoop(ctx());
    expect(summary.stoppedBecause).toBe("done");
    expect(statuses()).toEqual(["COMPLETED", "COMPLETED", "COMPLETED"]);
    expect(readFileSync(join(dir, "PROJECT_SPEC.md"), "utf8")).toContain("## feature: Multiply");
  });
});
