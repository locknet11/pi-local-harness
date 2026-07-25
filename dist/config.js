/**
 * Configuration: defaults < harness.config.json < environment < CLI flags.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDuration } from "./ui.js";
const DEFAULTS = {
    provider: "",
    model: "",
    contextLength: 32768,
    maxOutputTokens: 8192,
    reasoning: false,
    thinking: "off",
    piBin: "pi",
    specFile: "PROJECT_SPEC.md",
    agentsFile: "AGENTS.md",
    stateDir: ".harness",
    logFile: ".harness/harness.log",
    testCmdFile: ".harness/test_cmd",
    briefFile: ".harness/brief.md",
    maxRetries: 4,
    maxConsecutiveFailures: 3,
    featureTimeout: 1800,
    testTimeout: 600,
    bootstrapTimeout: 1500,
    cooldown: 10,
    featureTarget: 10,
    bootstrapRetries: 3,
    testExcerptLines: 60,
    testCommand: "",
    requireTestChanges: true,
    rollbackOnFail: true,
    gitBranch: "",
    unloadBetweenFeatures: false,
    saveSessions: false,
    keepTemp: false,
    watch: false,
};
export const CONFIG_FILENAME = "harness.config.json";
const bool = (v, fallback) => {
    if (v === undefined || v === "")
        return fallback;
    return !/^(0|false|no|off)$/i.test(v);
};
const num = (v, fallback) => {
    if (v === undefined || v === "")
        return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
};
export function loadConfig(projectDir, overrides = {}) {
    let fileConfig = {};
    const configPath = join(projectDir, CONFIG_FILENAME);
    if (existsSync(configPath)) {
        try {
            fileConfig = JSON.parse(readFileSync(configPath, "utf8"));
        }
        catch (err) {
            throw new Error(`${CONFIG_FILENAME} is not valid JSON: ${err.message}`);
        }
    }
    const env = process.env;
    const envConfig = {
        ...(env["HARNESS_PROVIDER"] ? { provider: env["HARNESS_PROVIDER"] } : {}),
        ...(env["HARNESS_MODEL"] ? { model: env["HARNESS_MODEL"] } : {}),
        ...(env["HARNESS_CONTEXT"] ? { contextLength: num(env["HARNESS_CONTEXT"], DEFAULTS.contextLength) } : {}),
        ...(env["HARNESS_THINKING"] ? { thinking: env["HARNESS_THINKING"] } : {}),
        ...(env["PI_BIN"] ? { piBin: env["PI_BIN"] } : {}),
        ...(env["SPEC_FILE"] ? { specFile: env["SPEC_FILE"] } : {}),
        ...(env["AGENTS_FILE"] ? { agentsFile: env["AGENTS_FILE"] } : {}),
        ...(env["TEST_COMMAND"] ? { testCommand: env["TEST_COMMAND"] } : {}),
        ...(env["MAX_RETRIES"] ? { maxRetries: num(env["MAX_RETRIES"], DEFAULTS.maxRetries) } : {}),
        ...(env["MAX_CONSECUTIVE_FAILURES"]
            ? { maxConsecutiveFailures: num(env["MAX_CONSECUTIVE_FAILURES"], DEFAULTS.maxConsecutiveFailures) }
            : {}),
        ...(env["FEATURE_TIMEOUT"] ? { featureTimeout: parseDuration(env["FEATURE_TIMEOUT"]) } : {}),
        ...(env["TEST_TIMEOUT"] ? { testTimeout: parseDuration(env["TEST_TIMEOUT"]) } : {}),
        ...(env["BOOTSTRAP_TIMEOUT"] ? { bootstrapTimeout: parseDuration(env["BOOTSTRAP_TIMEOUT"]) } : {}),
        ...(env["COOLDOWN"] ? { cooldown: num(env["COOLDOWN"], DEFAULTS.cooldown) } : {}),
        ...(env["FEATURE_TARGET"] ? { featureTarget: num(env["FEATURE_TARGET"], DEFAULTS.featureTarget) } : {}),
        ...(env["REQUIRE_TEST_CHANGES"] !== undefined
            ? { requireTestChanges: bool(env["REQUIRE_TEST_CHANGES"], DEFAULTS.requireTestChanges) }
            : {}),
        ...(env["ROLLBACK_ON_FAIL"] !== undefined
            ? { rollbackOnFail: bool(env["ROLLBACK_ON_FAIL"], DEFAULTS.rollbackOnFail) }
            : {}),
        ...(env["GIT_BRANCH"] ? { gitBranch: env["GIT_BRANCH"] } : {}),
        ...(env["KEEP_TEMP"] !== undefined ? { keepTemp: bool(env["KEEP_TEMP"], DEFAULTS.keepTemp) } : {}),
        ...(env["SAVE_SESSIONS"] !== undefined
            ? { saveSessions: bool(env["SAVE_SESSIONS"], DEFAULTS.saveSessions) }
            : {}),
        ...(env["HARNESS_WATCH"] !== undefined ? { watch: bool(env["HARNESS_WATCH"], DEFAULTS.watch) } : {}),
    };
    const merged = { ...DEFAULTS, ...fileConfig, ...envConfig, ...overrides };
    // Keep derived paths consistent when stateDir is customised.
    if (merged.stateDir !== DEFAULTS.stateDir) {
        if (!fileConfig.logFile && !overrides.logFile)
            merged.logFile = `${merged.stateDir}/harness.log`;
        if (!fileConfig.testCmdFile && !overrides.testCmdFile)
            merged.testCmdFile = `${merged.stateDir}/test_cmd`;
        if (!fileConfig.briefFile && !overrides.briefFile)
            merged.briefFile = `${merged.stateDir}/brief.md`;
    }
    return merged;
}
export function exampleConfig() {
    const sample = {
        provider: "lmstudio",
        model: "google/gemma-4-26b-a4b-qat",
        contextLength: 32768,
        maxRetries: 4,
        featureTarget: 10,
        featureTimeout: 1800,
        requireTestChanges: true,
        rollbackOnFail: true,
        testCommand: "",
    };
    return JSON.stringify(sample, null, 2) + "\n";
}
//# sourceMappingURL=config.js.map