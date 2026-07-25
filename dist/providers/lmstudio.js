/**
 * LM Studio backend.
 *
 * Nicer than Ollama in one important way: context length is a load-time flag
 * (`lms load -c N`) rather than a property baked into the model, so raising it
 * needs no derived model and wastes no disk.
 *
 * The REST surface (`/v1/models`) only lists model ids, so anything richer —
 * sizes, what is loaded, context — comes from the `lms` CLI, which ships with
 * LM Studio and is usually at ~/.lmstudio/bin/lms rather than on PATH.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "../proc.js";
import { fetchJson, } from "./types.js";
export function findLmsBinary() {
    const candidates = [
        join(homedir(), ".lmstudio", "bin", "lms"),
        join(homedir(), ".cache", "lm-studio", "bin", "lms"),
        "/usr/local/bin/lms",
        "/opt/homebrew/bin/lms",
    ];
    for (const c of candidates)
        if (existsSync(c))
            return c;
    for (const dir of (process.env["PATH"] ?? "").split(":")) {
        if (dir && existsSync(join(dir, "lms")))
            return join(dir, "lms");
    }
    return null;
}
export class LMStudioProvider {
    name = "lmstudio";
    displayName = "LM Studio";
    host;
    lms;
    constructor(host = process.env["LMSTUDIO_HOST"] ?? "http://127.0.0.1:1234") {
        this.host = host.replace(/\/$/, "");
        this.lms = findLmsBinary();
    }
    get baseUrl() {
        return `${this.host}/v1`;
    }
    get cliAvailable() {
        return this.lms !== null;
    }
    async lmsRun(args, timeoutSeconds = 60) {
        if (!this.lms)
            return null;
        return run(this.lms, args, { timeoutSeconds });
    }
    async health() {
        const models = await fetchJson(`${this.baseUrl}/models`, { timeoutMs: 3000 });
        if (!models) {
            return {
                running: false,
                detail: this.lms
                    ? `server not running at ${this.host} (start it with: lms server start)`
                    : `no response at ${this.host}, and the lms CLI was not found`,
            };
        }
        return { running: true, detail: `${models.data?.length ?? 0} model(s) served` };
    }
    async start() {
        if ((await this.health()).running)
            return true;
        const res = await this.lmsRun(["server", "start"], 60);
        if (!res || res.code !== 0)
            return false;
        for (let i = 0; i < 10; i += 1) {
            await new Promise((r) => setTimeout(r, 1000));
            if ((await this.health()).running)
                return true;
        }
        return false;
    }
    async lmsJson(args) {
        const res = await this.lmsRun([...args, "--json"], 60);
        if (!res || res.code !== 0)
            return [];
        try {
            const parsed = JSON.parse(res.stdout.trim());
            return Array.isArray(parsed) ? parsed : [];
        }
        catch {
            return [];
        }
    }
    async listModels() {
        const entries = await this.lmsJson(["ls"]);
        if (entries.length > 0) {
            return entries
                .filter((e) => e.type !== "embedding")
                .map((e) => ({
                id: e.modelKey ?? e.path ?? "",
                ...(e.displayName ? { name: e.displayName } : {}),
                ...(e.sizeBytes !== undefined ? { sizeBytes: e.sizeBytes } : {}),
                ...(e.paramsString ? { params: e.paramsString } : {}),
                ...(e.architecture ? { architecture: e.architecture } : {}),
                ...(e.quantization?.name ? { quantization: e.quantization.name } : {}),
            }));
        }
        // No CLI: fall back to whatever the REST endpoint exposes.
        const models = await fetchJson(`${this.baseUrl}/models`);
        return (models?.data ?? [])
            .map((m) => ({ id: m.id ?? "" }))
            .filter((m) => m.id !== "" && !m.id.includes("embed"));
    }
    async listLoaded() {
        const entries = await this.lmsJson(["ps"]);
        return entries.map((e) => ({
            id: e.identifier ?? e.modelKey ?? "",
            ...(e.contextLength !== undefined ? { contextLength: e.contextLength } : {}),
            ...(e.sizeBytes !== undefined ? { sizeBytes: e.sizeBytes } : {}),
        }));
    }
    async contextInfo(modelId) {
        const loaded = (await this.listLoaded()).find((m) => m.id === modelId);
        if (loaded?.contextLength) {
            return { effective: loaded.contextLength, source: "loaded with -c" };
        }
        const entry = (await this.lmsJson(["ls"])).find((e) => e.modelKey === modelId);
        const max = entry?.maxContextLength;
        return max !== undefined ? { max } : {};
    }
    /**
     * Load (or reload) the model with an explicit context length. LM Studio keeps
     * the requested size for the life of the loaded instance, so this is all that
     * is needed — the model id never changes.
     */
    async ensureContext(modelId, contextLength) {
        const info = await this.contextInfo(modelId);
        if ((info.effective ?? 0) >= contextLength)
            return modelId;
        if (!this.lms) {
            throw new Error(`Cannot set context for ${modelId}: the lms CLI was not found. Load the model in the LM Studio UI with a context of at least ${contextLength}.`);
        }
        const target = info.max !== undefined ? Math.min(contextLength, info.max) : contextLength;
        // Unload first: loading the same model again keeps the original context.
        await this.unload(modelId);
        const res = await this.lmsRun(["load", modelId, "-c", String(target), "--gpu", "max", "-y"], 900);
        if (!res || res.code !== 0) {
            throw new Error(`lms load failed for ${modelId}: ${(res?.stderr ?? "").trim()}`);
        }
        return modelId;
    }
    async unload(modelId) {
        const res = await this.lmsRun(["unload", modelId], 60);
        return res?.code === 0;
    }
    /**
     * Does this model actually produce reasoning content?
     *
     * pi only applies the thinking-level machinery to models declared
     * reasoning-capable, so getting this wrong means `--thinking off` is ignored
     * and the model thinks on every single call. One tiny request settles it.
     */
    async supportsReasoning(modelId) {
        const res = await fetchJson(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: modelId,
                messages: [{ role: "user", content: "hi" }],
                max_tokens: 1,
            }),
            timeoutMs: 120_000,
        });
        const reasoning = res?.choices?.[0]?.message?.reasoning_content;
        return typeof reasoning === "string";
    }
    async unloadAll() {
        const res = await this.lmsRun(["unload", "--all"], 60);
        return res?.code === 0;
    }
    /**
     * LM Studio implements the OpenAI surface properly: it accepts the
     * `developer` role and `reasoning_effort` without complaint. Disabling them
     * (as Ollama needs) would be actively harmful here, because it stops pi from
     * sending `reasoning_effort` at all — which is the only way to turn thinking
     * off. Verified against LM Studio 0.3.x.
     */
    piCompat() {
        return undefined;
    }
    /**
     * pi's "off" must reach the backend as `reasoning_effort: "none"`.
     *
     * Measured with qwen3.5-9b: "minimal" and "low" still emit a full reasoning
     * dump before answering, while "none" returns the answer immediately. On a
     * laptop that is the difference between a feature taking minutes and taking
     * seconds.
     */
    thinkingLevelMap() {
        return {
            off: "none",
            minimal: "minimal",
            low: "low",
            medium: "medium",
            high: "high",
        };
    }
    advice() {
        return [
            "Model directory is set in the LM Studio UI (My Models → change folder) — point it at an external disk to keep them off the system drive.",
            "Context length is per load: `lms load <model> -c 32768`. `lms ps` shows what is actually loaded.",
            "Keep the local server running: `lms server start`.",
        ];
    }
}
//# sourceMappingURL=lmstudio.js.map