/**
 * Every prompt the harness sends, in one place.
 *
 * Two rules learned from running these against small local models:
 *
 *   1. One deliverable per call. Asking for AGENTS.md and PROJECT_SPEC.md in a
 *      single turn makes models write the first, describe the second in prose,
 *      and end the turn — zero errors, zero files.
 *   2. On a retry, say what went wrong. Re-sending an identical prompt gets an
 *      identical failure; naming the mistake is what breaks the loop.
 */
export declare function agentsPrompt(agentsFile: string, stateDir: string): string;
export declare function specPrompt(specFile: string, featureTarget: number, stateDir: string): string;
export declare function specRetryPrompt(specFile: string, errors: string[]): string;
export declare function scaffoldPrompt(agentsFile: string, testCmdFile: string): string;
export declare function featurePrompt(opts: {
    specFile: string;
    testCommand: string;
}): string;
/**
 * The single most effective correction for a local model: telling it plainly
 * that its last turn changed nothing. Measured: a model that failed two
 * features in a row this way completed both as soon as it was told.
 */
export declare const NO_WRITES_NUDGE = "\n\n## ATTENTION: your previous attempt modified NOTHING\nYou replied with text without using the tools. Describing the code does not\ncount: the files are unchanged and the feature is still not done.\n\nThis turn, before any explanation:\n- use the write/edit tool to create or modify the files;\n- then use the bash tool to run the tests.\nDo not explain what you are going to do. Do it.";
export declare const NO_TESTS_NUDGE = "\n\n## ATTENTION: your previous attempt wrote no tests\nYou touched the code but no test file. The suite still passes only because the\nexisting tests belong to OTHER features \u2014 they prove nothing about this one.\n\nThis turn, write new tests covering every 'acceptance' criterion of this\nfeature, in the appropriate test file. No stubs and no filler assertions: the\ntest must fail if the implementation is wrong.";
export declare function failedVerificationSection(command: string, output: string): string;
export declare function missingFileNudge(file: string): string;
