export interface HarnessConfig {
    provider: string;
    model: string;
    /** Context the model must be served with before the harness will trust it. */
    contextLength: number;
    maxOutputTokens: number;
    reasoning: boolean;
    thinking: string;
    piBin: string;
    specFile: string;
    agentsFile: string;
    stateDir: string;
    logFile: string;
    testCmdFile: string;
    briefFile: string;
    maxRetries: number;
    maxConsecutiveFailures: number;
    featureTimeout: number;
    testTimeout: number;
    bootstrapTimeout: number;
    cooldown: number;
    featureTarget: number;
    bootstrapRetries: number;
    testExcerptLines: number;
    testCommand: string;
    requireTestChanges: boolean;
    rollbackOnFail: boolean;
    gitBranch: string;
    unloadBetweenFeatures: boolean;
    saveSessions: boolean;
    keepTemp: boolean;
    /** Stream the model's reasoning and replies to the terminal while it works. */
    watch: boolean;
}
export declare const CONFIG_FILENAME = "harness.config.json";
export declare function loadConfig(projectDir: string, overrides?: Partial<HarnessConfig>): HarnessConfig;
export declare function exampleConfig(): string;
