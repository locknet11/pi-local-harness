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
export { piModelsJsonPath } from "./providers/piconfig.js";
export { readPiProviders } from "./providers/piconfig.js";
export declare function diagnose(cwd: string, config: HarnessConfig, provider: Provider, options?: {
    probe?: boolean;
}): Promise<DoctorReport>;
export declare function renderReport(report: DoctorReport): string;
