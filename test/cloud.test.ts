import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CloudProvider,
  credentialStatus,
  readCloudProviders,
} from "../src/providers/cloud.js";
import { createProvider } from "../src/providers/index.js";

let dir: string;
let storePath: string;
let authPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cloud-test-"));
  storePath = join(dir, "models-store.json");
  authPath = join(dir, "auth.json");
});
afterEach(() => {
  delete process.env["PI_MODELS_STORE"];
  delete process.env["PI_AUTH_JSON"];
  rmSync(dir, { recursive: true, force: true });
});

const writeStore = (o: unknown) => writeFileSync(storePath, JSON.stringify(o));
const writeAuth = (o: unknown) => writeFileSync(authPath, JSON.stringify(o));

const STORE = {
  "opencode-go": {
    models: [
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1000000, maxTokens: 384000, reasoning: true },
      { id: "kimi-k2.6", contextWindow: 262144 },
    ],
  },
  openrouter: { models: [{ id: "anthropic/claude-sonnet-4.5", contextWindow: 200000 }] },
};

describe("reading pi's built-in catalog cache", () => {
  it("lists every cached provider and model", () => {
    writeStore(STORE);
    const providers = readCloudProviders(storePath);
    expect(providers.map((p) => p.name)).toEqual(["opencode-go", "openrouter"]);
    expect(providers[0]?.models.map((m) => m.id)).toEqual(["deepseek-v4-pro", "kimi-k2.6"]);
  });

  it("drops models without an id and tolerates a junk file", () => {
    writeStore({ "opencode-go": { models: [{ name: "no id" }, { id: "real" }] } });
    expect(readCloudProviders(storePath)[0]?.models.map((m) => m.id)).toEqual(["real"]);

    writeFileSync(storePath, "{ not json");
    expect(readCloudProviders(storePath)).toEqual([]);
    expect(readCloudProviders(join(dir, "absent.json"))).toEqual([]);
  });
});

describe("credential resolution", () => {
  it("finds a credential in auth.json", () => {
    writeAuth({ "opencode-go": { type: "api_key", key: "x" } });
    expect(credentialStatus("opencode-go", authPath)).toMatchObject({
      present: true,
      source: "auth.json",
    });
  });

  it("falls back to the provider's environment variable", () => {
    process.env["OPENROUTER_API_KEY"] = "sk-or-...";
    try {
      expect(credentialStatus("openrouter", join(dir, "absent.json"))).toMatchObject({
        present: true,
        source: "env",
      });
    } finally {
      delete process.env["OPENROUTER_API_KEY"];
    }
  });

  it("reports missing credentials with the env var that would fix it", () => {
    const status = credentialStatus("opencode-go", join(dir, "absent.json"));
    expect(status.present).toBe(false);
    expect(status.envVar).toBe("OPENCODE_API_KEY");
  });
});

describe("driving a cloud provider", () => {
  const provider = () =>
    new CloudProvider({
      name: "opencode-go",
      models: [{ id: "deepseek-v4-pro", contextWindow: 1000000, maxTokens: 384000 }],
    });

  it("reports the catalogued context window", async () => {
    expect(await provider().contextInfo("deepseek-v4-pro")).toEqual({
      effective: 1000000,
      source: "pi's catalog cache (models-store.json)",
    });
    // Unknown model -> no claim rather than a confident wrong number.
    expect(await provider().contextInfo("nope")).toEqual({});
  });

  it("refuses a context the model cannot serve", async () => {
    await expect(provider().ensureContext("deepseek-v4-pro", 2000000)).rejects.toThrow(
      /below the required/,
    );
    await expect(provider().ensureContext("deepseek-v4-pro", 100000)).resolves.toBe("deepseek-v4-pro");
  });

  it("is healthy only when a credential exists", async () => {
    writeAuth({ "opencode-go": { type: "api_key", key: "x" } });
    process.env["PI_AUTH_JSON"] = authPath;
    expect((await provider().health()).running).toBe(true);

    process.env["PI_AUTH_JSON"] = join(dir, "absent.json");
    const bad = await provider().health();
    expect(bad.running).toBe(false);
    expect(bad.detail).toMatch(/no credential/);
  });

  it("manages nothing: no loading, no unloading", async () => {
    expect(await provider().listLoaded()).toEqual([]);
    expect(await provider().unload()).toBe(false);
    expect(provider().piCompat()).toBeUndefined();
  });
});

describe("createProvider falls back to cloud", () => {
  it("resolves a cached cloud provider by name", () => {
    writeStore(STORE);
    process.env["PI_MODELS_STORE"] = storePath;
    const p = createProvider("openrouter");
    expect(p).toBeInstanceOf(CloudProvider);
    expect(p.name).toBe("openrouter");
  });

  it("still rejects a genuinely unknown provider", () => {
    writeStore(STORE);
    process.env["PI_MODELS_STORE"] = storePath;
    expect(() => createProvider("not-a-provider")).toThrow(/Unknown provider/);
  });
});
