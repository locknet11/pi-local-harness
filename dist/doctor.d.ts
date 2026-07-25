import type { HarnessConfig } from "./config.js";
import { type Provider } from "./providers/index.js";
export type CheckLevel = "ok" | "warn" | "fail";
export interface Check {
    level: CheckLevel;
    message: string;
    hint?: string;
}
export interface DoctorReport {
    sections: Array<{
        title: string;
        checks: Check[];
    }>;
    ok: number;
    warn: number;
    fail: number;
}
export declare const piModelsJsonPath: () => string;
export declare function diagnose(cwd: string, config: HarnessConfig, provider: Provider, options?: {
    probe?: boolean;
}): Promise<DoctorReport>;
export declare function renderReport(report: DoctorReport): string;
