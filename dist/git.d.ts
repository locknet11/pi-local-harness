export interface GitContext {
    cwd: string;
}
export declare function isRepo(ctx: GitContext): Promise<boolean>;
export declare function head(ctx: GitContext): Promise<string>;
export declare function isDirty(ctx: GitContext): Promise<boolean>;
export declare function ensureIdentity(ctx: GitContext): Promise<void>;
export declare function initRepo(ctx: GitContext, writeGitignore: () => void): Promise<void>;
export declare const defaultGitignore = "node_modules/\n__pycache__/\n*.pyc\n.venv/\nvenv/\ndist/\nbuild/\ntarget/\n.DS_Store\n.harness/tmp/\n.harness/run/\n.harness/*.log\n";
/** Commit anything outstanding so there is a clean point to roll back to. */
export declare function checkpoint(ctx: GitContext, label: string): Promise<string>;
export declare function commitFeature(ctx: GitContext, id: string, name: string, status: string): Promise<string | null>;
export declare function rollbackTo(ctx: GitContext, ref: string): Promise<boolean>;
export declare function ensureBranch(ctx: GitContext, branch: string): Promise<void>;
export declare function diffStat(ctx: GitContext, ref: string): Promise<string>;
/** Files that look like tests, across the common ecosystems. */
export declare const TEST_FILE_PATTERN: RegExp;
/**
 * Did this feature touch any test file?
 *
 * A green suite only proves you did not break the old thing. Without this
 * check, a model can write a stub, leave the previous feature's tests passing,
 * and collect a COMPLETED — which is exactly what happened in testing: two
 * features "done" on top of a duplicated `return 0.0  # Dummy return`.
 */
export declare function testFilesChangedSince(ctx: GitContext, ref: string): Promise<number>;
