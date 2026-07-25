import type { HarnessConfig } from "./config.js";
export interface BootstrapContext {
    cwd: string;
    config: HarnessConfig;
    tempDir: string;
}
export interface Brief {
    name: string;
    description: string;
    stack: string;
    testing: string;
    mustHave: string[];
    outOfScope: string[];
    constraints: string;
    featureTarget: number;
}
export declare function interview(defaultName: string, featureTarget: number): Promise<Brief>;
export declare function briefFromIdea(idea: string, featureTarget: number): Brief;
export declare function renderBrief(brief: Brief): string;
export declare function writeBrief(ctx: BootstrapContext, brief: Brief): string;
/**
 * Recover a document the model wrote to the wrong directory.
 *
 * The brief is attached from the state dir, so a model asked for "AGENTS.md"
 * reasonably writes it next to the brief — a complete, correct document that
 * the harness then declares missing and regenerates from scratch. The prompt
 * names the exact path now; this catches the times that is not enough.
 */
export declare function rescueMisplacedFile(ctx: BootstrapContext, relativePath: string): boolean;
export declare function generateAgentsFile(ctx: BootstrapContext): Promise<boolean>;
export declare function generateSpecFile(ctx: BootstrapContext): Promise<boolean>;
export declare function scaffold(ctx: BootstrapContext): Promise<boolean>;
