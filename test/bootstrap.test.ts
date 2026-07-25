import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rescueMisplacedFile, type BootstrapContext } from "../src/bootstrap.js";
import { loadConfig } from "../src/config.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bootstrap-test-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (): BootstrapContext => ({
  cwd: dir,
  config: loadConfig(dir),
  tempDir: join(dir, ".harness", "tmp"),
});

// The brief is attached from .harness/, so models write the document they were
// asked for right next to it. Regenerating from scratch threw away a complete,
// correct AGENTS.md three times in a row.
describe("recovering a document written to the wrong directory", () => {
  it("moves it to the repository root", () => {
    writeFileSync(join(dir, ".harness", "AGENTS.md"), "# AGENTS.md\n\nreal content\n");

    expect(rescueMisplacedFile(ctx(), "AGENTS.md")).toBe(true);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("real content");
    expect(existsSync(join(dir, ".harness", "AGENTS.md"))).toBe(false);
  });

  it("leaves a file that is already in the right place alone", () => {
    writeFileSync(join(dir, "AGENTS.md"), "correct\n");
    writeFileSync(join(dir, ".harness", "AGENTS.md"), "stray\n");

    expect(rescueMisplacedFile(ctx(), "AGENTS.md")).toBe(false);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("correct\n");
  });

  it("ignores an empty stray file", () => {
    writeFileSync(join(dir, ".harness", "PROJECT_SPEC.md"), "   \n");

    expect(rescueMisplacedFile(ctx(), "PROJECT_SPEC.md")).toBe(false);
    expect(existsSync(join(dir, "PROJECT_SPEC.md"))).toBe(false);
  });

  it("reports nothing when the model wrote no file at all", () => {
    expect(rescueMisplacedFile(ctx(), "AGENTS.md")).toBe(false);
  });
});
