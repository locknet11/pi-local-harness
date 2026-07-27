/**
 * Cloud providers pi knows natively.
 *
 * These are not declared in pi's models.json and they are not local servers:
 * pi ships (and refreshes) their catalog into ~/.pi/agent/models-store.json,
 * and credentials live in ~/.pi/agent/auth.json (after `pi /login`) or in an
 * environment variable. The harness does not manage them — it cannot start a
 * server or load a model — but because the catalog is on disk it can still
 * report a model's real context window, which is the one number that decides
 * whether a prompt gets truncated.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ContextInfo,
  LoadedModel,
  LocalModel,
  Provider,
  ProviderHealth,
} from "./types.js";

export interface CloudModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string>;
}

export interface CloudProviderInfo {
  name: string;
  models: CloudModel[];
}

/** Where pi caches the built-in catalogs it refreshes from upstream. */
export function piModelsStorePath(): string {
  return process.env["PI_MODELS_STORE"] ?? join(homedir(), ".pi", "agent", "models-store.json");
}

export function piAuthJsonPath(): string {
  return process.env["PI_AUTH_JSON"] ?? join(homedir(), ".pi", "agent", "auth.json");
}

interface RawStoreModel {
  id?: unknown;
  name?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: unknown;
}

/**
 * Read pi's built-in provider catalog cache.
 *
 * The file is a map of provider name -> { models: [...] }. A missing or
 * malformed file is reported as "nothing cached" rather than thrown: doctor
 * is the place that surfaces the problem, and the harness can still drive a
 * provider whose catalog simply is not cached yet.
 */
export function readCloudProviders(path = piModelsStorePath()): CloudProviderInfo[] {
  if (!existsSync(path)) return [];
  let raw: Record<string, { models?: RawStoreModel[] }>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as typeof raw;
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object") return [];

  return Object.entries(raw).map(([name, entry]) => {
    const models: CloudModel[] = (entry?.models ?? [])
      .map((m) => ({
        id: typeof m.id === "string" ? m.id : "",
        ...(typeof m.name === "string" ? { name: m.name } : {}),
        ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
        ...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
        ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
        ...(m.thinkingLevelMap && typeof m.thinkingLevelMap === "object"
          ? { thinkingLevelMap: m.thinkingLevelMap as Record<string, string> }
          : {}),
      }))
      .filter((m) => m.id !== "");
    return { name, models };
  });
}

export function findCloudProvider(name: string, path = piModelsStorePath()): CloudProviderInfo | null {
  return readCloudProviders(path).find((p) => p.name === name) ?? null;
}

/** Environment variable pi accepts for a provider's API key, if any. */
const ENV_KEY: Record<string, string> = {
  "opencode-go": "OPENCODE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export interface CredentialStatus {
  present: boolean;
  source?: "auth.json" | "env";
  /** Env var that would satisfy this provider, for hints. */
  envVar?: string;
}

/**
 * Does pi have a usable credential for this provider?
 *
 * Mirrors pi's resolution order closely enough for a pre-flight check:
 * auth.json wins, then the provider's environment variable.
 */
export function credentialStatus(name: string, authPath = piAuthJsonPath()): CredentialStatus {
  const envVar = ENV_KEY[name];
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
      if (auth[name]) return { present: true, source: "auth.json", ...(envVar ? { envVar } : {}) };
    } catch {
      // fall through to the env check
    }
  }
  if (envVar && process.env[envVar]) {
    return { present: true, source: "env", envVar };
  }
  return { present: false, ...(envVar ? { envVar } : {}) };
}

/**
 * A cloud provider the harness drives but does not own.
 *
 * Management operations are deliberate no-ops: there is no local server to
 * start and no model to load — pi handles connection and auth. Context info,
 * though, comes from the real catalog cache, so doctor can warn about a
 * mismatch instead of guessing.
 */
export class CloudProvider implements Provider {
  readonly name: string;
  readonly displayName: string;
  /** Cloud endpoints are addressed by pi, not by the harness. */
  readonly baseUrl = "";
  private readonly info: CloudProviderInfo;

  constructor(info: CloudProviderInfo) {
    this.info = info;
    this.name = info.name;
    this.displayName = `${info.name} (cloud, via pi)`;
  }

  async health(): Promise<ProviderHealth> {
    const cred = credentialStatus(this.name);
    if (!cred.present) {
      const how = cred.envVar ? `run \`pi /login ${this.name}\` or set ${cred.envVar}` : `run \`pi /login ${this.name}\``;
      return { running: false, detail: `no credential — ${how}` };
    }
    return {
      running: true,
      detail: `${this.info.models.length} model(s) cached, credential in ${cred.source}`,
    };
  }

  /** Nothing to start — pi dials the cloud endpoint itself. */
  async start(): Promise<boolean> {
    return (await this.health()).running;
  }

  async listModels(): Promise<LocalModel[]> {
    return this.info.models.map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}) }));
  }

  /** Residency is meaningless for a hosted endpoint. */
  async listLoaded(): Promise<LoadedModel[]> {
    return [];
  }

  async contextInfo(modelId: string): Promise<ContextInfo> {
    const model = this.info.models.find((m) => m.id === modelId);
    if (!model || model.contextWindow === undefined) return {};
    return {
      effective: model.contextWindow,
      source: "pi's catalog cache (models-store.json)",
    };
  }

  async ensureContext(modelId: string, contextLength: number): Promise<string> {
    const info = await this.contextInfo(modelId);
    if (info.effective !== undefined && info.effective < contextLength) {
      throw new Error(
        `${modelId} is catalogued with a ${info.effective}-token context, below the required ${contextLength}. ` +
          `Lower contextLength in the harness config, or pick a larger model.`,
      );
    }
    return modelId;
  }

  async unload(): Promise<boolean> {
    return false;
  }

  piCompat(): Record<string, boolean> | undefined {
    return undefined;
  }

  thinkingLevelMap(): Record<string, string> | undefined {
    return this.info.models.find((m) => m.thinkingLevelMap)?.thinkingLevelMap;
  }

  advice(): string[] {
    const cred = credentialStatus(this.name);
    const lines = [
      "Hosted provider driven through pi — the harness does not manage a server, so health/loading checks are skipped.",
      `Context windows are read from ${piModelsStorePath()}; run \`pi\` online once to refresh the cache if a model looks wrong.`,
    ];
    if (!cred.present) {
      lines.unshift(
        cred.envVar
          ? `No credential found. Run \`pi /login ${this.name}\`, or export ${cred.envVar}.`
          : `No credential found. Run \`pi /login ${this.name}\`.`,
      );
    }
    return lines;
  }
}
