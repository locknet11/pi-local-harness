/**
 * How the harness decides a feature is actually done.
 *
 * Without automated verification this is not a harness, it is an optimistic
 * text generator. Command precedence:
 *
 *   1. config.testCommand / TEST_COMMAND        (explicit override, always wins)
 *   2. the feature's own `test:` field          (per feature)
 *   3. .harness/test_cmd, written by the agent  (the source of truth)
 *   4. auto-detection from project layout       (last resort)
 *
 * Step 3 exists because of a real collision: the agent scaffolded the project
 * with `unittest` and documented it, but auto-detection saw tests/ plus
 * pyproject.toml, guessed `pytest`, and failed every feature against a command
 * nobody had chosen. Whoever built the scaffold knows how to run its tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commandExecutable, run, type RunResult } from "./proc.js";

export interface VerifyContext {
  cwd: string;
  testCmdFile: string;
}

/** The command the agent declared when it built the scaffold. */
export function declaredTestCommand(ctx: VerifyContext): string | null {
  const path = join(ctx.cwd, ctx.testCmdFile);
  if (!existsSync(path)) return null;
  const line = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#"));
  return line ?? null;
}

const has = (cwd: string, p: string) => existsSync(join(cwd, p));

export function detectTestCommand(cwd: string): string | null {
  // A project venv wins outright: the system interpreter has none of its packages.
  for (const venv of [".venv", "venv", "env"]) {
    if (has(cwd, `${venv}/bin/pytest`)) return `${venv}/bin/pytest -q`;
    if (has(cwd, `${venv}/bin/python`) && has(cwd, "tests")) {
      return `${venv}/bin/python -m pytest -q`;
    }
  }

  if (has(cwd, "package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.["test"]) {
        if (has(cwd, "pnpm-lock.yaml")) return "pnpm test";
        if (has(cwd, "yarn.lock")) return "yarn test";
        if (has(cwd, "bun.lockb")) return "bun test";
        return "npm test --silent";
      }
    } catch {
      /* malformed package.json: fall through to other detectors */
    }
  }

  if (has(cwd, "uv.lock")) return "uv run pytest -q";
  if (has(cwd, "poetry.lock")) return "poetry run pytest -q";
  if (has(cwd, "pyproject.toml") || has(cwd, "pytest.ini") || has(cwd, "setup.cfg") || has(cwd, "tests")) {
    if (commandExecutable("pytest")) return "pytest -q";
    if (has(cwd, "tests")) return "python3 -m unittest discover -s tests";
  }
  if (has(cwd, "go.mod")) return "go test ./...";
  if (has(cwd, "Cargo.toml")) return "cargo test";
  if (has(cwd, "pom.xml")) return "mvn -q -B test";
  if (has(cwd, "build.gradle") || has(cwd, "build.gradle.kts")) return "./gradlew test";
  if (has(cwd, "mix.exs")) return "mix test";
  if (has(cwd, "composer.json")) return "composer test";
  if (has(cwd, "Makefile")) {
    try {
      if (/^test:/m.test(readFileSync(join(cwd, "Makefile"), "utf8"))) return "make test";
    } catch {
      /* unreadable Makefile */
    }
  }
  return null;
}

export interface ResolveOptions {
  configured: string;
  featureTest?: string | undefined;
}

export interface ResolvedCommand {
  command: string;
  source: "config" | "feature" | "declared" | "detected";
}

export function resolveTestCommand(
  ctx: VerifyContext,
  opts: ResolveOptions,
): ResolvedCommand | null {
  if (opts.configured) return { command: opts.configured, source: "config" };
  if (opts.featureTest) return { command: opts.featureTest, source: "feature" };
  const declared = declaredTestCommand(ctx);
  if (declared) return { command: declared, source: "declared" };
  const detected = detectTestCommand(ctx.cwd);
  return detected ? { command: detected, source: "detected" } : null;
}

export interface VerificationResult extends RunResult {
  /** Exit 127 means the command does not exist: an environment fault, not a code fault. */
  environmentBroken: boolean;
  passed: boolean;
}

export async function runVerification(
  ctx: VerifyContext,
  command: string,
  timeoutSeconds: number,
  outFile?: string,
): Promise<VerificationResult> {
  const result = await run(command, [], {
    cwd: ctx.cwd,
    shell: true, // login shell so nvm/pyenv/asdf PATH setup applies
    timeoutSeconds,
    ...(outFile ? { outFile } : {}),
  });
  return {
    ...result,
    environmentBroken: result.code === 127,
    passed: result.code === 0,
  };
}

/**
 * Trim test output before handing it back to the model.
 *
 * Sending 3000 lines of stack trace to a local model is the fastest way to
 * blow its context window and make it lose the original task. The first error
 * is usually at the top and the summary at the bottom, so keep both ends.
 */
export function excerpt(output: string, maxLines = 60): string {
  const lines = output.split("\n");
  if (lines.length <= maxLines) return output.trim();
  const headCount = Math.floor(maxLines / 3);
  const tailCount = maxLines - headCount;
  const head = lines.slice(0, headCount).join("\n");
  const tail = lines.slice(-tailCount).join("\n");
  return `${head}\n\n... [${lines.length - maxLines} lines omitted] ...\n\n${tail}`.trim();
}
