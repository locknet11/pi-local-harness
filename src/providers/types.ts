/**
 * A local inference backend that pi can talk to.
 *
 * Both supported backends (Ollama, LM Studio) expose an OpenAI-compatible
 * endpoint, so from pi's side they are identical. Everything that differs —
 * how you list models, how you control the context window, how you free VRAM —
 * lives behind this interface.
 */

export interface LocalModel {
  /** Identifier to send to the API and register with pi. */
  id: string;
  /** Human label, when the backend has one. */
  name?: string;
  sizeBytes?: number;
  /** Parameter count as reported by the backend, e.g. "26B". */
  params?: string;
  architecture?: string;
  quantization?: string;
}

export interface LoadedModel {
  id: string;
  /** Context window the model is actually being served with. */
  contextLength?: number;
  sizeBytes?: number;
}

export interface ContextInfo {
  /**
   * Context the model will actually be served with, when it can be known
   * before loading. Undefined means "backend default applies".
   */
  effective?: number;
  /** Architectural ceiling of the model, if reported. */
  max?: number;
  /** Where `effective` came from, for doctor output. */
  source?: string;
}

export interface ProviderHealth {
  running: boolean;
  detail: string;
  /** Version string when the backend reports one. */
  version?: string;
}

export interface Provider {
  /** Stable key used in config and as the pi provider name. */
  readonly name: string;
  readonly displayName: string;
  /** OpenAI-compatible base URL that pi will point at. */
  readonly baseUrl: string;

  /** Is the server reachable right now? */
  health(): Promise<ProviderHealth>;

  /** Try to start the server. Returns true if it is up afterwards. */
  start(): Promise<boolean>;

  /** Models available locally (downloaded), whether loaded or not. */
  listModels(): Promise<LocalModel[]>;

  /** Models currently resident in memory. */
  listLoaded(): Promise<LoadedModel[]>;

  /** What context window will this model actually get? */
  contextInfo(modelId: string): Promise<ContextInfo>;

  /**
   * Make `modelId` serve at least `contextLength` tokens.
   * Returns the model id to use afterwards — backends that need a derived
   * model (Ollama) return a new id; others return the same one.
   */
  ensureContext(modelId: string, contextLength: number): Promise<string>;

  /** Free memory held by the model, without killing the server. */
  unload(modelId: string): Promise<boolean>;

  /** Extra compatibility flags pi needs for this backend. */
  piCompat(): Record<string, boolean> | undefined;

  /**
   * Maps pi's thinking levels onto the values this backend understands.
   * Crucially this is how "off" becomes whatever actually disables reasoning.
   */
  thinkingLevelMap?(): Record<string, string> | undefined;

  /** Backend-specific advice surfaced by `doctor`. */
  advice(): string[];
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "?";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

/** Small fetch helper with a timeout; local servers should answer fast. */
export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T | null> {
  const { timeoutMs = 5000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
