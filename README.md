# pi-local-llm-harness

A harness around the [pi](https://pi.dev) coding agent that lets a **local LLM**
build a medium-sized project **from scratch**: it interviews you, writes the
backlog, stands up the scaffold, then implements feature by feature, verifying
each one against real tests.

Works with **LM Studio** and **Ollama**, on **macOS** and **Linux**.

It started as a bash orchestrator for aider that ran the feature loop fine but
could never start from an empty directory. The loop was not the problem: nothing
defined **what** to build, and nothing prepared ground that could be verified.

## Install

```bash
npm install -g github:YOUR_USER/pi-local-llm-harness
```

Installing from a git URL runs the TypeScript build automatically (`prepare`).
For local development:

```bash
git clone <this repo> && cd pi-local-llm-harness
npm install && npm run build
npm link              # puts `pi-harness` on your PATH
```

You also need the agent itself:

```bash
npm install -g @earendil-works/pi-coding-agent
```

## Quick start

```bash
cd ~/my-new-project

pi-harness doctor                 # what is wrong before you waste an hour
pi-harness models                 # what your backend can serve
pi-harness setup-model <model>    # register it with pi
pi-harness tune-ctx <model> --context 32768
pi-harness build                  # interview, scaffold, then implement
```

No interest in answering the interview:

```bash
pi-harness build --idea "A Go CLI that syncs folders over SSH" --yes
pi-harness build --brief ./my-brief.md --yes
```

## Why three phases instead of one loop

```
init ──▶ interview ──▶ AGENTS.md ──▶ PROJECT_SPEC.md ──▶ scaffold
                                        (validated)      (tests green)
                                                             │
run  ────────────────────────────────────────────────────────┘
      per feature: pi implements ──▶ tests ──▶ commit
                        ▲              │
                        └── retry ─────┘ (with the real error text)
                                       └── N failures ──▶ rollback
```

Each phase ends in something **checkable**, not a promise from the model:

| Phase | Done when | Otherwise |
|---|---|---|
| `init` | the spec parses and every feature is well-formed | the exact parse errors go back to the model and it retries |
| `scaffold` | the test command runs and passes | retry with the real failure output |
| `run` | each feature passes its tests | retry; after N attempts, `FAILED` + rollback |

Without the scaffold phase the first feature has nothing to verify against and
the whole loop becomes decorative: the model says "done" and nobody disagrees.

## Commands

| Command | What it does |
|---|---|
| `init` | Interview, write AGENTS.md + PROJECT_SPEC.md, build the scaffold |
| `run` | Implement the backlog, feature by feature |
| `build` | `init` then `run` |
| `doctor [--probe]` | Diagnose everything; `--probe` really tests tool calling |
| `models` | List backend models, marking which are loaded |
| `setup-model [id]` | Register the model with pi (non-destructive merge) |
| `tune-ctx [id]` | Make the model serve a large enough context |
| `probe` | Check the model actually executes tools |
| `spec [--json]` | Backlog status |
| `reset [STATUS]` | Return features to PENDING (default `FAILED`) |
| `status` / `stop` | Inspect or stop a run |
| `init-config` | Write a `harness.config.json` template |

Useful flags: `--once`, `--feature F003`, `--provider`, `--model`, `--context`,
`--features N`, `--dir <path>`, `--yes`.

## Backends

Both expose an OpenAI-compatible endpoint, so pi treats them identically. What
differs — listing models, controlling context, freeing memory — is behind a
provider interface. Omit `--provider` and the harness picks whichever backend is
actually running.

### LM Studio

```bash
lms server start
pi-harness models
pi-harness tune-ctx "google/gemma-4-26b-a4b-qat" --context 32768
```

Context is a **load-time** flag, so raising it needs no derived model and no
extra disk. The harness runs `lms load <model> -c <n> --gpu max` for you.
To keep models off your system disk, point LM Studio at another folder in
**My Models → change folder**.

### Ollama

```bash
export OLLAMA_MODELS="/Volumes/External Disk/LLM Models/ollama-models"
export OLLAMA_CONTEXT_LENGTH=32768
ollama serve
```

`OLLAMA_MODELS` must be visible to the **server** process, not just your shell.
Same for `OLLAMA_CONTEXT_LENGTH`.

## The traps that cost real runs

### 1. Context is silently truncated

Ollama serves models at **4096 tokens** by default. pi's system prompt alone is
larger than that, so the agent starts already truncated — no error, no warning,
just a model that looks far dumber than it is.

Measured on Fedora with Ollama 0.32.1:

```
$ ollama ps
NAME                ID              SIZE      PROCESSOR    CONTEXT
qwen2.5-coder:7b    dae161e27b0e    4.6 GB    100% GPU     4096      ← the default
```

`doctor` catches it. Note that `/api/show` hides `num_ctx` inside the
`parameters` **string**, not as a JSON field, so naive checks report a correctly
configured model as unconfigured.

Always confirm with `ollama ps` / `lms ps` — the CONTEXT column is the truth.

### 2. "Supports tools" does not mean "can use tools"

A model can advertise `tools` and still reply with

```json
{"name": "write", "arguments": {"path": "hello.txt", "content": "HI"}}
```

as **plain text**. pi never sees a tool call, nothing is written, and the exit
code is 0. The capability flag comes from the chat template, not the model.
`qwen2.5-coder:7b` does exactly this.

```bash
pi-harness probe          # costs one inference, saves an hour
```

### 3. Thinking left on, silently

Modern local models reason before answering. For agentic coding that is mostly
wasted time: each call pays for a long reasoning dump before touching a file.

The trap is that turning it off requires the backend to receive
`reasoning_effort`, and the compat flags Ollama needs (`supportsReasoningEffort:
false`) **stop pi from sending it at all**. Apply those flags to LM Studio —
which implements the field correctly — and thinking can never be disabled.

Measured with `qwen3.5-9b` on LM Studio:

| `reasoning_effort` | Result |
|---|---|
| `minimal`, `low` | still emits a full reasoning pass first |
| `none` | answers immediately |

`setup-model` handles this: it detects whether the model is reasoning-capable
with a one-token probe, then registers a `thinkingLevelMap` so pi's `off`
arrives as `none`. Ollama keeps the compat flags it genuinely needs.

### 4. A green suite that proves nothing

The nastiest one. The model writes code but no tests. The suite still passes —
because the tests belong to *earlier* features — and the feature is marked
COMPLETED. Measured: two features "done" on top of a `return 0.0  # Dummy`
that was even defined twice.

A passing suite only proves you did not break the old thing. So every feature
must touch a test file (`requireTestChanges`, on by default).

## Getting the most out of a small model

Context is the scarce resource:

- **A fresh session per feature.** Carrying context between features fills the
  window with stale noise and the model truncates what matters.
- **AGENTS.md is never attached** — pi discovers it automatically; attaching it
  would double the cost.
- **One feature per call**, never the whole backlog.
- **One file per call** during bootstrap. Asked for AGENTS.md and
  PROJECT_SPEC.md in one turn, small models write the first, describe the second
  in prose, and stop — zero errors, zero files.
- **Errors are trimmed** (`testExcerptLines`): head and tail, where the first
  error and the summary live.
- **Rollback on failure**, so each feature starts from green.
- **Name the mistake on retry.** Re-sending an identical prompt gets an
  identical failure. Telling the model "your last turn changed nothing" is what
  breaks the loop — measured: a model that failed two features in a row
  completed both as soon as it was told.

## Choosing a model

Two things must fit in memory: the weights and the KV cache for the context.

**8 GB VRAM (tested on an RTX 2070 Super)** is genuinely marginal. Same project,
same prompt, four models:

| Model | Memory | Result |
|---|---|---|
| `gemma4:e2b` | 2.1 GB | docs fine, **scaffold failed 3/3** — invalid `pyproject.toml`, and an `__init__.py` whose contents were the literal text `__init__.py` |
| `qwen2.5-coder:7b` | 4.6 GB | **cannot execute tools**; returns the tool-call JSON as text |
| `qwen3.5:latest` | 6.2 GB | executes tools, but stalled >10 min reasoning on the first prompt |
| `gemma4:e4b` | 3.3 GB | **best of the four** — full project, 2/3 features genuinely implemented and tested |

**32 GB unified memory (Apple M1 Pro)** is a different world. A 26B MoE model
like `gemma-4-26b-a4b-qat` uses ~15.6 GB at 32k context and only activates ~4B
parameters per token, so it is both capable and fast.

Rules of thumb:

- Model **capacity matters more than context size**. A 2B model with 131k
  context is useless for agentic coding; a 7-9B coder-tuned model at 32k is not.
- `OLLAMA_KV_CACHE_TYPE=q8_0` roughly halves the KV cache — the cheapest context
  you can buy.
- Always run `pi-harness probe` before committing to a model.

## Configuration

`pi-harness init-config` writes `harness.config.json`. Precedence is
defaults < file < environment < CLI flags.

| Key | Default | Meaning |
|---|---|---|
| `provider` | auto-detected | `lmstudio` or `ollama` |
| `model` | largest available | Model id as the backend names it |
| `contextLength` | `32768` | Context the model must be served with |
| `maxRetries` | `4` | Attempts per feature |
| `maxConsecutiveFailures` | `3` | Global stop; something is broken at the root |
| `featureTimeout` | `1800` | Seconds per attempt |
| `testTimeout` | `600` | Seconds for the suite |
| `featureTarget` | `10` | Backlog size for `init` |
| `requireTestChanges` | `true` | A feature must touch a test file |
| `rollbackOnFail` | `true` | Undo a failed feature's mess |
| `testCommand` | `""` | Force a command instead of using the declared one |
| `gitBranch` | `""` | Work on a branch instead of the current one |

## Feature states

`PENDING → IN_PROGRESS → COMPLETED` on the happy path. Also:

- **UNVERIFIED** — accepted with no test command. Review these by hand.
- **FAILED** — retries exhausted. `pi-harness reset FAILED` requeues them.
- **BLOCKED** — set by hand for things that will not work.

If the harness dies mid-run, `IN_PROGRESS` features return to `PENDING`
automatically on the next start.

## Tests

```bash
npm test        # 91 tests, no network, no GPU, no tokens
```

They run the orchestrator against a **fake pi**: state transitions, retries,
rollback, timeouts, process-group kills, dependency ordering, and all three
"green but fake" failure modes. That is exactly what breaks silently if you only
ever test against a real model.

## Layout

```
src/
  cli.ts          commands and argument parsing
  config.ts       defaults < file < env < flags
  spec.ts         PROJECT_SPEC.md parse / validate / mutate
  loop.ts         the feature loop
  bootstrap.ts    interview, docs, scaffold
  prompts.ts      every prompt, in one place
  pi.ts           driving pi and reading its JSON event stream
  verify.ts       test-command resolution and execution
  git.ts          checkpoints, commits, rollback
  proc.ts         timeouts, process groups, signals
  providers/      ollama.ts · lmstudio.ts behind one interface
legacy-bash/      the original bash implementation, kept for reference
```

## Known limitations

- **The model can contradict its own AGENTS.md.** In one run it declared the
  layout as `csv2json/` and then wrote everything into `src/`. Tests still
  passed, but the doc was lying. Skim AGENTS.md before a long run.
- **No loop rescues a bad backlog.** If features come out huge or badly ordered,
  edit `PROJECT_SPEC.md` by hand before `run`. It is plain text for that reason.
- **`UNVERIFIED` is not `COMPLETED`.** With no tests, nothing is guaranteed.

## License

MIT
