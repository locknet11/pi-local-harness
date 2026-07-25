/**
 * Pre-flight diagnosis.
 *
 * Every check here exists because it silently ruined a real run: a model served
 * with a tiny context, a model that cannot execute tools, a verification
 * command that does not exist, a corrupt models.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as git from "./git.js";
import { piSeesModel, probeToolCalling } from "./pi.js";
import { commandExecutable, run } from "./proc.js";
import { formatBytes } from "./providers/index.js";
import { validateSpec } from "./spec.js";
import { color } from "./ui.js";
import { declaredTestCommand, resolveTestCommand } from "./verify.js";
export const piModelsJsonPath = () => join(homedir(), ".pi", "agent", "models.json");
export async function diagnose(cwd, config, provider, options = {}) {
    const sections = [];
    // --- Environment ---
    const env = [];
    const piVersion = await run(config.piBin, ["--version"], { timeoutSeconds: 30 });
    if (piVersion.code === 0) {
        env.push({
            level: "ok",
            message: `pi ${piVersion.stdout.replace(/\[[0-9;]*[A-Za-z]/g, "").trim().split("\n").pop() ?? ""}`,
        });
    }
    else {
        env.push({
            level: "fail",
            message: "pi not found on PATH",
            hint: "npm i -g @earendil-works/pi-coding-agent",
        });
    }
    env.push(commandExecutable("git")
        ? { level: "ok", message: "git" }
        : { level: "fail", message: "git not found" });
    env.push({ level: "ok", message: `node ${process.version} on ${process.platform}/${process.arch}` });
    sections.push({ title: "Environment", checks: env });
    // --- Backend ---
    const backend = [];
    const health = await provider.health();
    if (health.running) {
        backend.push({
            level: "ok",
            message: `${provider.displayName} is up at ${provider.baseUrl} (${health.detail})`,
        });
        const models = await provider.listModels();
        const known = models.find((m) => m.id === config.model);
        if (known) {
            backend.push({
                level: "ok",
                message: `model available: ${config.model}${known.sizeBytes ? ` (${formatBytes(known.sizeBytes)}${known.params ? `, ${known.params}` : ""})` : ""}`,
            });
        }
        else if (config.model) {
            backend.push({
                level: "fail",
                message: `model '${config.model}' is not available on ${provider.displayName}`,
                hint: `available: ${models.slice(0, 6).map((m) => m.id).join(", ") || "(none)"}`,
            });
        }
        else {
            backend.push({ level: "warn", message: "no model selected (use --model)" });
        }
        if (config.model) {
            const ctxInfo = await provider.contextInfo(config.model);
            if (ctxInfo.effective !== undefined) {
                if (ctxInfo.effective >= config.contextLength) {
                    backend.push({
                        level: "ok",
                        message: `served context: ${ctxInfo.effective}${ctxInfo.source ? ` (${ctxInfo.source})` : ""}${ctxInfo.max ? `, model ceiling ${ctxInfo.max}` : ""}`,
                    });
                }
                else {
                    backend.push({
                        level: "fail",
                        message: `served context is only ${ctxInfo.effective}, below the required ${config.contextLength}`,
                        hint: `run: pi-harness tune-ctx --context ${config.contextLength}`,
                    });
                }
            }
            else {
                // The failure mode that produces no error at all: the prompt is
                // truncated from the top and the agent "forgets" its instructions.
                backend.push({
                    level: "warn",
                    message: `'${config.model}' does not pin a context size, so the backend default applies${ctxInfo.max ? ` (model ceiling ${ctxInfo.max})` : ""}`,
                    hint: `The prompt gets truncated silently. Run: pi-harness tune-ctx --context ${config.contextLength}`,
                });
            }
        }
    }
    else {
        backend.push({ level: "fail", message: `${provider.displayName}: ${health.detail}` });
    }
    sections.push({ title: `Backend — ${provider.displayName}`, checks: backend });
    // --- pi wiring ---
    const wiring = [];
    const modelsJson = piModelsJsonPath();
    if (existsSync(modelsJson)) {
        try {
            JSON.parse(readFileSync(modelsJson, "utf8"));
            wiring.push({ level: "ok", message: `models.json: ${modelsJson}` });
        }
        catch {
            wiring.push({
                level: "fail",
                message: "models.json is not valid JSON — pi will ignore every custom provider",
                hint: modelsJson,
            });
        }
    }
    else {
        wiring.push({
            level: "warn",
            message: "no models.json yet",
            hint: "run: pi-harness setup-model",
        });
    }
    if (config.model) {
        const seen = await piSeesModel(config.piBin, provider.name, config.model);
        wiring.push(seen
            ? { level: "ok", message: `pi sees ${provider.name}/${config.model}` }
            : {
                level: "fail",
                message: `pi does NOT see ${provider.name}/${config.model}`,
                hint: "run: pi-harness setup-model",
            });
    }
    if (options.probe && config.model) {
        const probe = await probeToolCalling({
            piBin: config.piBin,
            provider: provider.name,
            model: config.model,
            thinking: config.thinking,
        });
        wiring.push(probe.ok
            ? { level: "ok", message: "the model emits structured tool calls and wrote the file" }
            : {
                level: "fail",
                message: "the model does NOT execute tools",
                hint: "It most likely returns the tool-call JSON as plain text. Declaring 'tools' is not enough. Pick another model.",
            });
    }
    sections.push({ title: "pi wiring", checks: wiring });
    // --- Project ---
    const project = [];
    const gitCtx = { cwd };
    if (await git.isRepo(gitCtx)) {
        project.push({ level: "ok", message: `git repository at ${await git.head(gitCtx)}` });
    }
    else {
        project.push({ level: "warn", message: "not a git repository yet ('init' creates it)" });
    }
    project.push(existsSync(join(cwd, config.agentsFile))
        ? { level: "ok", message: config.agentsFile }
        : { level: "warn", message: `${config.agentsFile} missing ('init' creates it)` });
    const specPath = join(cwd, config.specFile);
    if (existsSync(specPath)) {
        const errors = validateSpec(readFileSync(specPath, "utf8"));
        if (errors.length === 0) {
            const count = readFileSync(specPath, "utf8").match(/^#*\s*feature:/gim)?.length ?? 0;
            project.push({ level: "ok", message: `${config.specFile} is valid (${count} features)` });
        }
        else {
            project.push({
                level: "fail",
                message: `${config.specFile} has format errors`,
                hint: errors.slice(0, 5).join("; "),
            });
        }
    }
    else {
        project.push({ level: "warn", message: `${config.specFile} missing ('init' creates it)` });
    }
    const verifyCtx = { cwd, testCmdFile: config.testCmdFile };
    const resolved = resolveTestCommand(verifyCtx, { configured: config.testCommand });
    if (resolved) {
        const label = resolved.source === "declared" ? config.testCmdFile : resolved.source;
        project.push(commandExecutable(resolved.command)
            ? { level: "ok", message: `verification (${label}): ${resolved.command}` }
            : {
                level: "fail",
                message: `verification command is not executable: ${resolved.command}`,
                hint: "Fix PATH or set testCommand. Every feature would fail with exit 127.",
            });
        void declaredTestCommand;
    }
    else {
        project.push({
            level: "warn",
            message: "no test command: features would all be marked UNVERIFIED",
        });
    }
    sections.push({ title: "Project", checks: project });
    let ok = 0;
    let warn = 0;
    let fail = 0;
    for (const s of sections) {
        for (const c of s.checks) {
            if (c.level === "ok")
                ok += 1;
            else if (c.level === "warn")
                warn += 1;
            else
                fail += 1;
        }
    }
    return { sections, ok, warn, fail };
}
export function renderReport(report) {
    const lines = [];
    const icon = (l) => l === "ok" ? color.green("✔") : l === "warn" ? color.yellow("!") : color.red("✖");
    for (const section of report.sections) {
        lines.push("");
        lines.push(color.cyan(`── ${section.title} ${"─".repeat(Math.max(0, 42 - section.title.length))}`));
        for (const check of section.checks) {
            lines.push(`  ${icon(check.level)} ${check.message}`);
            if (check.hint)
                lines.push(`      ${color.dim(check.hint)}`);
        }
    }
    lines.push("");
    lines.push(color.dim(`${report.ok} ok, ${report.warn} warnings, ${report.fail} problems`));
    lines.push("");
    return lines.join("\n");
}
//# sourceMappingURL=doctor.js.map