#!/usr/bin/env node
/**
 * pi-harness — build whole projects from scratch with pi + a local LLM.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  briefFromIdea,
  generateAgentsFile,
  generateSpecFile,
  interview,
  scaffold,
  writeBrief,
  type BootstrapContext,
} from "./bootstrap.js";
import { CONFIG_FILENAME, exampleConfig, loadConfig, type HarnessConfig } from "./config.js";
import { diagnose, piModelsJsonPath, renderReport } from "./doctor.js";
import * as git from "./git.js";
import { isAlive, Lock, readPidFile, writePidFile } from "./lock.js";
import { runLoop } from "./loop.js";
import { piSeesModel, probeToolCalling, registerModel } from "./pi.js";
import { installSignalHandlers, killAllChildren, stopFlag } from "./proc.js";
import {
  createProvider,
  detectProvider,
  formatBytes,
  type Provider,
} from "./providers/index.js";
import {
  readSpec,
  resetFrom,
  resetStale,
  statusMark,
  summarize,
  validateSpec,
} from "./spec.js";
import { color, configureLogging, log } from "./ui.js";

const USAGE = `pi-harness — build whole projects from scratch with pi + a local LLM

Usage:
  pi-harness <command> [options]

Commands:
  init                 Interview, write AGENTS.md + PROJECT_SPEC.md, build the scaffold
  run                  Implement the backlog, feature by feature
  build                init followed by run
  scaffold             Rebuild only the project skeleton
  doctor               Diagnose environment, backend, pi wiring and tests
  models               List models available on the backend
  setup-model          Register the selected model with pi
  tune-ctx             Make the model serve a large enough context
  probe                Check that the model really executes tools
  spec                 Show backlog status
  reset [STATUS]       Return features to PENDING (default: FAILED)
  status | stop        Inspect or stop a background run
  init-config          Write a ${CONFIG_FILENAME} template

Options:
  --provider <name>    ollama | lmstudio (auto-detected when omitted)
  --model <id>         Model id as the backend names it
  --context <n>        Required context window (default 32768)
  --idea "<text>"      Skip the interview with a one-line description
  --brief <file>       Skip the interview using a brief file
  --features <n>       Backlog size for init
  --once               Run a single feature
  --feature <id>       Run one specific feature by id
  --spec <file>        Spec file (default PROJECT_SPEC.md)
  --dir <path>         Project directory (default: cwd)
  --yes, -y            Do not ask for confirmation
  --probe              With doctor: really test tool calling (costs one inference)
  --json               Machine-readable output where supported
  --help, -h           This message
`;

interface CliOptions {
  provider?: string;
  model?: string;
  context?: number;
  idea?: string;
  brief?: string;
  features?: number;
  once: boolean;
  feature?: string;
  spec?: string;
  dir: string;
  yes: boolean;
  probe: boolean;
  json: boolean;
}

function parseCli(argv: string[]): { command: string; rest: string[]; options: CliOptions } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      context: { type: "string" },
      idea: { type: "string" },
      brief: { type: "string" },
      features: { type: "string" },
      once: { type: "boolean", default: false },
      feature: { type: "string" },
      spec: { type: "string" },
      dir: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      probe: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values["help"] === true || positionals.length === 0) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  return {
    command: positionals[0] ?? "run",
    rest: positionals.slice(1),
    options: {
      ...(typeof values["provider"] === "string" ? { provider: values["provider"] } : {}),
      ...(typeof values["model"] === "string" ? { model: values["model"] } : {}),
      ...(values["context"] !== undefined ? { context: num(values["context"]) } : {}),
      ...(typeof values["idea"] === "string" ? { idea: values["idea"] } : {}),
      ...(typeof values["brief"] === "string" ? { brief: values["brief"] } : {}),
      ...(values["features"] !== undefined ? { features: num(values["features"]) } : {}),
      once: values["once"] === true,
      ...(typeof values["feature"] === "string" ? { feature: values["feature"] } : {}),
      ...(typeof values["spec"] === "string" ? { spec: values["spec"] } : {}),
      dir: typeof values["dir"] === "string" ? values["dir"] : process.cwd(),
      yes: values["yes"] === true,
      probe: values["probe"] === true,
      json: values["json"] === true,
    },
  };
}

async function resolveProvider(options: CliOptions, config: HarnessConfig): Promise<Provider> {
  const name = options.provider ?? config.provider;
  if (name) return createProvider(name);
  const detected = await detectProvider();
  if (!detected) {
    throw new Error(
      "No local backend is running. Start LM Studio (`lms server start`) or Ollama (`ollama serve`), or pass --provider.",
    );
  }
  log.detail(`auto-detected backend: ${detected.displayName}`);
  return detected;
}

/** Pick a model when none was configured: the largest available is the best guess. */
async function resolveModel(provider: Provider, config: HarnessConfig): Promise<string> {
  if (config.model) return config.model;
  const models = await provider.listModels();
  if (models.length === 0) {
    throw new Error(`${provider.displayName} has no models. Download one first.`);
  }
  const best = [...models].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0];
  if (!best) throw new Error("No usable model found.");
  log.warn(`No model configured; using the largest available: ${best.id}`);
  return best.id;
}

