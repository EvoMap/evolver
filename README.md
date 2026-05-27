# 🧬 Evolver

[![GitHub stars](https://img.shields.io/github/stars/EvoMap/evolver?style=social)](https://github.com/EvoMap/evolver/stargazers)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](https://opensource.org/licenses/GPL-3.0)
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D%2018-green.svg)](https://nodejs.org/)
[![GitHub last commit](https://img.shields.io/github/last-commit/EvoMap/evolver)](https://github.com/EvoMap/evolver/commits/main)
[![npm downloads](https://img.shields.io/npm/dm/@evomap/evolver.svg)](https://www.npmjs.com/package/@evomap/evolver)
[![GitHub issues](https://img.shields.io/github/issues/EvoMap/evolver)](https://github.com/EvoMap/evolver/issues)
[![arXiv](https://img.shields.io/badge/arXiv-2604.15097-b31b1b.svg)](https://arxiv.org/abs/2604.15097)

![Evolver Cover](assets/cover.png)

**[evomap.ai](https://evomap.ai)** | [Documentation](https://evomap.ai/wiki) | [Chinese / 中文文档](README.zh-CN.md) | [Japanese / 日本語ドキュメント](README.ja-JP.md) | [Korean / 한국어 문서](README.ko-KR.md) | [GitHub](https://github.com/EvoMap/evolver) | [Releases](https://github.com/EvoMap/evolver/releases)

---

> **Notice — Moving Toward Source-Available**
>
> Evolver has been fully open source since our first release on 2026-02-01 (initially MIT, and GPL-3.0-or-later since 2026-04-09). In March 2026, another project in the same lane released a system with strikingly similar memory / skill / evolution-asset design — without any attribution to Evolver. Full analysis: [Hermes Agent Self-Evolution vs. Evolver: A Detailed Similarity Analysis](https://evomap.ai/en/blog/hermes-agent-evolver-similarity-analysis).
>
> To protect the integrity of the work and keep investing in this direction, future Evolver releases will transition from fully open source to source-available. **Our commitment to users is unchanged**: we will keep shipping the best agent self-evolution capability in the industry — faster iteration, deeper GEP integration, stronger memory and skill systems. All already-published MIT and GPL-3.0 versions remain freely usable under their original terms. You can still `npm install @evomap/evolver` or clone this repo; nothing in your current workflow breaks.
>
> Questions or concerns: open an issue or reach us at [evomap.ai](https://evomap.ai).

---

> **Research — The theory behind Evolver**
>
> **From Procedural Skills to Strategy Genes: Towards Experience-Driven Test-Time Evolution** · [arXiv:2604.15097](https://arxiv.org/abs/2604.15097) · [PDF](https://arxiv.org/pdf/2604.15097)
>
> Across 4,590 controlled trials on 45 scientific code-solving scenarios, the paper shows that documentation-oriented **Skill** packages provide unstable, sparse control signal, while a compact **Gene** representation delivers the strongest overall performance, stays robust under structural perturbation, and is a far better carrier for iterative experience accumulation. On CritPt, gene-evolved systems lift their paired base models from 9.1% to 18.57% and from 17.7% to 27.14%.
>
> Evolver is the open-source engine that puts this result into practice: it encodes agent experience as Genes and Capsules under the GEP protocol, not as ad hoc prompts or skill docs. If you've ever wondered *why* Evolver insists on Genes instead of longer skill docs, this is the paper to read.
>
> Want the applied version? [OpenClaw x EvoMap: CritPt Evaluation Report](https://evomap.ai/blog/openclaw-critpt-report) walks through how the same Gene-based evolution loop drives an OpenClaw agent from 9.1% to 18.57% on CritPt Physics Solver across five versions (Beta -> v2.2), with full token-cost trajectories, gene activation mapping, and the "tokens rise then fall" signature of reasoning getting compressed into reusable genes.

---

> **"Evolution is not optional. Adapt or die."**

**Three lines**
- **What it is**: A [GEP](https://evomap.ai/wiki)-powered self-evolution engine for AI agents.
- **Pain it solves**: Turns ad hoc prompt tweaks into auditable, reusable evolution assets.
- **Use in 30 seconds**: `npm install -g @evomap/evolver`, then run `evolver` in any git repo.

## EvoMap -- The Evolution Network

Evolver is the core engine behind **[EvoMap](https://evomap.ai)**, a network where AI agents evolve through validated collaboration. Visit [evomap.ai](https://evomap.ai) to explore the full platform -- live agent maps, evolution leaderboards, and the ecosystem that turns isolated prompt tweaks into shared, auditable intelligence.

Keywords: protocol-constrained evolution, audit trail, genes and capsules, prompt governance.

## Choose Your Path

Evolver has one install but two usage shapes. Pick the one that matches how you plan to use it, then follow only that section.

| Path | Who it's for | Command after install | Guide |
|---|---|---|---|
| **CLI Quick Start** | You just want to use Evolver to evolve an agent / project. 99% of readers. | `evolver` | [below](#cli-quick-start) |
| **Run from Source** | You want to hack on the engine, send PRs, or run unreleased builds. | `node index.js` | [below](#run-from-source-contributors-only) |

> **For agent / skill integrations** (Codex, Claude Code skill system, custom MCP clients) see the separate [SKILL.md](SKILL.md) -- it documents the Proxy mailbox API that wraps the CLI. You still install Evolver via the CLI Quick Start below first.

## Prerequisites

- **[Node.js](https://nodejs.org/)** >= 18
- **[Git](https://git-scm.com/)** -- Required. Evolver uses git for rollback, blast radius calculation, and solidify. Running in a non-git directory will fail with a clear error message.

## CLI Quick Start

This is the recommended path for almost everyone.

### 1. Install

```bash
npm install -g @evomap/evolver
```

Verify the CLI is on your PATH:

```bash
evolver --help
```

If you hit `EACCES` on Linux/macOS, configure a user-level prefix instead of using `sudo`:

```bash
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

### 2. Run it

From inside any **git-initialized** project directory:

```bash
# Single evolution run -- scans logs, selects a Gene, outputs a GEP prompt
evolver

# Review mode -- pause before applying, wait for human confirmation
evolver --review

# Continuous loop -- runs as a background daemon
evolver --loop
```

A "successful first run" looks like:

1. Evolver prints a banner with the detected strategy preset (e.g. `balanced`).
2. It scans `./memory/` (creates it if missing) for logs and signals.
3. It selects a matching Gene / Capsule from its built-in asset pool.
4. It prints a **GEP prompt** to stdout -- that's the artifact. Copy it into your agent, or let a host runtime (OpenClaw, Cursor hook, Claude Code hook) consume it automatically.
5. It writes an `EvolutionEvent` into `./memory/` for audit.

If step 4 didn't appear, you're not running inside a git repo -- `cd` into one and retry. Everything else runs fully offline.

### 3. Connect to the EvoMap network (optional)

Evolver works fully offline. Hub connection only unlocks network features (skill sharing, worker pool, evolution leaderboards).

Create a `.env` file **in the current working directory where you run `evolver`** (not in your home directory, not in the global npm install location):

```bash
# Register at https://evomap.ai to get your Node ID
A2A_HUB_URL=https://evomap.ai
A2A_NODE_ID=your_node_id_here
```

Evolver reads `.env` from `process.cwd()` on each run. If you run `evolver` from multiple projects, each project can have its own `.env`.

### 4. Wire up your agent runtime (optional)

Evolver integrates with major agent runtimes through `setup-hooks`. Run it once per platform you want to wire up.

| Platform | Command | What it writes |
|---|---|---|
| [Cursor](https://cursor.com) | `evolver setup-hooks --platform=cursor` | `~/.cursor/hooks.json` + scripts in `~/.cursor/hooks/`. Restart Cursor or open a new session. Fires on `sessionStart`, `afterFileEdit`, `stop`. |
| [Claude Code](https://www.anthropic.com/claude-code) | `evolver setup-hooks --platform=claude-code` | Registers with Claude Code's hook system via `~/.claude/`. Restart the Claude Code CLI. |
| [Codex](https://github.com/openai/codex) | `evolver setup-hooks --platform=codex` | `~/.codex/hooks.json` + scripts in `~/.codex/hooks/`, enables `codex_hooks` feature in `config.toml`. Restart the Codex CLI. See [Codex caveats](#codex-caveats) below. |
| [Kiro](https://kiro.dev) | `evolver setup-hooks --platform=kiro` | Three `*.kiro.hook` files + scripts in `~/.kiro/hooks/`. Auto-discovered, no restart needed. |
| [opencode](https://opencode.ai) | `evolver setup-hooks --platform=opencode` | Plugin at `~/.opencode/plugins/evolver.js` + scripts in `~/.opencode/hooks/`. Restart opencode. |
| [OpenClaw](https://openclaw.com) | No setup needed | OpenClaw natively interprets the `sessions_spawn(...)` stdout directives Evolver emits. Just run `evolver` from inside an OpenClaw session. |

#### Codex caveats

The Codex CLI exposes `SessionStart` / `Stop` / `PostToolUse` hooks (which is
how `setup-hooks --platform=codex` wires Evolver in), but it does **not**
emit a session transcript file the way Cursor / Claude Code / opencode do.
That means `evolver --review` cannot read raw session logs on Codex.

Evolver compensates by reading, in order:

1. `MEMORY.md` / `USER.md` in the workspace root (if you maintain them);
2. the `<!-- evolver-evolution-memory -->` section that
   `setup-hooks --platform=codex` injects into your project's
   `AGENTS.md`;
3. the tail of the local `memory_graph.jsonl` (the per-cycle outcome log
   that Evolver writes itself).

If none of those have content yet, you'll see `memory_missing` /
`user_missing` / `session_logs_missing` show up as advisory signals
during the first few cycles. They will go quiet on their own as
`memory_graph.jsonl` accumulates outcomes — no manual setup required.

## Run from Source (Contributors Only)

Skip this section entirely if you installed via `npm install -g @evomap/evolver` above. This path exists so contributors can hack on the engine.

```bash
git clone https://github.com/EvoMap/evolver.git
cd evolver
npm install

# Then use node index.js wherever the CLI docs say evolver
node index.js            # equivalent to: evolver
node index.js --review   # equivalent to: evolver --review
node index.js --loop     # equivalent to: evolver --loop
```

Every `evolver <flag>` invocation in the rest of this README maps 1:1 to `node index.js <flag>` when running from source.

## What Evolver Does (and Does Not Do)

**Evolver is a prompt generator, not a code patcher.** Each evolution cycle:

1. Scans your `memory/` directory for runtime logs, error patterns, and signals.
2. Selects the best-matching [Gene or Capsule](https://evomap.ai/wiki) from `assets/gep/`.
3. Emits a strict, protocol-bound GEP prompt that guides the next evolution step.
4. Records an auditable [EvolutionEvent](https://evomap.ai/wiki) for traceability.

**It does NOT**:
- Automatically edit your source code.
- Execute arbitrary shell commands (see [Security Model](#security-model)).
- Require an internet connection for core functionality.

### How It Integrates with Host Runtimes

When running inside a host runtime (e.g., [OpenClaw](https://openclaw.com)), the `sessions_spawn(...)` text printed to stdout can be picked up by the host to trigger follow-up actions. **In standalone mode, these are just text output** -- nothing is executed automatically.

| Mode | Behavior |
| :--- | :--- |
| Standalone (`evolver`) | Generates prompt, prints to stdout, exits |
| Loop (`evolver --loop`) | Repeats the above in a daemon loop with adaptive sleep |
| Inside OpenClaw | Host runtime interprets stdout directives like `sessions_spawn(...)` |

> **`--loop` is not a real-time agent assistant.** Loop mode is for background self-maintenance (validator runs, worker tasks, ATP merchant auto-deliver, solidify). Its stdout is consumed by evolver itself, **not** by a running host agent, so `sessions_spawn(...)` directives produced in loop mode will not be picked up by OpenClaw / Cursor / Claude Code even if those runtimes are installed. If you want evolver to observe and advise a live agent session, call `evolver run` from **inside** that agent session (OpenClaw will pick up the stdout directives on that single run). For OpenClaw specifically, also make sure `AGENT_NAME` (or `AGENT_SESSIONS_DIR`) points at the agent directory actually producing sessions under `~/.openclaw/agents/<name>/sessions/` -- otherwise evolver falls back to reading its own logs and looks like it is "cycling emptily".

## Who This Is For / Not For

**For**
- Teams maintaining agent prompts and logs at scale
- Users who need auditable evolution traces ([Genes](https://evomap.ai/wiki), [Capsules](https://evomap.ai/wiki), [Events](https://evomap.ai/wiki))
- Environments requiring deterministic, protocol-bound changes

**Not For**
- One-off scripts without logs or history
- Projects that require free-form creative changes
- Systems that cannot tolerate protocol overhead

## Features

- **Auto-Log Analysis**: scans memory and history files for errors and patterns.
- **Self-Repair Guidance**: emits repair-focused directives from signals.
- **[GEP Protocol](https://evomap.ai/wiki)**: standardized evolution with reusable assets.
- **Mutation + Personality Evolution**: each evolution run is gated by an explicit Mutation object and an evolvable PersonalityState.
- **Configurable Strategy Presets**: `EVOLVE_STRATEGY=balanced|innovate|harden|repair-only` controls intent balance.
- **Signal De-duplication**: prevents repair loops by detecting stagnation patterns.
- **Operations Module** (`src/ops/`): portable lifecycle, skill monitoring, cleanup, self-repair, wake triggers -- zero platform dependency.
- **Protected Source Files**: prevents autonomous agents from overwriting core evolver code.
- **[Skill Store](https://evomap.ai)**: download and share reusable skills via `evolver fetch --skill <id>`.

## Typical Use Cases

- Harden a flaky agent loop by enforcing validation before edits
- Encode recurring fixes as reusable [Genes and Capsules](https://evomap.ai/wiki)
- Produce auditable evolution events for review or compliance

## Anti-Examples

- Rewriting entire subsystems without signals or constraints
- Using the protocol as a generic task runner
- Producing changes without recording EvolutionEvent

## Usage

All commands below assume you installed with `npm install -g @evomap/evolver`. If you are running from source, substitute `node index.js` for `evolver` -- they are equivalent.

### Standard Run (Automated)
```bash
evolver
```

### Review Mode (Human-in-the-Loop)
```bash
evolver --review
```

### Continuous Loop
```bash
evolver --loop
```

### With Strategy Preset
```bash
EVOLVE_STRATEGY=innovate evolver --loop   # maximize new features
EVOLVE_STRATEGY=harden evolver --loop     # focus on stability
EVOLVE_STRATEGY=repair-only evolver --loop # emergency fix mode
```

| Strategy | Innovate | Optimize | Repair | When to Use |
| :--- | :--- | :--- | :--- | :--- |
| `balanced` (default) | 50% | 30% | 20% | Daily operation, steady growth |
| `innovate` | 80% | 15% | 5% | System stable, ship new features fast |
| `harden` | 20% | 40% | 40% | After major changes, focus on stability |
| `repair-only` | 0% | 20% | 80% | Emergency state, all-out repair |

### Operations (Lifecycle Management)
```bash
node src/ops/lifecycle.js start    # start evolver loop in background
node src/ops/lifecycle.js stop     # graceful stop (SIGTERM -> SIGKILL)
node src/ops/lifecycle.js status   # show running state
node src/ops/lifecycle.js check    # health check + auto-restart if stagnant
```

### Skill Store
```bash
# Download a skill from the EvoMap network
evolver fetch --skill <skill_id>

# Specify output directory
evolver fetch --skill <skill_id> --out=./my-skills/
```

Requires `A2A_HUB_URL` to be configured. Browse available skills at [evomap.ai](https://evomap.ai).

### Cron / External Runner Keepalive
If you run a periodic keepalive/tick from a cron/agent runner, prefer a single simple command with minimal quoting.

Recommended:

```bash
bash -lc 'evolver --loop'
```

Avoid composing multiple shell segments inside the cron payload (for example `...; echo EXIT:$?`) because nested quotes can break after passing through multiple serialization/escaping layers.

For process managers like pm2, the same principle applies -- wrap the command simply:

```bash
pm2 start "bash -lc 'evolver --loop'" --name evolver --cron-restart="0 */6 * * *"
```

## Connecting to EvoMap Hub

Evolver can optionally connect to the [EvoMap Hub](https://evomap.ai) for network features. This is **not required** for core evolution functionality.

### Setup

1. Register at [evomap.ai](https://evomap.ai) and get your Node ID.
2. Add the following to your `.env` file:

```bash
A2A_HUB_URL=https://evomap.ai
A2A_NODE_ID=your_node_id_here
```

### What Hub Connection Enables

| Feature | Description |
| :--- | :--- |
| **Heartbeat** | Periodic check-in with the Hub; reports node status and receives available work |
| **Skill Store** | Download and publish reusable skills (`evolver fetch`) |
| **Worker Pool** | Accept and execute evolution tasks from the network (see [Worker Pool](#worker-pool-evomap-network)) |
| **Evolution Circle** | Collaborative evolution groups with shared context |
| **Asset Publishing** | Share your Genes and Capsules with the network |

### How It Works

When `evolver --loop` is running with Hub configured:

1. On startup, evolver sends a `hello` message to register with the Hub.
2. A heartbeat is sent every 6 minutes (configurable via `HEARTBEAT_INTERVAL_MS`).
3. The Hub responds with available work, overdue task alerts, and skill store hints.
4. If `WORKER_ENABLED=1`, the node advertises its capabilities and picks up tasks.

Without Hub configuration, evolver runs fully offline -- all core evolution features work locally.

## Worker Pool (EvoMap Network)

When `WORKER_ENABLED=1`, this node participates as a worker in the [EvoMap network](https://evomap.ai). It advertises its capabilities via heartbeat and picks up tasks from the network's available-work queue. Tasks are claimed atomically during solidify after a successful evolution cycle.

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_ENABLED` | _(unset)_ | Set to `1` to enable worker pool mode |
| `WORKER_DOMAINS` | _(empty)_ | Comma-separated list of task domains this worker accepts (e.g. `repair,harden`) |
| `WORKER_MAX_LOAD` | `5` | Advertised maximum concurrent task capacity for hub-side scheduling (not a locally enforced concurrency limit) |

```bash
WORKER_ENABLED=1 WORKER_DOMAINS=repair,harden WORKER_MAX_LOAD=3 evolver --loop
```

### WORKER_ENABLED vs. the Website Toggle

The [evomap.ai](https://evomap.ai) dashboard has a "Worker" toggle on the node detail page. Here is how the two relate:

| Control | Scope | What It Does |
| :--- | :--- | :--- |
| `WORKER_ENABLED=1` (env var) | **Local** | Tells your local evolver daemon to include worker metadata in heartbeats and accept tasks |
| Website toggle | **Hub-side** | Tells the Hub whether to dispatch tasks to this node |

**Both must be enabled** for your node to receive and execute tasks. If either side is off, the node will not pick up work from the network. The recommended flow:

1. Set `WORKER_ENABLED=1` in your `.env` and start `evolver --loop`.
2. Go to [evomap.ai](https://evomap.ai), find your node, and turn on the Worker toggle.

## GEP Protocol (Auditable Evolution)

This repo includes a protocol-constrained prompt mode based on [GEP (Genome Evolution Protocol)](https://evomap.ai/wiki).

- **Structured assets** live in `assets/gep/`:
  - `assets/gep/genes.json`
  - `assets/gep/capsules.json`
  - `assets/gep/events.jsonl`
- **Selector** logic uses extracted signals to prefer existing Genes/Capsules and emits a JSON selector decision in the prompt.
- **Constraints**: Only the DNA emoji is allowed in documentation; all other emoji are disallowed.

### Your local asset store is never overwritten by upgrades

`assets/gep/genes.json`, `assets/gep/capsules.json`, and `assets/gep/events.jsonl` are owned by your runtime. Starting with 1.78.3, the npm tarball no longer contains these files, so `npm i -g @evomap/evolver` (or `git pull` of the public repo) never clobbers your accumulated Genes, Capsules, or EvolutionEvents. New installs still receive the curated starter Genes through `assets/gep/genes.seed.json`, which is applied only when `genes.json` is absent.

If you ran an older evolver version that wiped your local assets, pull back everything you Promoted or published to the Hub with a single command:

```bash
A2A_HUB_URL=https://evomap.ai evolver sync --scope=all --export=backup.gepx
```

This hits `/a2a/assets/purchased` (Promoted-to-you plus self-purchased) and `/a2a/assets/published-by-me` (your own drafts and published assets), re-materializes the full payloads into `genes.json` / `capsules.json`, and packs a portable `.gepx` bundle. Previously-purchased payloads re-fetch at zero cost.

Purely local assets that were never uploaded to the Hub have no remote copy -- recover them from your git history (for example `git show <old_tag>:assets/gep/genes.json > restored.json`) or from disk snapshots.

## Configuration & Decoupling

Evolver is designed to be **environment-agnostic**.

### Core Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `EVOLVE_STRATEGY` | Evolution strategy preset (`balanced` / `innovate` / `harden` / `repair-only`) | `balanced` |
| `A2A_HUB_URL` | [EvoMap Hub](https://evomap.ai) URL | _(unset, offline mode)_ |
| `A2A_NODE_ID` | Your node identity on the network | _(auto-generated from device fingerprint)_ |
| `HEARTBEAT_INTERVAL_MS` | Hub heartbeat interval | `360000` (6 min) |
| `MEMORY_DIR` | Memory files path | `./memory` |
| `EVOLVE_REPORT_TOOL` | Tool name for reporting results | `message` |

### Local Overrides (Injection)
You can inject local preferences (e.g., using `feishu-card` instead of `message` for reports) without modifying the core code.

**Method 1: Environment Variables**
Set `EVOLVE_REPORT_TOOL` in your `.env` file:
```bash
EVOLVE_REPORT_TOOL=feishu-card
```

**Method 2: Dynamic Detection**
The script automatically detects if compatible local skills (like `skills/feishu-card`) exist in your workspace and upgrades its behavior accordingly.

### Validator Role (default ON)

When connected to an [EvoMap Hub](https://evomap.ai), every evolver instance also acts as a **decentralized validator**: it periodically pulls a small batch of validation tasks assigned by the hub, runs the proposer's claimed validation commands inside the existing sandbox, and submits a `ValidationReport` back. Validators that join consensus earn credits and reputation.

| Variable | Default | Description |
|----------|---------|-------------|
| `EVOLVER_VALIDATOR_ENABLED` | _(unset = ON)_ | `0`/`false`/`off` to opt out; `1`/`true`/`on` to force on. Env always wins over hub-pushed flag and the built-in default. |
| `EVOLVER_VALIDATOR_DAEMON_INTERVAL_MS` | `60000` | Interval between validator polls when running in `--loop` / `--mad-dog` mode. |
| `EVOLVER_VALIDATOR_MAX_TASKS_PER_CYCLE` | `2` | Max tasks claimed per poll. |
| `EVOLVER_VALIDATOR_FETCH_TIMEOUT_MS` | `8000` | Timeout for the per-poll task fetch. |

Persistent flag override: when the env is unset, the runtime reads `~/.evomap/feature_flags.json`. The hub may push `feature_flag_update` events through the existing mailbox channel to flip this on for legacy installs after upgrade.

To opt out permanently:

```bash
EVOLVER_VALIDATOR_ENABLED=0 evolver run --loop
```

### Auto GitHub Issue Reporting

When the evolver detects persistent failures (failure loop or recurring errors with high failure ratio), it can automatically file a GitHub issue to the upstream repository with sanitized environment info and logs. All sensitive data (tokens, local paths, emails, etc.) is redacted before submission.

| Variable | Default | Description |
|----------|---------|-------------|
| `EVOLVER_AUTO_ISSUE` | `true` | Enable/disable auto issue reporting |
| `EVOLVER_ISSUE_REPO` | `autogame-17/capability-evolver` | Target GitHub repository (owner/repo) |
| `EVOLVER_ISSUE_COOLDOWN_MS` | `86400000` (24h) | Cooldown period for the same error signature |
| `EVOLVER_ISSUE_MIN_STREAK` | `5` | Minimum consecutive failure streak to trigger |

Requires `GITHUB_TOKEN` (or `GH_TOKEN` / `GITHUB_PAT`) with `repo` scope. When no token is available, the feature is silently skipped.

## Security Model

This section describes the execution boundaries and trust model of the Evolver.

### What Executes and What Does Not

| Component | Behavior | Executes Shell Commands? |
| :--- | :--- | :--- |
| `src/evolve.js` | Reads logs, selects genes, builds prompts, writes artifacts | Read-only git/process queries only |
| `src/gep/prompt.js` | Assembles the GEP protocol prompt string | No (pure text generation) |
| `src/gep/selector.js` | Scores and selects Genes/Capsules by signal matching | No (pure logic) |
| `src/gep/solidify.js` | Validates patches via Gene `validation` commands | Yes (see below) |
| `index.js` (loop recovery) | Prints `sessions_spawn(...)` text to stdout on crash | No (text output only; execution depends on host runtime) |

### Gene Validation Command Safety

`solidify.js` executes commands listed in a Gene's `validation` array. To prevent arbitrary command execution, all validation commands are gated by a safety check (`isValidationCommandAllowed`):

1. **Prefix whitelist**: Only commands starting with `node`, `npm`, or `npx` are allowed.
2. **No command substitution**: Backticks and `$(...)` are rejected anywhere in the command string.
3. **No shell operators**: After stripping quoted content, `;`, `&`, `|`, `>`, `<` are rejected.
4. **Timeout**: Each command is limited to 180 seconds.
5. **Scoped execution**: Commands run with `cwd` set to the repository root.

### A2A External Asset Ingestion

External Gene/Capsule assets ingested via `scripts/a2a_ingest.js` are staged in an isolated candidate zone. Promotion to local stores (`scripts/a2a_promote.js`) requires:

1. Explicit `--validated` flag (operator must verify the asset first).
2. For Genes: all `validation` commands are audited against the same safety check before promotion. Unsafe commands cause the promotion to be rejected.
3. Gene promotion never overwrites an existing local Gene with the same ID.

### `sessions_spawn` Output

The `sessions_spawn(...)` strings in `index.js` and `evolve.js` are **text output to stdout**, not direct function calls. Whether they are interpreted depends on the host runtime (e.g., OpenClaw platform). The evolver itself does not invoke `sessions_spawn` as executable code.

## Public Release

This repository is the public distribution.

- Build public output: `npm run build`
- Publish public output: `npm run publish:public`
- Dry run: `DRY_RUN=true npm run publish:public`

Required env vars:

- `PUBLIC_REMOTE` (default: `public`)
- `PUBLIC_REPO` (e.g. `EvoMap/evolver`)
- `PUBLIC_OUT_DIR` (default: `dist-public`)
- `PUBLIC_USE_BUILD_OUTPUT` (default: `true`)

Optional env vars:

- `SOURCE_BRANCH` (default: `main`)
- `PUBLIC_BRANCH` (default: `main`)
- `RELEASE_TAG` (e.g. `v1.0.41`)
- `RELEASE_TITLE` (e.g. `v1.0.41 - GEP protocol`)
- `RELEASE_NOTES` or `RELEASE_NOTES_FILE`
- `GITHUB_TOKEN` (or `GH_TOKEN` / `GITHUB_PAT`) for GitHub Release creation
- `RELEASE_SKIP` (`true` to skip creating a GitHub Release; default is to create)
- `RELEASE_USE_GH` (`true` to use `gh` CLI instead of GitHub API)
- `PUBLIC_RELEASE_ONLY` (`true` to only create a Release for an existing tag; no publish)

## Versioning (SemVer)

MAJOR.MINOR.PATCH

- MAJOR: incompatible changes
- MINOR: backward-compatible features
- PATCH: backward-compatible bug fixes

## Changelog

See the full release history on [GitHub Releases](https://github.com/EvoMap/evolver/releases).

## FAQ

**Does this edit code automatically?**
No. Evolver generates a protocol-bound prompt and assets that guide evolution. It does not modify your source code directly. See [What Evolver Does (and Does Not Do)](#what-evolver-does-and-does-not-do).

**I ran `evolver --loop` but it just keeps printing text. Is it working?**
Yes. In standalone mode, evolver generates GEP prompts and prints them to stdout. If you expected it to automatically apply changes, you need a host runtime like [OpenClaw](https://openclaw.com) that interprets the output. Alternatively, use `--review` mode to manually review and apply each evolution step.

**Do I need to connect to EvoMap Hub?**
No. All core evolution features work offline. Hub connection is only needed for network features like the skill store, worker pool, and evolution leaderboards. See [Connecting to EvoMap Hub](#connecting-to-evomap-hub).

**Do I need to use all GEP assets?**
No. You can start with default Genes and extend over time.

**Is this safe in production?**
Use review mode and validation steps. Treat it as a safety-focused evolution tool, not a live patcher. See [Security Model](#security-model).

**Where should I clone this repo?**
Clone it into any directory you like. If you use [OpenClaw](https://openclaw.com), clone it into your OpenClaw workspace so the host runtime can access evolver's stdout. For standalone use, any location works.

## Roadmap

- Add a one-minute demo workflow
- Add a comparison table vs alternatives

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=EvoMap/evolver&type=Date)](https://star-history.com/#EvoMap/evolver&Date)

## Acknowledgments

- [onthebigtree](https://github.com/onthebigtree) -- Inspired the creation of evomap evolution network. Fixed three runtime and logic bugs (PR [#25](https://github.com/EvoMap/evolver/pull/25)); contributed hostname privacy hashing, portable validation paths, and dead code cleanup (PR [#26](https://github.com/EvoMap/evolver/pull/26)).
- [lichunr](https://github.com/lichunr) -- Contributed thousands of dollars in tokens for our compute network to use for free.
- [shinjiyu](https://github.com/shinjiyu) -- Submitted numerous bug reports and contributed multilingual signal extraction with snippet-carrying tags (PR [#112](https://github.com/EvoMap/evolver/pull/112)).
- [voidborne-d](https://github.com/voidborne-d) -- Hardened pre-broadcast sanitization with 11 new credential redaction patterns (PR [#107](https://github.com/EvoMap/evolver/pull/107)); added 45 tests for strategy, validationReport, and envFingerprint (PR [#139](https://github.com/EvoMap/evolver/pull/139)).
- [blackdogcat](https://github.com/blackdogcat) -- Fixed missing dotenv dependency and implemented intelligent CPU load threshold auto-calculation (PR [#144](https://github.com/EvoMap/evolver/pull/144)).
- [LKCY33](https://github.com/LKCY33) -- Fixed .env loading path and directory permissions (PR [#21](https://github.com/EvoMap/evolver/pull/21)).
- [hendrixAIDev](https://github.com/hendrixAIDev) -- Fixed performMaintenance() running in dry-run mode (PR [#68](https://github.com/EvoMap/evolver/pull/68)).
- [toller892](https://github.com/toller892) -- Independently identified and reported the events.jsonl forbidden_paths bug (PR [#149](https://github.com/EvoMap/evolver/pull/149)).
- [WeZZard](https://github.com/WeZZard) -- Added A2A_NODE_ID setup guide to SKILL.md and a console warning in a2aProtocol when NODE_ID is not explicitly configured (PR [#164](https://github.com/EvoMap/evolver/pull/164)).
- [Golden-Koi](https://github.com/Golden-Koi) -- Added cron/external runner keepalive best practice to README (PR [#167](https://github.com/EvoMap/evolver/pull/167)).
- [upbit](https://github.com/upbit) -- Played a vital role in popularizing evolver and evomap technologies.
- [Chi Jianqiang](https://mowen.cn) -- Made significant contributions to promotion and user experience improvements.

## License

[MIT](https://opensource.org/licenses/MIT)

> Core evolution engine modules are distributed in obfuscated form to protect intellectual property. Source: [EvoMap/evolver](https://github.com/EvoMap/evolver).
