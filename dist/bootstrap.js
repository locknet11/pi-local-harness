/**
 * The phase the original aider orchestrator was missing.
 *
 * "Coding from scratch" does not fail because of the feature loop; it fails
 * because nobody defines WHAT to build and nothing prepares the ground. Hand a
 * local model "build me a notes app" and an empty repo and it invents a
 * different structure every attempt and never converges.
 *
 * Three separately verifiable steps:
 *   1. interview — extract from the human what only the human knows
 *   2. docs      — one call per file, with the spec validated and the parse
 *                  errors fed back until it is well-formed
 *   3. scaffold  — skeleton plus a test runner plus one passing test; without
 *                  this the first feature has nothing to verify against
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import * as git from "./git.js";
import { runPi } from "./pi.js";
import { agentsPrompt, failedVerificationSection, missingFileNudge, scaffoldPrompt, specPrompt, specRetryPrompt, } from "./prompts.js";
import { stopFlag } from "./proc.js";
import { validateSpec } from "./spec.js";
import { color, formatDuration, log } from "./ui.js";
import { excerpt, resolveTestCommand, runVerification, declaredTestCommand } from "./verify.js";
function defaultTestFramework(stack) {
    const s = stack.toLowerCase();
    if (/python|fastapi|django|flask/.test(s))
        return "pytest";
    if (/typescript|node|javascript|react/.test(s))
        return "vitest";
    if (/\bgo\b/.test(s))
        return "go test";
    if (/rust/.test(s))
        return "cargo test";
    return "the idiomatic one for the stack";
}
export async function interview(defaultName, featureTarget) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = async (question, fallback = "") => {
        const suffix = fallback ? ` ${color.dim(`[${fallback}]`)}` : "";
        const answer = (await rl.question(`${color.cyan(question)}${suffix}: `)).trim();
        return answer || fallback;
    };
    const askList = async (question) => {
        process.stdout.write(`${color.cyan(question)} ${color.dim("(one per line, empty line to finish)")}\n`);
        const items = [];
        for (;;) {
            const line = (await rl.question("  - ")).trim();
            if (!line)
                break;
            items.push(line);
        }
        return items;
    };
    try {
        process.stdout.write(`\n${color.cyan("┌─ Define the project")}\n`);
        process.stdout.write(`${color.dim("│ This is the part the model cannot invent. Be concrete.")}\n`);
        process.stdout.write(`${color.dim("└─────────────────────────────────────")}\n\n`);
        const name = await ask("Project name", defaultName);
        let description = await ask("What does it do? (one or two sentences)");
        while (!description) {
            process.stdout.write(`${color.yellow("  There is no project without this.")}\n`);
            description = await ask("What does it do?");
        }
        const stack = await ask("Stack / language (e.g. python+fastapi, typescript+node, go)", "python");
        const testing = await ask("Test framework", defaultTestFramework(stack));
        const targetRaw = await ask("How many features in the backlog?", String(featureTarget));
        process.stdout.write("\n");
        const mustHave = await askList("Features it MUST have");
        process.stdout.write("\n");
        const outOfScope = await askList("Explicitly out of scope");
        process.stdout.write("\n");
        const constraints = await ask("Technical constraints (forbidden deps, versions)", "none");
        const parsedTarget = Number(targetRaw);
        return {
            name,
            description,
            stack,
            testing,
            mustHave,
            outOfScope,
            constraints,
            featureTarget: Number.isFinite(parsedTarget) && parsedTarget > 0 ? parsedTarget : featureTarget,
        };
    }
    finally {
        rl.close();
    }
}
export function briefFromIdea(idea, featureTarget) {
    return {
        name: "",
        description: idea,
        stack: "choose the most idiomatic one for what is described",
        testing: "the standard framework for that stack",
        mustHave: [],
        outOfScope: [],
        constraints: "prefer the standard library; few dependencies",
        featureTarget,
    };
}
export function renderBrief(brief) {
    const list = (items, fallback) => items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : `- ${fallback}`;
    return `# Brief${brief.name ? `: ${brief.name}` : ""}

## What it is
${brief.description}

## Stack
- Language/framework: ${brief.stack}
- Tests: ${brief.testing}
- Constraints: ${brief.constraints}

## Must have
${list(brief.mustHave, "(not specified; infer from the purpose)")}

## Out of scope
${list(brief.outOfScope, "(nothing declared)")}

## Backlog size
Aim for about ${brief.featureTarget} features.
`;
}
export function writeBrief(ctx, brief) {
    const path = join(ctx.cwd, ctx.config.briefFile);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderBrief(brief));
    return path;
}
// --- 2. AGENTS.md and PROJECT_SPEC.md ---------------------------------------
async function callPi(ctx, tag, prompt, attachments) {
    const result = await runPi(prompt, {
        piBin: ctx.config.piBin,
        provider: ctx.config.provider,
        model: ctx.config.model,
        thinking: ctx.config.thinking,
        cwd: ctx.cwd,
        timeoutSeconds: ctx.config.bootstrapTimeout,
        attachments,
        saveSession: ctx.config.saveSessions,
        sessionName: `harness-${tag}`,
        rawPath: join(ctx.tempDir, `pi.${tag}.jsonl`),
        watch: ctx.config.watch,
    });
    log.detail(`tools: ${result.writeCalls} writes, ${result.toolErrors} errors · ~${result.totalTokens} tokens · exit ${result.code}`);
    // pi exits 0 even when every request failed, so the error in the event stream
    // is the only thing that explains an empty run.
    if (result.backendError)
        log.error(`backend refused the request — ${result.backendError}`);
    for (const hint of result.hints)
        log.warn(`backend: ${hint}`);
    return result;
}
/**
 * Recover a document the model wrote to the wrong directory.
 *
 * The brief is attached from the state dir, so a model asked for "AGENTS.md"
 * reasonably writes it next to the brief — a complete, correct document that
 * the harness then declares missing and regenerates from scratch. The prompt
 * names the exact path now; this catches the times that is not enough.
 */
