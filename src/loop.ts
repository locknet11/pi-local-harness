/**
 * The feature loop: implement, verify, commit — or roll back.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "./config.js";
import * as git from "./git.js";
import { runPi } from "./pi.js";
import {
  NO_TESTS_NUDGE,
  NO_WRITES_NUDGE,
  failedVerificationSection,
  featurePrompt,
} from "./prompts.js";
import { sleep, stopFlag } from "./proc.js";
import { readSpec, setStatus, type Feature, type FeatureStatus } from "./spec.js";
import type { Provider } from "./providers/types.js";
import { formatDuration, log } from "./ui.js";
import { excerpt, resolveTestCommand, runVerification, type VerifyContext } from "./verify.js";

export type FeatureOutcome =
  /** verified and committed */
  | "completed"
  /** accepted without a verification command */
  | "unverified"
  /** retries exhausted */
  | "failed"
  /** the environment is broken; stop everything */
  | "environment"
  /** interrupted by the user */
  | "aborted";

export interface LoopContext {
  cwd: string;
  config: HarnessConfig;
  tempDir: string;
  /**
   * Optional backend handle, used only to free memory between features. The
   * loop never needs it otherwise, so tests can leave it out.
   */
  provider?: Pick<Provider, "unload"> | undefined;
}

export async function processFeature(
  ctx: LoopContext,
  feature: Feature,
  checkpoint: string,
): Promise<FeatureOutcome> {
  const { config } = ctx;
  const gitCtx = { cwd: ctx.cwd };
  const verifyCtx: VerifyContext = { cwd: ctx.cwd, testCmdFile: config.testCmdFile };

  // A rollback runs `git clean -fd`, which removes untracked directories. If
  // the temp dir is not gitignored it can vanish between features, so recreate
  // it rather than crashing mid-run.
  mkdirSync(ctx.tempDir, { recursive: true });
  const featureFile = join(ctx.tempDir, "current-feature.md");
  writeFileSync(featureFile, feature.raw);

  const resolved = resolveTestCommand(verifyCtx, {
    configured: config.testCommand,
    featureTest: feature.test,
  });
  const testCommand = resolved?.command ?? "";

  setStatus(join(ctx.cwd, config.specFile), feature.index, "IN_PROGRESS");

  let lastNoWrites = false;
  let lastNoTests = false;
  let lastOutput = "";

  for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
    if (stopFlag.isStopped) return "aborted";
    log.info(`attempt ${attempt}/${config.maxRetries}`);

    let prompt = featurePrompt({ specFile: config.specFile, testCommand });
    if (lastNoWrites) prompt += NO_WRITES_NUDGE;
    if (lastNoTests) prompt += NO_TESTS_NUDGE;
    if (attempt > 1 && lastOutput && !lastNoWrites && !lastNoTests) {
      prompt += failedVerificationSection(testCommand, excerpt(lastOutput, config.testExcerptLines));
    }

    const result = await runPi(prompt, {
      piBin: config.piBin,
      provider: config.provider,
      model: config.model,
      thinking: config.thinking,
      cwd: ctx.cwd,
      timeoutSeconds: config.featureTimeout,
      attachments: [featureFile],
      saveSession: config.saveSessions,
      sessionName: `harness-f${feature.index}-r${attempt}`,
      rawPath: join(ctx.tempDir, `pi.f${feature.index}-r${attempt}.jsonl`),
    });

    log.detail(
      `tools: ${result.writeCalls} writes, ${result.toolErrors} errors · ~${result.totalTokens} tokens · exit ${result.code}`,
    );
    for (const hint of result.hints) log.warn(`backend: ${hint}`);

    if (result.aborted || stopFlag.isStopped) return "aborted";

    if (result.timedOut) {
      log.warn(`timed out: pi exceeded ${formatDuration(config.featureTimeout)}`);
      lastNoWrites = false;
      lastNoTests = false;
      continue;
    }
    if (result.code !== 0) {
      log.warn(`pi exited with code ${result.code}`);
      continue;
    }

    // Silent failure #1: the model described the code instead of writing it.
    if (result.writeCalls === 0) {
      log.warn("the model touched no files (it described instead of writing)");
      lastNoWrites = true;
      lastNoTests = false;
      continue;
    }
    lastNoWrites = false;

    const stat = await git.diffStat(gitCtx, checkpoint);
    if (stat) log.detail(`diff: ${stat}`);

    // Silent failure #2: code without tests. A green suite that did not grow
    // proves nothing about this feature.
    if (config.requireTestChanges && testCommand) {
      const touched = await git.testFilesChangedSince(gitCtx, checkpoint);
      if (touched === 0) {
        log.warn("no test file was touched: verification would prove nothing new");
        lastNoTests = true;
        continue;
      }
    }
    lastNoTests = false;

    if (!testCommand) {
      log.warn("no verification command: accepting without validation");
      return "unverified";
    }

    log.info(`verifying: ${testCommand}`);
    const verification = await runVerification(
      verifyCtx,
      testCommand,
      config.testTimeout,
      join(ctx.tempDir, `test.f${feature.index}.log`),
    );
    lastOutput = verification.stdout + verification.stderr;

    if (stopFlag.isStopped) return "aborted";

    if (verification.environmentBroken) {
      log.error(`the verification command does not exist: '${testCommand}'`);
      log.detail("That is the environment, not the code. Stopping here.");
      return "environment";
    }
    if (verification.passed) {
      log.ok("tests are green");
      return "completed";
    }
    if (verification.timedOut) {
      log.warn(`the tests hung (${formatDuration(config.testTimeout)})`);
    } else {
      log.warn(`tests are red (exit ${verification.code})`);
      log.excerpt(lastOutput, 12);
    }
  }
  return "failed";
}

