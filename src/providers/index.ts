/** Provider registry and auto-detection. */
import { CloudProvider, findCloudProvider, readCloudProviders } from "./cloud.js";
import { LMStudioProvider } from "./lmstudio.js";
import { OllamaProvider } from "./ollama.js";
import { findPiProvider, PiRegisteredProvider, readPiProviders } from "./piconfig.js";
import type { Provider } from "./types.js";

export * from "./types.js";
export { OllamaProvider } from "./ollama.js";
export { LMStudioProvider, findLmsBinary } from "./lmstudio.js";
export {
  CloudProvider,
  credentialStatus,
  findCloudProvider,
  piAuthJsonPath,
  piModelsStorePath,
  readCloudProviders,
  type CloudModel,
  type CloudProviderInfo,
  type CredentialStatus,
} from "./cloud.js";
export {
  findPiProvider,
  piModelsJsonPath,
  PiRegisteredProvider,
  readPiProviders,
  type PiConfigModel,
  type PiConfigProvider,
} from "./piconfig.js";

export type ProviderName = "ollama" | "lmstudio";

export function createProvider(name: string): Provider {
  switch (name) {
    case "ollama":
      return new OllamaProvider();
    case "lmstudio":
      return new LMStudioProvider();
    default: {
      // Anything else may still be a backend the user wired into pi itself.
      const fromPi = findPiProvider(name);
      if (fromPi) return new PiRegisteredProvider(fromPi);
      // Or a hosted provider pi knows natively (opencode-go, openrouter, …),
      // whose catalog lives in models-store.json rather than models.json.
      const cloud = findCloudProvider(name);
      if (cloud) return new CloudProvider(cloud);
      const known = [
        ...readPiProviders().map((p) => p.name),
        ...readCloudProviders().map((p) => p.name),
      ];
      throw new Error(
        `Unknown provider "${name}". Built in: ollama, lmstudio.` +
          (known.length > 0 ? ` Known to pi: ${[...new Set(known)].join(", ")}.` : ""),
      );
    }
  }
}

export function allProviders(): Provider[] {
  return [new LMStudioProvider(), new OllamaProvider()];
}

/**
 * Pick a backend when the user did not name one: whichever is actually running
 * and has at least one model. Preferring a live server over a configured-but-
 * dead one avoids a confusing first run.
 */
export async function detectProvider(): Promise<Provider | null> {
  const candidates = allProviders();
  for (const p of candidates) {
    const health = await p.health();
    if (!health.running) continue;
    const models = await p.listModels();
    if (models.length > 0) return p;
  }
  for (const p of candidates) {
    if ((await p.health()).running) return p;
  }
  return null;
}
