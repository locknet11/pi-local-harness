/**
 * Git: checkpoints, per-feature commits, and rollback.
 *
 * pi does not auto-commit, which turns out to be an advantage: the harness
 * controls exactly where the cut is and can undo a feature that ended broken.
 *
 * Rollback is the difference between a project that grows and one that rots.
 * A failed attempt from a small model usually leaves broken imports and
 * half-written files behind; if that stays in the tree, the next feature starts
 * on rubble and fails too.
 */
import { run } from "./proc.js";
async function git(ctx, args, timeoutSeconds = 120) {
    return run("git", args, { cwd: ctx.cwd, timeoutSeconds });
}
export async function isRepo(ctx) {
    const r = await git(ctx, ["rev-parse", "--is-inside-work-tree"], 15);
    return r.code === 0 && r.stdout.trim() === "true";
}
export async function head(ctx) {
    const r = await git(ctx, ["rev-parse", "--short", "HEAD"], 15);
    return r.code === 0 ? r.stdout.trim() : "";
}
export async function isDirty(ctx) {
    const r = await git(ctx, ["status", "--porcelain"], 30);
    return r.stdout.trim() !== "";
}
export async function ensureIdentity(ctx) {
    if ((await git(ctx, ["config", "user.email"], 10)).code !== 0) {
        await git(ctx, ["config", "user.email", "harness@localhost"], 10);
    }
    if ((await git(ctx, ["config", "user.name"], 10)).code !== 0) {
        await git(ctx, ["config", "user.name", "pi-local-llm-harness"], 10);
    }
}
const DEFAULT_GITIGNORE = `node_modules/
__pycache__/
*.pyc
.venv/
venv/
dist/
build/
target/
.DS_Store
.harness/tmp/
.harness/run/
.harness/*.log
`;
export async function initRepo(ctx, writeGitignore) {
    if (await isRepo(ctx)) {
        await ensureIdentity(ctx);
        return;
    }
    await git(ctx, ["init", "-q"], 30);
    await ensureIdentity(ctx);
    writeGitignore();
    await git(ctx, ["add", "-A"], 60);
    await git(ctx, ["commit", "-q", "-m", "chore: initialise repository (pi-local-llm-harness)"], 60);
}
export const defaultGitignore = DEFAULT_GITIGNORE;
/** Commit anything outstanding so there is a clean point to roll back to. */
export async function checkpoint(ctx, label) {
    if (!(await isRepo(ctx)))
        return "";
    if (await isDirty(ctx)) {
        await git(ctx, ["add", "-A"], 60);
        await git(ctx, ["commit", "-q", "-m", `chore(harness): checkpoint before '${label}'`], 60);
    }
    const r = await git(ctx, ["rev-parse", "HEAD"], 15);
    return r.code === 0 ? r.stdout.trim() : "";
}
export async function commitFeature(ctx, id, name, status) {
    if (!(await isRepo(ctx)))
        return null;
    await git(ctx, ["add", "-A"], 60);
    const staged = await git(ctx, ["diff", "--cached", "--quiet"], 30);
    if (staged.code === 0)
        return null; // nothing to commit
    const prefix = status === "COMPLETED" || status === "UNVERIFIED" ? "feat" : "wip";
    const suffix = status === "UNVERIFIED" ? " [unverified]" : "";
    const message = `${prefix}(${id}): ${name}${suffix}`;
    const r = await git(ctx, ["commit", "-q", "-m", message], 60);
    if (r.code !== 0)
        return null;
    return message;
}
export async function rollbackTo(ctx, ref) {
    if (!ref || !(await isRepo(ctx)))
        return false;
    const reset = await git(ctx, ["reset", "-q", "--hard", ref], 60);
    if (reset.code !== 0)
        return false;
    await git(ctx, ["clean", "-qfd"], 60);
    return true;
}
export async function ensureBranch(ctx, branch) {
    if (!branch || !(await isRepo(ctx)))
        return;
    const current = await git(ctx, ["rev-parse", "--abbrev-ref", "HEAD"], 15);
    if (current.stdout.trim() === branch)
        return;
    const exists = await git(ctx, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], 15);
    await git(ctx, exists.code === 0 ? ["checkout", "-q", branch] : ["checkout", "-q", "-b", branch], 30);
}
export async function diffStat(ctx, ref) {
    if (!ref)
        return "";
    const r = await git(ctx, ["diff", "--shortstat", ref], 30);
    return r.stdout.trim();
}
/** Files that look like tests, across the common ecosystems. */
export const TEST_FILE_PATTERN = /(^|\/)(tests?|spec|__tests__)\/|(^|\/)test_[^/]*$|_test\.[a-z]+$|\.(test|spec)\.[jt]sx?$|Tests?\.(java|kt|cs)$|_spec\.rb$/;
/**
 * Did this feature touch any test file?
 *
 * A green suite only proves you did not break the old thing. Without this
 * check, a model can write a stub, leave the previous feature's tests passing,
 * and collect a COMPLETED — which is exactly what happened in testing: two
 * features "done" on top of a duplicated `return 0.0  # Dummy return`.
 */
export async function testFilesChangedSince(ctx, ref) {
    if (!ref || !(await isRepo(ctx)))
        return 0;
    const changed = await git(ctx, ["diff", "--name-only", ref], 30);
    const untracked = await git(ctx, ["ls-files", "--others", "--exclude-standard"], 30);
    const files = [...changed.stdout.split("\n"), ...untracked.stdout.split("\n")]
        .map((f) => f.trim())
        .filter(Boolean);
    return files.filter((f) => TEST_FILE_PATTERN.test(f)).length;
}
//# sourceMappingURL=git.js.map