export function rescueMisplacedFile(ctx, relativePath) {
    const target = join(ctx.cwd, relativePath);
    if (existsSync(target))
        return false;
    const stateDir = join(ctx.cwd, ctx.config.stateDir);
    if (!existsSync(stateDir))
        return false;
    const wanted = basename(relativePath);
    for (const entry of readdirSync(stateDir, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name !== wanted)
            continue;
        const stray = join(stateDir, entry.name);
        if (readFileSync(stray, "utf8").trim() === "")
            continue;
        mkdirSync(dirname(target), { recursive: true });
        renameSync(stray, target);
        log.warn(`${wanted} was written to ${ctx.config.stateDir}/ — moved it to ${relativePath}.`);
        return true;
    }
    return false;
}
/**
 * Every attempt uses the same model against the same backend, so a refused
 * request refuses identically three times. Stop and say what to change —
 * which is a different thing depending on what the backend refused.
 */
function backendUnusable(ctx, backendError) {
    log.error(`The backend refused every attempt with ${ctx.config.model} — stopping.`);
    if (/context/i.test(backendError)) {
        log.detail(`The prompt did not fit. Serve a bigger window: pi-harness tune-ctx --context ${ctx.config.contextLength * 2}`);
        log.detail("A backend serving several requests at once splits its context between them, so a window that worked alone can overflow.");
    }
    else {
        log.detail("Pick a model that is loaded and fits in memory: pi-harness models, then --model <id>.");
    }
    return false;
}
export async function generateAgentsFile(ctx) {
    const agentsPath = join(ctx.cwd, ctx.config.agentsFile);
    for (let attempt = 1; attempt <= ctx.config.bootstrapRetries; attempt += 1) {
        if (stopFlag.isStopped)
            return false;
        log.step(`Writing ${ctx.config.agentsFile} (attempt ${attempt}/${ctx.config.bootstrapRetries})`);
        let prompt = agentsPrompt(ctx.config.agentsFile, ctx.config.stateDir);
        if (attempt > 1)
            prompt += missingFileNudge(ctx.config.agentsFile);
        const result = await callPi(ctx, `agents-${attempt}`, prompt, [ctx.config.briefFile]);
        if (result.aborted)
            return false;
        if (result.backendError)
            return backendUnusable(ctx, result.backendError);
        if (result.timedOut) {
            log.warn("Timed out while writing the architecture doc.");
            continue;
        }
        rescueMisplacedFile(ctx, ctx.config.agentsFile);
        if (existsSync(agentsPath) && readFileSync(agentsPath, "utf8").trim() !== "") {
            const lines = readFileSync(agentsPath, "utf8").split("\n").length;
            log.ok(`${ctx.config.agentsFile} written (${lines} lines).`);
            return true;
        }
        log.warn(`${ctx.config.agentsFile} did not appear.`);
    }
    log.error(`Could not get the model to write ${ctx.config.agentsFile}.`);
    return false;
}
export async function generateSpecFile(ctx) {
    const specPath = join(ctx.cwd, ctx.config.specFile);
    let errors = [];
    for (let attempt = 1; attempt <= ctx.config.bootstrapRetries; attempt += 1) {
        if (stopFlag.isStopped)
            return false;
        log.step(`Writing ${ctx.config.specFile} (attempt ${attempt}/${ctx.config.bootstrapRetries})`);
        let prompt = specPrompt(ctx.config.specFile, ctx.config.featureTarget, ctx.config.stateDir);
        if (errors.length > 0)
            prompt += specRetryPrompt(ctx.config.specFile, errors);
        const result = await callPi(ctx, `spec-${attempt}`, prompt, [
            ctx.config.briefFile,
            ctx.config.agentsFile,
        ]);
        if (result.aborted)
            return false;
        if (result.backendError)
            return backendUnusable(ctx, result.backendError);
        rescueMisplacedFile(ctx, ctx.config.specFile);
        if (!existsSync(specPath)) {
            log.warn(`${ctx.config.specFile} did not appear.`);
            errors = [`You did not create ${ctx.config.specFile}. Create it with the write tool.`];
            continue;
        }
        errors = validateSpec(readFileSync(specPath, "utf8"));
        if (errors.length === 0) {
            const count = readFileSync(specPath, "utf8").match(/^#*\s*feature:/gim)?.length ?? 0;
            log.ok(`${ctx.config.specFile} is valid: ${count} features.`);
            return true;
        }
        log.warn("The spec does not validate. Feeding the errors back to the model:");
        for (const e of errors.slice(0, 12))
            log.detail(e);
    }
    log.error(`Could not get a valid ${ctx.config.specFile} in ${ctx.config.bootstrapRetries} attempts.`);
    log.detail("Edit it by hand and re-run, or try a larger model.");
    return false;
}
// --- 3. Scaffold ------------------------------------------------------------
export async function scaffold(ctx) {
    const verifyCtx = { cwd: ctx.cwd, testCmdFile: ctx.config.testCmdFile };
    let lastOutput = "";
    let lastCommand = "";
    for (let attempt = 1; attempt <= ctx.config.bootstrapRetries; attempt += 1) {
        if (stopFlag.isStopped)
            return false;
        log.step(`Building the scaffold (attempt ${attempt}/${ctx.config.bootstrapRetries})`);
        let prompt = scaffoldPrompt(ctx.config.agentsFile, ctx.config.testCmdFile);
        if (attempt > 1) {
            if (!declaredTestCommand(verifyCtx)) {
                prompt += `

## The most important part is missing
You did not write ${ctx.config.testCmdFile}. Write it now: one line, the test
command, nothing else.`;
            }
            if (lastOutput) {
                prompt += failedVerificationSection(lastCommand, excerpt(lastOutput, 40));
                prompt += `

If the command itself was wrong (for example it points at a pytest that is not
installed), fix ${ctx.config.testCmdFile}.`;
            }
        }
        const result = await callPi(ctx, `scaffold-${attempt}`, prompt, [ctx.config.agentsFile]);
        if (result.aborted)
            return false;
        if (result.writeCalls === 0) {
            log.warn("The model wrote no files. Retrying.");
            continue;
        }
        const resolved = resolveTestCommand(verifyCtx, { configured: ctx.config.testCommand });
        if (!resolved) {
            log.warn("No test command: neither declared nor detectable.");
            continue;
        }
        log.detail(resolved.source === "declared"
            ? `command declared by the agent in ${ctx.config.testCmdFile}`
            : `command source: ${resolved.source}`);
        log.info(`Verifying the scaffold: ${resolved.command}`);
        const verification = await runVerification(verifyCtx, resolved.command, ctx.config.testTimeout, join(ctx.tempDir, "scaffold-test.log"));
        lastOutput = verification.stdout + verification.stderr;
        lastCommand = resolved.command;
        log.excerpt(lastOutput, 12);
        if (verification.passed) {
            log.ok(`Scaffold is green with: ${resolved.command}`);
            const committed = await git.commitFeature({ cwd: ctx.cwd }, "F000", "project scaffold", "COMPLETED");
            if (committed)
                log.ok(`commit — ${committed}`);
            return true;
        }
        log.warn(verification.timedOut
            ? `The scaffold tests hung (${formatDuration(ctx.config.testTimeout)}).`
            : `The scaffold does not pass its tests (exit ${verification.code}).`);
    }
    log.error("Could not get the scaffold green.");
    return false;
}
//# sourceMappingURL=bootstrap.js.map