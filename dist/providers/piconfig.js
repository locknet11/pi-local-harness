/**
 * Backends that pi already knows about.
 *
 * The two built-in providers manage a local server: they can start it, load a
 * model, set its context. Anything else the user has wired into pi's global
 * models.json — a second machine on the LAN, a different runtime, a hosted
 * endpoint — the harness cannot manage, but it can still drive, because pi is
 * the one making the calls. This provider is that: use what pi has, claim no
 * control over it.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchJson, } from "./types.js";
export function piModelsJsonPath() {
    return process.env["PI_MODELS_JSON"] ?? join(homedir(), ".pi", "agent", "models.json");
}
/**
 * Read pi's global model registry.
 *
 * A malformed file is reported as "nothing configured" rather than thrown:
 * the harness has its own backends, and a broken pi config should not stop
 * `doctor` — which is the command that will point out the file is broken.
 */
export function readPiProviders(path = piModelsJsonPath()) {
    if (!existsSync(path))
        return [];
    let raw;
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return [];
    }
    // pi's defaultModel is "<provider>/<model id>", and model ids contain
    // slashes themselves ("lmstudio/qwen/qwen3.5-9b"), so only the first
    // segment can be split off. Some entries are also stored with the provider
    // already baked into the id, so both readings are matched against the
    // models actually present rather than assumed.
    const def = raw.defaultModel ?? "";
    const slash = def.indexOf("/");
    const defProvider = slash > 0 ? def.slice(0, slash) : "";
    const defModel = slash > 0 ? def.slice(slash + 1) : "";
    return Object.entries(raw.providers ?? {}).map(([name, entry]) => {
        const models = (entry.models ?? [])
            .map((m) => ({
            id: typeof m["id"] === "string" ? m["id"] : "",
            ...(typeof m["contextWindow"] === "number" ? { contextWindow: m["contextWindow"] } : {}),
            ...(typeof m["maxTokens"] === "number" ? { maxTokens: m["maxTokens"] } : {}),
            ...(typeof m["reasoning"] === "boolean" ? { reasoning: m["reasoning"] } : {}),
            ...(m["thinkingLevelMap"] && typeof m["thinkingLevelMap"] === "object"
                ? { thinkingLevelMap: m["thinkingLevelMap"] }
                : {}),
        }))
            .filter((m) => m.id !== "");
        const isDefault = name === defProvider;
        const defaultModelId = isDefault
            ? models.find((m) => m.id === defModel || m.id === def)?.id
            : undefined;
        return {
            name,
            baseUrl: entry.baseUrl ?? "",
            ...(entry.api ? { api: entry.api } : {}),
            models,
            isDefault,
            ...(defaultModelId ? { defaultModelId } : {}),
        };
    });
}
export function findPiProvider(name, path = piModelsJsonPath()) {
    return readPiProviders(path).find((p) => p.name === name) ?? null;
}
/**
 * A backend the harness drives but does not own.
 *
 * Every management operation is a deliberate no-op: pretending to load a model
 * or set a context on a server we know nothing about would produce a confident
 * lie in `doctor`, which is the one place that must stay trustworthy.
 */
export class PiRegisteredProvider {
    name;
    displayName;
    baseUrl;
    config;
    constructor(config) {
        this.config = config;
        this.name = config.name;
        this.displayName = `${config.name} (from pi)`;
        this.baseUrl = config.baseUrl;
    }
    /** pi's default model for this provider, when it has one. */
    defaultModel() {
        return this.config.defaultModelId;
    }
    async health() {
        if (this.baseUrl === "") {
            return { running: false, detail: "no baseUrl in pi's models.json" };
        }
        const models = await fetchJson(`${this.baseUrl}/models`, {
            timeoutMs: 3000,
        });
        if (!models) {
            return { running: false, detail: `no response at ${this.baseUrl}` };
        }
        return { running: true, detail: `${models.data?.length ?? 0} model(s) served` };
    }
    /** Not ours to start — it may not even be on this machine. */
    async start() {
        return (await this.health()).running;
    }
    async listModels() {
        return this.config.models.map((m) => ({ id: m.id }));
    }
    /** Which models are resident is a property of the server, and it is not ours. */
    async listLoaded() {
        return [];
    }
    async contextInfo(modelId) {
        const model = this.config.models.find((m) => m.id === modelId);
        return model?.contextWindow !== undefined
            ? { effective: model.contextWindow, source: "declared in pi's models.json" }
            : {};
    }
    async ensureContext(modelId, contextLength) {
        const info = await this.contextInfo(modelId);
        if ((info.effective ?? 0) < contextLength) {
            throw new Error(`${modelId} is registered with pi for ${info.effective ?? "an unknown"} tokens, below the required ${contextLength}. ` +
                `Raise contextWindow in ${piModelsJsonPath()}, and make sure the server really serves that much.`);
        }
        return modelId;
    }
    async unload() {
        return false;
    }
    piCompat() {
        return undefined;
    }
    thinkingLevelMap() {
        return this.config.models.find((m) => m.thinkingLevelMap)?.thinkingLevelMap;
    }
    advice() {
        return [
            `Configured in ${piModelsJsonPath()}, not by the harness — it cannot start this server, load models or change their context.`,
            "Whatever contextWindow is declared there is taken at face value; if the server serves less, prompts are truncated silently.",
        ];
    }
}
//# sourceMappingURL=piconfig.js.map