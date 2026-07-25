/** Provider registry and auto-detection. */
import { LMStudioProvider } from "./lmstudio.js";
import { OllamaProvider } from "./ollama.js";
import { findPiProvider, PiRegisteredProvider, readPiProviders } from "./piconfig.js";
export * from "./types.js";
export { OllamaProvider } from "./ollama.js";
export { LMStudioProvider, findLmsBinary } from "./lmstudio.js";
export { findPiProvider, piModelsJsonPath, PiRegisteredProvider, readPiProviders, } from "./piconfig.js";
export function createProvider(name) {
    switch (name) {
        case "ollama":
            return new OllamaProvider();
        case "lmstudio":
            return new LMStudioProvider();
        default: {
            // Anything else may still be a backend the user wired into pi itself.
            const fromPi = findPiProvider(name);
            if (fromPi)
                return new PiRegisteredProvider(fromPi);
            const known = readPiProviders().map((p) => p.name);
            throw new Error(`Unknown provider "${name}". Built in: ollama, lmstudio.` +
                (known.length > 0 ? ` Configured in pi: ${known.join(", ")}.` : ""));
        }
    }
}
export function allProviders() {
    return [new LMStudioProvider(), new OllamaProvider()];
}
/**
 * Pick a backend when the user did not name one: whichever is actually running
 * and has at least one model. Preferring a live server over a configured-but-
 * dead one avoids a confusing first run.
 */
export async function detectProvider() {
    const candidates = allProviders();
    for (const p of candidates) {
        const health = await p.health();
        if (!health.running)
            continue;
        const models = await p.listModels();
        if (models.length > 0)
            return p;
    }
    for (const p of candidates) {
        if ((await p.health()).running)
            return p;
    }
    return null;
}
//# sourceMappingURL=index.js.map