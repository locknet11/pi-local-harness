import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiRegisteredProvider, readPiProviders } from "../src/providers/piconfig.js";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "piconfig-test-"));
  path = join(dir, "models.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (o: unknown) => writeFileSync(path, JSON.stringify(o));

describe("reading pi's global model registry", () => {
  it("lists every provider and model pi knows", () => {
    write({
      providers: {
        lmstudio: {
          baseUrl: "http://127.0.0.1:1234/v1",
          models: [{ id: "qwen/qwen3.5-9b", contextWindow: 32768, reasoning: true }],
        },
        workstation: {
          baseUrl: "http://10.0.0.5:11434/v1",
          models: [{ id: "llama4:70b", contextWindow: 65536 }],
        },
      },
      defaultModel: "lmstudio/qwen/qwen3.5-9b",
    });

    const providers = readPiProviders(path);
    expect(providers.map((p) => p.name)).toEqual(["lmstudio", "workstation"]);
    expect(providers[0]?.models[0]?.reasoning).toBe(true);
    expect(providers[1]?.baseUrl).toBe("http://10.0.0.5:11434/v1");
  });

  // Model ids contain slashes of their own, and some entries are stored with
  // the provider already baked into the id. Both readings occur in real files.
  it("resolves the default model under either naming convention", () => {
    write({
      providers: { lmstudio: { baseUrl: "u", models: [{ id: "qwen/qwen3.5-9b" }] } },
      defaultModel: "lmstudio/qwen/qwen3.5-9b",
    });
    expect(readPiProviders(path)[0]?.defaultModelId).toBe("qwen/qwen3.5-9b");

    write({
      providers: { lmstudio: { baseUrl: "u", models: [{ id: "lmstudio/qwen3.5-9b" }] } },
      defaultModel: "lmstudio/qwen3.5-9b",
    });
    expect(readPiProviders(path)[0]?.defaultModelId).toBe("lmstudio/qwen3.5-9b");
  });

  it("claims no default when pi's points at another provider", () => {
    write({
      providers: { lmstudio: { baseUrl: "u", models: [{ id: "a" }] } },
      defaultModel: "openai/gpt-4",
    });
    const p = readPiProviders(path)[0];
    expect(p?.isDefault).toBe(false);
    expect(p?.defaultModelId).toBeUndefined();
  });

  it("treats a corrupt or missing file as nothing configured", () => {
    expect(readPiProviders(join(dir, "absent.json"))).toEqual([]);
    writeFileSync(path, "{ not json");
    expect(readPiProviders(path)).toEqual([]);
  });
});

describe("driving a backend that pi owns", () => {
  const provider = () =>
    new PiRegisteredProvider({
      name: "workstation",
      baseUrl: "http://10.0.0.5:11434/v1",
      models: [{ id: "llama4:70b", contextWindow: 65536 }],
      isDefault: true,
      defaultModelId: "llama4:70b",
    });

  it("takes the context pi declares", async () => {
    expect(await provider().contextInfo("llama4:70b")).toEqual({
      effective: 65536,
      source: "declared in pi's models.json",
    });
    expect(await provider().ensureContext("llama4:70b", 32768)).toBe("llama4:70b");
  });

  // Silently accepting a too-small window is how prompts get truncated with no
  // error at all — the failure this whole provider is most exposed to.
  it("refuses to pretend it can raise a context it does not control", async () => {
    await expect(provider().ensureContext("llama4:70b", 131072)).rejects.toThrow(/below the required/);
  });

  it("reports no loaded models rather than guessing", async () => {
    expect(await provider().listLoaded()).toEqual([]);
    expect(await provider().unload()).toBe(false);
  });
});