function makeTempDir(cwd: string, config: HarnessConfig): string {
  const base = join(cwd, config.stateDir, "tmp");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "run-"));
}

async function main(): Promise<number> {
  const { command, rest, options } = parseCli(process.argv.slice(2));
  const cwd = options.dir;

  const overrides: Partial<HarnessConfig> = {
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.context !== undefined ? { contextLength: options.context } : {}),
    ...(options.features !== undefined ? { featureTarget: options.features } : {}),
    ...(options.spec ? { specFile: options.spec } : {}),
  };
  const config = loadConfig(cwd, overrides);

  // Lightweight commands: no lock, no logging setup.
  switch (command) {
    case "init-config": {
      const path = join(cwd, CONFIG_FILENAME);
      if (existsSync(path) && !options.yes) {
        process.stdout.write(`${CONFIG_FILENAME} already exists. Use --yes to overwrite.\n`);
        return 1;
      }
      writeFileSync(path, exampleConfig());
      process.stdout.write(`Wrote ${path}\n`);
      return 0;
    }
    case "status": {
      const pid = readPidFile(join(cwd, config.stateDir, "run", "harness.pid"));
      if (pid !== null && isAlive(pid)) {
        process.stdout.write(`${color.green("● running")} (pid ${pid}) · log: ${config.logFile}\n`);
        return 0;
      }
      process.stdout.write(`${color.dim("○ nothing running")}\n`);
      return 1;
    }
    case "stop": {
      const pidPath = join(cwd, config.stateDir, "run", "harness.pid");
      const pid = readPidFile(pidPath);
      if (pid === null || !isAlive(pid)) {
        process.stdout.write("○ nothing running\n");
        return 1;
      }
      process.stdout.write(`Sending SIGTERM to ${pid}…\n`);
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* gone */
        }
      }
      return 0;
    }
    case "spec": {
      const specPath = join(cwd, config.specFile);
      if (!existsSync(specPath)) {
        process.stderr.write(`${config.specFile} not found. Run 'pi-harness init'.\n`);
        return 1;
      }
      const features = readSpec(specPath);
      const totals = summarize(features);
      if (options.json) {
        process.stdout.write(JSON.stringify({ features, totals }, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(`\n${color.cyan(config.specFile)}\n\n`);
      for (const f of features) {
        process.stdout.write(
          `  ${statusMark(f.status)}  #${String(f.index).padEnd(3)} ${String(f.status).padEnd(11)} ${f.name}\n`,
        );
      }
      process.stdout.write(
        `\n  total=${totals.total}  completed=${totals.completed}  unverified=${totals.unverified}  failed=${totals.failed}  pending=${totals.pending}\n`,
      );
      const errors = validateSpec(readFileSync(specPath, "utf8"));
      if (errors.length > 0) {
        process.stdout.write(`\n${color.yellow("Format problems:")}\n`);
        for (const e of errors) process.stdout.write(`  ${e}\n`);
      }
      process.stdout.write("\n");
      return 0;
    }
    case "reset": {
      const specPath = join(cwd, config.specFile);
      if (!existsSync(specPath)) {
        process.stderr.write(`${config.specFile} not found.\n`);
        return 1;
      }
      const from = (rest[0] ?? "FAILED").toUpperCase();
      let count = 0;
      if (from === "ALL") {
        for (const s of ["FAILED", "UNVERIFIED", "IN_PROGRESS", "COMPLETED", "BLOCKED"]) {
          count += resetFrom(specPath, s);
        }
      } else {
        count = resetFrom(specPath, from);
      }
      process.stdout.write(`♻ ${count} feature(s) returned to PENDING.\n`);
      return 0;
    }
  }

  // --- Commands that need the full runtime ---
  configureLogging({ file: join(cwd, config.logFile), mirror: true });

  const provider = await resolveProvider(options, config);
  config.provider = provider.name;

  switch (command) {
    case "models": {
      const health = await provider.health();
      if (!health.running) {
        log.warn(`${provider.displayName} is not running. Trying to start it…`);
        if (!(await provider.start())) {
          log.error(`Could not start ${provider.displayName}.`);
          for (const a of provider.advice()) log.detail(a);
          return 1;
        }
      }
      const models = await provider.listModels();
      const loaded = await provider.listLoaded();
      if (options.json) {
        process.stdout.write(JSON.stringify({ models, loaded }, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(`\n${color.cyan(`${provider.displayName} — available models`)}\n\n`);
      for (const m of models) {
        const live = loaded.find((l) => l.id === m.id);
        const bits = [
          m.params ? `${m.params}` : "",
          m.quantization ?? "",
          formatBytes(m.sizeBytes),
        ].filter(Boolean);
        process.stdout.write(
          `  ${live ? color.green("●") : color.dim("○")} ${m.id.padEnd(38)} ${color.dim(bits.join("  "))}` +
            (live?.contextLength ? color.dim(`  ctx=${live.contextLength}`) : "") +
            "\n",
        );
      }
      process.stdout.write(`\n  ${color.dim("● = currently loaded")}\n\n`);
      return 0;
    }

    case "setup-model": {
      const modelId = rest[0] ?? (await resolveModel(provider, config));
      config.model = modelId;
      log.step(`Registering '${modelId}' with pi as ${provider.name}/${modelId}`);

      if (!(await provider.health()).running) {
        log.warn(`${provider.displayName} is not running; starting it…`);
        await provider.start();
      }
      const { backupPath } = registerModel(piModelsJsonPath(), {
        providerName: provider.name,
        baseUrl: provider.baseUrl,
        modelId,
        contextWindow: config.contextLength,
        maxTokens: config.maxOutputTokens,
        reasoning: config.reasoning,
        compat: provider.piCompat(),
      });
      if (backupPath) log.detail(`backup: ${backupPath}`);
      log.ok(`Written to ${piModelsJsonPath()}`);
      log.ok(
        (await piSeesModel(config.piBin, provider.name, modelId))
          ? `pi sees ${provider.name}/${modelId}`
          : `pi does not list the model yet — check: ${config.piBin} --list-models`,
      );
      return 0;
    }

    case "tune-ctx": {
      const modelId = rest[0] ?? (await resolveModel(provider, config));
      log.step(`Ensuring '${modelId}' serves at least ${config.contextLength} tokens`);
      const finalId = await provider.ensureContext(modelId, config.contextLength);
      const info = await provider.contextInfo(finalId);
      log.ok(
        `Model to use: ${finalId}${info.effective ? ` (context ${info.effective})` : ""}`,
      );
      if (finalId !== modelId) {
        log.detail(`Register it with: pi-harness setup-model ${finalId}`);
      }
      return 0;
    }

    case "probe": {
      const modelId = await resolveModel(provider, config);
      log.step(`Probing tool calling for ${provider.name}/${modelId} (one inference)`);
      const result = await probeToolCalling({
        piBin: config.piBin,
        provider: provider.name,
        model: modelId,
        thinking: config.thinking,
      });
      if (result.ok) {
        log.ok("The model emits structured tool calls and wrote the file.");
        return 0;
      }
      log.error("The model does NOT execute tools.");
      log.detail(
        "It most likely returns the tool-call JSON as text. Declaring 'tools' is not enough — that comes from the chat template, not the model.",
      );
      if (result.finalText) log.detail(`model said: ${result.finalText.slice(0, 300)}`);
      return 1;
    }

    case "doctor": {
      config.model = config.model || (await resolveModel(provider, config).catch(() => ""));
      const report = await diagnose(cwd, config, provider, { probe: options.probe });
      process.stdout.write(renderReport(report));
      for (const a of provider.advice()) process.stdout.write(`  ${color.dim("· " + a)}\n`);
      process.stdout.write("\n");
      return report.fail === 0 ? 0 : 1;
    }
  }

  // --- Long-running commands: lock, signals, temp dir ---
  if (!["init", "run", "build", "scaffold"].includes(command)) {
    process.stderr.write(`Unknown command '${command}'.\n\n${USAGE}`);
    return 2;
  }

  config.model = await resolveModel(provider, config);

  const lock = new Lock(join(cwd, config.stateDir, "run", "harness.lock"));
  if (!lock.acquire()) {
    log.error(`Another instance holds the lock (pid ${lock.ownerPid()}). Use 'pi-harness stop'.`);
    return 1;
  }
  const pidPath = join(cwd, config.stateDir, "run", "harness.pid");
  writePidFile(pidPath, process.pid);

  const tempDir = makeTempDir(cwd, config);
  let exitCode = 0;

  const cleanup = () => {
    killAllChildren("SIGTERM");
    if (!config.keepTemp) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    lock.release();
    try {
      rmSync(pidPath, { force: true });
    } catch {
      /* best effort */
    }
  };

  installSignalHandlers((count) => {
    if (count === 1) log.warn("Stop requested. Finishing the current step… (again = force kill)");
  });

  try {
    const ctx: BootstrapContext = { cwd, config, tempDir };

    if (command === "init" || command === "build") {
      const specPath = join(cwd, config.specFile);
      if (existsSync(specPath) && !options.yes) {
        log.error(`${config.specFile} already exists. Re-run with --yes to regenerate it.`);
        return 1;
      }

      await git.initRepo({ cwd }, () => {
        const gitignorePath = join(cwd, ".gitignore");
        if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, git.defaultGitignore);
      });
      await git.ensureBranch({ cwd }, config.gitBranch);

      if (options.brief) {
        const source = join(cwd, options.brief);
        const path = existsSync(source) ? source : options.brief;
        mkdirSync(join(cwd, config.stateDir), { recursive: true });
        writeFileSync(join(cwd, config.briefFile), readFileSync(path, "utf8"));
        log.ok(`Brief taken from ${options.brief}`);
      } else if (options.idea) {
        writeBrief(ctx, briefFromIdea(options.idea, config.featureTarget));
        log.ok(`Brief written to ${config.briefFile}`);
      } else {
        if (!process.stdin.isTTY) {
          log.error("No TTY for the interview. Use --idea \"...\" or --brief <file>.");
          return 1;
        }
        const brief = await interview(
          cwd.split("/").pop() ?? "project",
          config.featureTarget,
        );
        config.featureTarget = brief.featureTarget;
        writeBrief(ctx, brief);
        log.ok(`Brief written to ${config.briefFile}`);
      }

      if (!(await generateAgentsFile(ctx))) return 1;
      if (!(await generateSpecFile(ctx))) return 1;
      const docsCommit = await git.commitFeature(
        { cwd },
        "F000",
        `project documents (${config.agentsFile}, ${config.specFile})`,
        "COMPLETED",
      );
      if (docsCommit) log.ok(`commit — ${docsCommit}`);

      if (!(await scaffold(ctx))) {
        log.warn(`The scaffold is not green. Fix it by hand, then run 'pi-harness run'.`);
        return 1;
      }
      log.ok(`Project ready. Next: pi-harness run`);
      if (command === "init") return 0;
    }

    if (command === "scaffold") {
      return (await scaffold(ctx)) ? 0 : 1;
    }

    // --- run ---
    const specPath = join(cwd, config.specFile);
    if (!existsSync(specPath)) {
      log.error(`${config.specFile} not found. Run 'pi-harness init' first.`);
      return 1;
    }
    const errors = validateSpec(readFileSync(specPath, "utf8"));
    if (errors.length > 0) {
      for (const e of errors) log.error(e);
      return 1;
    }

    await git.ensureBranch({ cwd }, config.gitBranch);
    resetStale(specPath, (f) =>
      log.warn(`Feature #${f.index} was left IN_PROGRESS by an earlier run → PENDING`),
    );

    const features = readSpec(specPath);
    log.step(
      `Backlog: ${features.length} features · ${provider.name}/${config.model}`,
    );

    const summary = await runLoop(ctx, {
      once: options.once,
      ...(options.feature ? { onlyFeatureId: options.feature } : {}),
    });

    log.blank();
    const finalFeatures = readSpec(specPath);
    for (const f of finalFeatures) {
      log.plain(
        `  ${statusMark(f.status)}  #${String(f.index).padEnd(3)} ${String(f.status).padEnd(11)} ${f.name}`,
      );
    }
    const totals = summarize(finalFeatures);
    log.blank();
    log.plain(
      `  total=${totals.total}  completed=${totals.completed}  unverified=${totals.unverified}  failed=${totals.failed}  pending=${totals.pending}`,
    );
    log.blank();
    log.ok(`${summary.completed} feature(s) completed in this run.`);
    exitCode = summary.stoppedBecause === "environment" ? 1 : 0;
  } finally {
    cleanup();
  }
  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
    if (stopFlag.isStopped) process.exitCode = 130;
  })
  .catch((err: unknown) => {
    log.error((err as Error).message ?? String(err));
    process.exitCode = 1;
  });
