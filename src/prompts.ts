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

export function agentsPrompt(agentsFile: string): string {
  return `You are the architect of a brand-new project. The repository is EMPTY.

Read the attached brief and write exactly ONE file using the write tool:
${agentsFile}. Nothing else. Do not write code, do not ask questions, do not
explain.

${agentsFile} holds the permanent rules for anyone working in this repo. Keep it
short and actionable, 60 lines maximum. Include:
- What the project is, in two sentences.
- The chosen stack and versions.
- A concrete directory layout with real paths.
- Conventions: naming, error handling, style.
- How to run the tests (the exact command).
- Hard rules: what must not be touched, which dependencies are forbidden.

Stop as soon as ${agentsFile} is written.`;
}

export function specPrompt(specFile: string, featureTarget: number): string {
  return `The project already has its AGENTS.md (it is loaded). Now write exactly
ONE file using the write tool: ${specFile}. Nothing else.

This is the backlog. Aim for about ${featureTarget} features ordered by
dependency: earlier features must never depend on later ones. Each feature must
be implementable in a single step and verifiable by a test.

Use EXACTLY this format. Fields are unindented, one per line:

## feature: Short imperative name
id: F001
status: PENDING
depends: none
acceptance:
  - an observable, verifiable criterion
  - another criterion
notes: |
  Technical detail: which files it touches, function signatures.

## feature: The next one
id: F002
status: PENDING
depends: F001
acceptance:
  - ...
notes: |
  ...

Format rules, no exceptions:
- Every feature starts at status: PENDING.
- Ids are F001, F002, F003... sequential and unique.
- 'depends' is 'none' or a list of ids defined EARLIER in the file.
- 'acceptance' always exists and has at least one dash item.
- The first feature is NOT the scaffolding: the skeleton will already exist.

Stop as soon as ${specFile} is written.`;
}

export function specRetryPrompt(specFile: string, errors: string[]): string {
  return `

## MANDATORY CORRECTION
The ${specFile} you wrote does not parse. Exact errors:

${errors.map((e) => `- ${e}`).join("\n")}

Rewrite the whole file, well-formed. Only that file.`;
}

export function scaffoldPrompt(agentsFile: string, testCmdFile: string): string {
  return `You are preparing the project skeleton. Do NOT implement any feature yet.

Read ${agentsFile} (already in the repo) and do exactly this:

1. Create the directory layout ${agentsFile} declares.
2. Create the stack manifest (package.json, pyproject.toml, go.mod, Cargo.toml —
   whichever applies) with the test runner configured.
3. Create ONE minimal test that passes, of the "the package imports" kind. Do
   not test features that do not exist yet.
4. Create entry points that are empty but valid (they must import without
   crashing).
5. If the stack needs dependencies, install them now with the bash tool. If you
   use a virtual environment, put it in ./.venv inside the project.
6. Run the test suite with the bash tool and fix whatever fails until it is green.
7. IMPORTANT: write into ${testCmdFile} a single line containing the EXACT test
   command you just ran, verbatim, with no markdown and no decoration. The
   harness uses that file to verify every feature. If you used a virtualenv, use
   the venv interpreter path in the command.
   Valid examples:
       python3 -m unittest discover -s tests
       .venv/bin/pytest -q
       npm test --silent

Done means: the command runs, passes, and is written to ${testCmdFile}. Without
that, nothing else in the project can be verified.

Do not implement any backlog feature. Do not write PROJECT_SPEC.md.`;
}

export function featurePrompt(opts: {
  specFile: string;
  testCommand: string;
}): string {
  return `Implement ONE single feature from the backlog. It is in the attached file.

Rules:
1. Follow AGENTS.md (architecture, conventions, layout). It is already loaded.
2. Write the code AND its tests. Every 'acceptance' criterion needs a test.
3. It must pass: ${opts.testCommand || "(no verification command configured)"}
4. Run that command with the bash tool before you consider yourself done.
5. Do NOT edit ${opts.specFile}. The harness owns feature status.
6. Do not refactor what already works and do not touch other features.`;
}

/**
 * The single most effective correction for a local model: telling it plainly
 * that its last turn changed nothing. Measured: a model that failed two
 * features in a row this way completed both as soon as it was told.
 */
export const NO_WRITES_NUDGE = `

## ATTENTION: your previous attempt modified NOTHING
You replied with text without using the tools. Describing the code does not
count: the files are unchanged and the feature is still not done.

This turn, before any explanation:
- use the write/edit tool to create or modify the files;
- then use the bash tool to run the tests.
Do not explain what you are going to do. Do it.`;

export const NO_TESTS_NUDGE = `

## ATTENTION: your previous attempt wrote no tests
You touched the code but no test file. The suite still passes only because the
existing tests belong to OTHER features — they prove nothing about this one.

This turn, write new tests covering every 'acceptance' criterion of this
feature, in the appropriate test file. No stubs and no filler assertions: the
test must fail if the implementation is wrong.`;

export function failedVerificationSection(command: string, output: string): string {
  return `

## The previous attempt failed
Real output of \`${command}\`:

\`\`\`
${output}
\`\`\`

Fix exactly that. Do not rewrite from scratch what already worked.`;
}

export function missingFileNudge(file: string): string {
  return `

## Attention
Your previous attempt did not create the file. Use the write tool to create
${file} right now.`;
}
