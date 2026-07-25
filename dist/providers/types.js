/**
 * A local inference backend that pi can talk to.
 *
 * Both supported backends (Ollama, LM Studio) expose an OpenAI-compatible
 * endpoint, so from pi's side they are identical. Everything that differs —
 * how you list models, how you control the context window, how you free VRAM —
 * lives behind this interface.
 */
export function formatBytes(bytes) {
    if (bytes === undefined || !Number.isFinite(bytes))
        return "?";
    const gb = bytes / 1024 ** 3;
    if (gb >= 1)
        return `${gb.toFixed(1)} GB`;
    return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}
/** Small fetch helper with a timeout; local servers should answer fast. */
export async function fetchJson(url, init = {}) {
    const { timeoutMs = 5000, ...rest } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...rest, signal: controller.signal });
        if (!res.ok)
            return null;
        return (await res.json());
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=types.js.map