export interface LoopOptions {
  once?: boolean;
  onlyFeatureId?: string;
}

export interface LoopSummary {
  completed: number;
  failed: number;
  stoppedBecause: "done" | "blocked" | "environment" | "aborted" | "circuit-breaker";
}

export async function runLoop(
  ctx: LoopContext,
  optionsInput: LoopOptions = {},
): Promise<LoopSummary> {
  let options = optionsInput;
  const { config } = ctx;
  const specPath = join(ctx.cwd, config.specFile);
  const gitCtx = { cwd: ctx.cwd };

  let completed = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let pendingOnlyId = options.onlyFeatureId;

  for (;;) {
    if (stopFlag.isStopped) return { completed, failed, stoppedBecause: "aborted" };

    const features = readSpec(specPath);
    let feature: Feature | undefined;

    if (pendingOnlyId) {
      feature = features.find((f) => f.id === pendingOnlyId);
      if (!feature) throw new Error(`No feature with id '${pendingOnlyId}' in ${config.specFile}`);
      pendingOnlyId = undefined;
      // Targeting one feature implies stopping after it; otherwise the loop
      // would carry on through the rest of the backlog, which is never what
      // "--feature F002" means.
      options = { ...options, once: true };
    } else {
      const { nextPending, hasBlockedPending } = await import("./spec.js");
      feature = nextPending(features);
      if (!feature) {
        if (hasBlockedPending(features)) {
          log.warn("PENDING features remain but their dependencies are unmet.");
          log.detail("Check `pi-harness spec`; fix the 'depends:' fields or reset the failed ones.");
          return { completed, failed, stoppedBecause: "blocked" };
        }
        log.ok("Backlog finished.");
        return { completed, failed, stoppedBecause: "done" };
      }
    }

    log.blank();
    log.step(`#${feature.index} ${feature.name}`);

    // Taken before the feature starts, so a failure can be undone cleanly.
    const checkpoint = await git.checkpoint(gitCtx, feature.name);
    const outcome = await processFeature(ctx, feature, checkpoint);

    switch (outcome) {
      case "completed":
      case "unverified": {
        const status: FeatureStatus = outcome === "completed" ? "COMPLETED" : "UNVERIFIED";
        setStatus(specPath, feature.index, status);
        const message = await git.commitFeature(gitCtx, feature.id, feature.name, status);
        if (message) log.ok(`commit ${await git.head(gitCtx)} — ${message}`);
        completed += 1;
        consecutiveFailures = 0;
        break;
      }
      case "failed": {
        log.error(`circuit breaker: '${feature.name}' failed after ${config.maxRetries} attempts`);
        if (config.rollbackOnFail && checkpoint) {
          // Undo the half-written mess first: without this the next feature
          // starts on broken imports and inherits the failure. The reset also
          // reverts the spec, so the status is written again afterwards.
          await git.rollbackTo(gitCtx, checkpoint);
          log.warn(`rolled the working tree back to ${checkpoint.slice(0, 9)}`);
          setStatus(specPath, feature.index, "FAILED");
        } else {
          setStatus(specPath, feature.index, "FAILED");
          await git.commitFeature(gitCtx, feature.id, feature.name, "FAILED");
        }
        failed += 1;
        consecutiveFailures += 1;
        break;
      }
      case "environment":
        setStatus(specPath, feature.index, "PENDING");
        log.error("Broken environment. Returning the feature to PENDING and stopping.");
        return { completed, failed, stoppedBecause: "environment" };
      case "aborted":
        setStatus(specPath, feature.index, "PENDING");
        log.warn("Interrupted. Returning the feature to PENDING.");
        return { completed, failed, stoppedBecause: "aborted" };
    }

    if (consecutiveFailures >= config.maxConsecutiveFailures) {
      log.error(`${consecutiveFailures} features failed in a row. Global stop.`);
      log.detail("Something is broken at the root: model, context or tests. Check the log.");
      return { completed, failed, stoppedBecause: "circuit-breaker" };
    }
    if (options.once) {
      log.info("--once: stopping after one feature.");
      return { completed, failed, stoppedBecause: "done" };
    }

    // Only worth doing when memory is tight: reloading costs real time, so it
    // stays off by default.
    if (config.unloadBetweenFeatures && ctx.provider) {
      if (await ctx.provider.unload(config.model)) log.detail("model unloaded to free memory");
    }
    await sleep(config.cooldown);
  }
}

/** Ensure the spec file exists and is parseable before starting a run. */
export function requireSpec(cwd: string, specFile: string): string {
  const path = join(cwd, specFile);
  if (!existsSync(path)) {
    throw new Error(`${specFile} not found. Run 'pi-harness init' first.`);
  }
  return readFileSync(path, "utf8");
}
