import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandExecutable, run } from "../src/proc.js";
import { parseDuration, formatDuration } from "../src/ui.js";
import { excerpt } from "../src/verify.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proc-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("durations", () => {
  it("parses the suffixes the config accepts", () => {
    expect(parseDuration("25m")).toBe(1500);
    expect(parseDuration("90s")).toBe(90);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("45")).toBe(45);
    expect(parseDuration(120)).toBe(120);
  });
  it("formats them back for logs", () => {
    expect(formatDuration(1500)).toBe("25m00s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(7200)).toBe("2h00m");
  });
});

describe("process supervision", () => {
  it("returns the exit code of a normal command", async () => {
    const r = await run("bash", ["-c", "exit 3"]);
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it("captures stdout and stderr", async () => {
    const r = await run("bash", ["-c", "echo out; echo err >&2"]);
    expect(r.stdout).toContain("out");
    expect(r.stderr).toContain("err");
  });

  it("kills a process that exceeds the timeout and reports 124", async () => {
    const r = await run("sleep", ["30"], { timeoutSeconds: 1 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(124);
  });

  it("returns immediately for fast commands, without waiting for the timeout", async () => {
    const start = Date.now();
    const r = await run("true", [], { timeoutSeconds: 30 });
    expect(r.code).toBe(0);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it("kills the whole process tree, not just the direct child", async () => {
    // The child spawns a grandchild; without a process-group kill the
    // grandchild survives and keeps holding resources (this is what pi's bash
    // tool does in practice).
    const marker = join(dir, "grandchild.pid");
    await run("bash", ["-c", `bash -c 'echo $$ > ${marker}; sleep 30' & sleep 30`], {
      timeoutSeconds: 1,
    });
    await new Promise((r) => setTimeout(r, 500));
    const { readFileSync } = await import("node:fs");
    const pid = Number(readFileSync(marker, "utf8").trim());
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) process.kill(pid, "SIGKILL");
    expect(alive).toBe(false);
  });

  it("reports a missing binary as 127 rather than crashing", async () => {
    const r = await run("definitely_not_a_real_binary_xyz", []);
    expect(r.code).toBe(127);
  });

  it("runs through a login shell when asked", async () => {
    const r = await run("echo $((2+2))", [], { shell: true });
    expect(r.stdout.trim()).toBe("4");
  });

  it("writes output to the requested file", async () => {
    const out = join(dir, "out.log");
    await run("bash", ["-c", "echo hello-file"], { outFile: out });
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(out, "utf8")).toContain("hello-file");
  });
});

describe("commandExecutable", () => {
  it("accepts a plain command on PATH", () => {
    expect(commandExecutable("ls -la")).toBe(true);
  });

  it("rejects a command that does not exist", () => {
    expect(commandExecutable("no_such_command_xyz_123")).toBe(false);
  });

  it("skips leading VAR=value assignments", () => {
    // The scaffold phase really does generate `PYTHONPATH=. .venv/bin/pytest -q`;
    // naive parsing reads PYTHONPATH=. as the binary and aborts the whole run.
    expect(commandExecutable("FOO=1 BAR=2 ls")).toBe(true);
  });

  it("skips a leading env", () => {
    expect(commandExecutable("env FOO=1 ls")).toBe(true);
  });

  it("checks relative paths on disk rather than on PATH", () => {
    const bin = join(dir, "runner.sh");
    writeFileSync(bin, "#!/bin/sh\ntrue\n");
    chmodSync(bin, 0o755);
    expect(commandExecutable(`PYTHONPATH=. ${bin} -q`)).toBe(true);
    expect(commandExecutable(`PYTHONPATH=. ${join(dir, "missing")} -q`)).toBe(false);
  });
});

describe("excerpt", () => {
  it("passes short output through untouched", () => {
    expect(excerpt("a\nb\nc", 60)).toBe("a\nb\nc");
  });

  it("keeps both ends of long output", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line${i}`).join("\n");
    const out = excerpt(text, 60);
    expect(out).toContain("line0");
    expect(out).toContain("line299");
    expect(out).toContain("lines omitted");
    expect(out.split("\n").length).toBeLessThan(70);
  });
});
