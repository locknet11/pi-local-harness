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
export declare function generateAgentsFile(ctx: BootstrapContext): Promise<boolean>;
export declare function generateSpecFile(ctx: BootstrapContext): Promise<boolean>;
export declare function scaffold(ctx: BootstrapContext): Promise<boolean>;
