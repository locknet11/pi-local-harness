export declare const FEATURE_STATUSES: readonly ["PENDING", "IN_PROGRESS", "COMPLETED", "UNVERIFIED", "FAILED", "BLOCKED"];
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];
export interface Feature {
    /** 1-based block index; the stable address of this feature. */
    index: number;
    name: string;
    id: string;
    status: FeatureStatus | string;
    depends: string[];
    test?: string;
    acceptance: string[];
    notes?: string;
    /** 0-based line of the `status:` line, for surgical rewrites. */
    statusLineNo: number;
    /** Full block text, handed to the model as the task description. */
    raw: string;
}
export declare function parseSpec(text: string): Feature[];
export declare function readSpec(file: string): Feature[];
/**
 * Structural problems, phrased so they can be handed straight back to the
 * model. Small local models drop required fields constantly; the validate →
 * feed-errors-back loop is what turns that into a usable spec.
 */
export declare function validateSpec(text: string): string[];
/** First PENDING feature whose dependencies are all satisfied. */
export declare function nextPending(features: Feature[]): Feature | undefined;
/** PENDING features exist, but every one of them is blocked by dependencies. */
export declare function hasBlockedPending(features: Feature[]): boolean;
/**
 * Rewrite exactly one `status:` line, then re-read to confirm.
 *
 * If this silently fails the main loop reprocesses the same feature forever, so
 * the write is verified and the feature count is checked for good measure.
 */
export declare function setStatus(file: string, index: number, status: FeatureStatus): void;
/** Move every feature in `from` back to PENDING. Returns how many moved. */
export declare function resetFrom(file: string, from: string): number;
/** Unstick features left IN_PROGRESS by a run that died mid-flight. */
export declare function resetStale(file: string, onReset?: (f: Feature) => void): number;
export interface SpecSummary {
    total: number;
    completed: number;
    unverified: number;
    failed: number;
    pending: number;
    inProgress: number;
    blocked: number;
}
export declare function summarize(features: Feature[]): SpecSummary;
export declare function statusMark(status: string): string;
