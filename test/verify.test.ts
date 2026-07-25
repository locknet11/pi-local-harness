import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_FILE_PATTERN } from "../src/git.js";
import {
  declaredTestCommand,
  detectTestCommand,
  resolveTestCommand,
  runVerification,
} from "../src/verify.js";

let dir: string;
let ctx: { cwd: string; testCmdFile: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verify-test-"));
  ctx = { cwd: dir, testCmdFile: ".harness/test_cmd" };
  mkdirSync(join(dir, ".harness"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("declared test command", () => {
  it("reads the command the agent wrote during scaffolding", () => {
    writeFileSync(join(dir, ".harness/test_cmd"), "PYTHONPATH=. .venv/bin/pytest -q\n");
    expect(declaredTestCommand(ctx)).toBe("PYTHONPATH=. .venv/bin/pytest -q");
  });
  it("skips comments and blank lines", () => {
    writeFileSync(join(dir, ".harness/test_cmd"), "\n# how to test\nnpm test\n");
    expect(declaredTestCommand(ctx)).toBe("npm test");
  });
  it("returns null when the agent never declared one", () => {
    expect(declaredTestCommand(ctx)).toBeNull();
  });
});

describe("auto-detection", () => {
  it("prefers a project virtualenv over the system interpreter", () => {
    mkdirSync(join(dir, ".venv/bin"), { recursive: true });
    writeFileSync(join(dir, ".venv/bin/pytest"), "");
    chmodSync(join(dir, ".venv/bin/pytest"), 0o755);
    expect(detectTestCommand(dir)).toBe(".venv/bin/pytest -q");
  });

  it("uses the right package manager for the lockfile present", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    expect(detectTestCommand(dir)).toBe("npm test --silent");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(detectTestCommand(dir)).toBe("pnpm test");
  });

  it("falls back to unittest when pytest is not installed", () => {
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "pyproject.toml"), "[project]\nname='x'\n");
    const cmd = detectTestCommand(dir);
    expect(cmd === "pytest -q" || cmd === "python3 -m unittest discover -s tests").toBe(true);
  });

  it("returns null for an empty directory", () => {
    expect(detectTestCommand(dir)).toBeNull();
  });

  it("survives a malformed package.json", () => {
    writeFileSync(join(dir, "package.json"), "{not json");
    expect(() => detectTestCommand(dir)).not.toThrow();
  });
});

describe("command precedence", () => {
  beforeEach(() => {
    writeFileSync(join(dir, ".harness/test_cmd"), "declared-command");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
  });

  it("puts an explicit override first", () => {
    expect(resolveTestCommand(ctx, { configured: "explicit" })).toMatchObject({
      command: "explicit",
      source: "config",
    });
  });

  it("puts the feature's own test field above the declared one", () => {
    expect(
      resolveTestCommand(ctx, { configured: "", featureTest: "feature-cmd" }),
    ).toMatchObject({ command: "feature-cmd", source: "feature" });
  });

  it("prefers what the agent declared over auto-detection", () => {
    // The real bug this prevents: the agent scaffolded with unittest, detection
    // guessed pytest, and every feature failed against a command nobody chose.
    expect(resolveTestCommand(ctx, { configured: "" })).toMatchObject({
      command: "declared-command",
      source: "declared",
    });
  });

  it("falls back to detection when nothing was declared", () => {
    rmSync(join(dir, ".harness/test_cmd"));
    expect(resolveTestCommand(ctx, { configured: "" })?.source).toBe("detected");
  });
});

describe("running verification", () => {
  it("reports a pass", async () => {
    const r = await runVerification(ctx, "true", 30);
    expect(r.passed).toBe(true);
    expect(r.environmentBroken).toBe(false);
  });

  it("reports a failure with output", async () => {
    const r = await runVerification(ctx, "echo boom; exit 1", 30);
    expect(r.passed).toBe(false);
    expect(r.stdout).toContain("boom");
  });

  it("flags a missing command as an environment fault, not a code fault", async () => {
    const r = await runVerification(ctx, "no_such_test_runner_xyz", 30);
    expect(r.environmentBroken).toBe(true);
  });

  it("times out a hanging suite", async () => {
    const r = await runVerification(ctx, "sleep 30", 1);
    expect(r.timedOut).toBe(true);
  });
});

describe("test-file detection", () => {
  it.each([
    "tests/test_stats.py",
    "test/foo_test.go",
    "src/__tests__/thing.test.ts",
    "spec/models_spec.rb",
    "src/Widget.test.tsx",
    "test_top_level.py",
    "src/CalculatorTests.java",
  ])("recognises %s as a test file", (path) => {
    expect(TEST_FILE_PATTERN.test(path)).toBe(true);
  });

  it.each(["src/stats.py", "README.md", "package.json", "src/latest.ts"])(
    "does not mistake %s for a test file",
    (path) => {
      expect(TEST_FILE_PATTERN.test(path)).toBe(false);
    },
  );
});
