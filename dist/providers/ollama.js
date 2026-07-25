/**
 * Ollama backend.
 *
 * The one thing that ruins runs silently: Ollama serves models with a small
 * default context (4096) unless the Modelfile pins `num_ctx` or the server was
 * started with OLLAMA_CONTEXT_LENGTH. pi's system prompt alone is larger than
 * that, so the agent starts already truncated — with no error anywhere.
 *
 * Worse, `/api/show` does NOT return num_ctx as a JSON field. It buries it in
 * the `parameters` string:
 *
 *   "parameters": "top_k    64\ntop_p    0.95\nnum_ctx    131072\n..."
 *
 * so looking for a `num_ctx` key finds nothing and a correctly configured model
 * gets reported as unconfigured.
 */
import { run } from "../proc.js";
import { fetchJson, } from "./types.js";
export class OllamaProvider {
    name = "ollama";
    displayName = "Ollama";
    host;
    constructor(host = process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434") {
        this.host = host.replace(/\/$/, "");
    }
    get baseUrl() {
        return `${this.host}/v1`;
    }
    async health() {
        const tags = await fetchJson(`${this.host}/api/tags`, { timeoutMs: 3000 });
        if (!tags)
            return { running: false, detail: `no response at ${this.host}` };
        const version = await fetchJson(`${this.host}/api/version`, {
            timeoutMs: 2000,
        });
        return {
            running: true,
            detail: `${tags.models?.length ?? 0} model(s) available`,
            ...(version?.version ? { version: version.version } : {}),
        };
    }
    async start() {
        if ((await this.health()).running)
            return true;
        // `ollama serve` only reads OLLAMA_MODELS / OLLAMA_CONTEXT_LENGTH at
        // startup, so pass them through from the harness environment.
        await run("ollama", ["serve"], { timeoutSeconds: 3 }).catch(() => null);
        for (let i = 0; i < 15; i += 1) {
            await new Promise((r) => setTimeout(r, 1000));
            if ((await this.health()).running)
                return true;
        }
        return false;
    }
    async listModels() {
        const tags = await fetchJson(`${this.host}/api/tags`);
        return (tags?.models ?? []).map((m) => ({
            id: m.name ?? "",
            ...(m.size !== undefined ? { sizeBytes: m.size } : {}),
            ...(m.details?.parameter_size ? { params: m.details.parameter_size } : {}),
            ...(m.details?.family ? { architecture: m.details.family } : {}),
            ...(m.details?.quantization_level ? { quantization: m.details.quantization_level } : {}),
        }));
    }
    async listLoaded() {
        const ps = await fetchJson(`${this.host}/api/ps`);
        return (ps?.models ?? []).map((m) => ({
            id: m.name ?? "",
            ...(m.context_length !== undefined ? { contextLength: m.context_length } : {}),
            ...(m.size !== undefined ? { sizeBytes: m.size } : {}),
        }));
    }
    /** Ollama normalizes tags: a model created as "foo" is listed as "foo:latest". */
    async hasModel(modelId) {
        const want = modelId.includes(":") ? modelId : `${modelId}:latest`;
        const models = await this.listModels();
        return models.some((m) => (m.id.includes(":") ? m.id : `${m.id}:latest`) === want);
    }
    async show(modelId) {
        return fetchJson(`${this.host}/api/show`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: modelId }),
            timeoutMs: 8000,
        });
    }
    async contextInfo(modelId) {
        const info = await this.show(modelId);
        if (!info)
            return {};
        // num_ctx lives inside the `parameters` string dump, not as a JSON key.
        let effective;
        if (info.parameters) {
            const m = /^\s*num_ctx\s+(\d+)\s*$/m.exec(info.parameters);
            if (m)
                effective = Number(m[1]);
        }
        let max;
        for (const [key, value] of Object.entries(info.model_info ?? {})) {
            if (key.endsWith("context_length") && typeof value === "number") {
                max = value;
                break;
            }
        }
        const serverDefault = process.env["OLLAMA_CONTEXT_LENGTH"];
        if (effective === undefined && serverDefault) {
            return {
                effective: Number(serverDefault),
                ...(max !== undefined ? { max } : {}),
                source: "OLLAMA_CONTEXT_LENGTH",
            };
        }
        return {
            ...(effective !== undefined ? { effective } : {}),
            ...(max !== undefined ? { max } : {}),
            ...(effective !== undefined ? { source: "Modelfile num_ctx" } : {}),
        };
    }
    async capabilities(modelId) {
        const info = await this.show(modelId);
        return info?.capabilities ?? [];
    }
    /**
     * Ollama has no per-request context control over the OpenAI endpoint, so the
     * only reliable fix is a derived model with `PARAMETER num_ctx` baked in.
     */
    async ensureContext(modelId, contextLength) {
        const current = await this.contextInfo(modelId);
        if ((current.effective ?? 0) >= contextLength)
            return modelId;
        const base = modelId.split(":")[0] ?? modelId;
        const derived = `${base}-pi${contextLength}`;
        if (await this.hasModel(derived))
            return derived;
        const modelfile = `FROM ${modelId}\nPARAMETER num_ctx ${contextLength}\n`;
        const result = await run(`printf '%s' ${JSON.stringify(modelfile)} | ollama create ${JSON.stringify(derived)} -f -`, [], { shell: true, timeoutSeconds: 600 });
        if (result.code !== 0) {
            throw new Error(`ollama create failed for ${derived}: ${result.stderr.trim()}`);
        }
        return derived;
    }
    async unload(modelId) {
        // keep_alive:0 unloads immediately without restarting the daemon.
        const res = await fetchJson(`${this.host}/api/generate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: modelId, keep_alive: 0 }),
            timeoutMs: 15000,
        });
        if (res !== null)
            return true;
        const cli = await run("ollama", ["stop", modelId], { timeoutSeconds: 30 });
        return cli.code === 0;
    }
    piCompat() {
        // Ollama's OpenAI shim rejects the `developer` role and `reasoning_effort`
        // that pi sends for reasoning-capable models.
        return { supportsDeveloperRole: false, supportsReasoningEffort: false };
    }
    /** Not applicable: reasoning_effort is disabled by the compat flags above. */
    thinkingLevelMap() {
        return undefined;
    }
    advice() {
        return [
            "Store models off the system disk with OLLAMA_MODELS=/path/to/models.",
            "Raise the served context with OLLAMA_CONTEXT_LENGTH on the server, or `pi-harness tune-ctx`.",
            "Verify the real context with `ollama ps` — the CONTEXT column is the truth.",
        ];
    }
}
//# sourceMappingURL=ollama.js.map