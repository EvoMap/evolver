# 🧬 Capability Evolver

![Capability Evolver Cover](assets/cover.png)

[Chinese Docs](README.zh-CN.md)

**"Evolution is not optional. Adapt or die."**

**Three lines**
- **What it is**: A protocol-constrained self-evolution engine for AI agents.
- **Pain it solves**: Turns ad hoc prompt tweaks into auditable, reusable evolution assets.
- **Use in 30 seconds**: `node index.js` to generate a GEP-guided evolution prompt.

Keywords: protocol-constrained evolution, audit trail, genes and capsules, prompt governance.

## Try It Now (Minimal)

```bash
node index.js
```

## What It Does

The **Capability Evolver** inspects runtime history, extracts signals, selects a Gene/Capsule, and emits a strict GEP protocol prompt to guide safe evolution.

## Who This Is For / Not For

**For**
- Teams maintaining agent prompts and logs at scale
- Users who need auditable evolution traces (Genes, Capsules, Events)
- Environments requiring deterministic, protocol-bound changes

**Not For**
- One-off scripts without logs or history
- Projects that require free-form creative changes
- Systems that cannot tolerate protocol overhead

## Features

- **Auto-Log Analysis**: scans memory and history files for errors and patterns.
- **Self-Repair Guidance**: emits repair-focused directives from signals.
- **GEP Protocol**: standardized evolution with reusable assets.
- **Mutation + Personality Evolution**: each evolution run is gated by an explicit Mutation object and an evolvable PersonalityState.
- **Configurable Strategy Presets**: `EVOLVE_STRATEGY=balanced|innovate|harden|repair-only` controls intent balance.
- **Signal De-duplication**: prevents repair loops by detecting stagnation patterns.
- **Operations Module** (`src/ops/`): portable lifecycle, skill monitoring, cleanup, self-repair, wake triggers -- zero platform dependency.
- **Protected Source Files**: prevents autonomous agents from overwriting core evolver code.
- **One-Command Evolution**: `node index.js` to generate the prompt.

## Typical Use Cases

- Harden a flaky agent loop by enforcing validation before edits
- Encode recurring fixes as reusable Genes and Capsules
- Produce auditable evolution events for review or compliance

## Anti-Examples

- Rewriting entire subsystems without signals or constraints
- Using the protocol as a generic task runner
- Producing changes without recording EvolutionEvent

## FAQ

**Does this edit code automatically?**
No. It generates a protocol-bound prompt and assets that guide evolution.

**Do I need to use all GEP assets?**
No. You can start with default Genes and extend over time.

**Is this safe in production?**
Use review mode and validation steps. Treat it as a safety-focused evolution tool, not a live patcher.

## Roadmap

- Add a one-minute demo workflow
- Add a public changelog
- Add a comparison table vs alternatives

## GEP Protocol (Auditable Evolution)

This repo includes a protocol-constrained prompt mode based on GEP (Genome Evolution Protocol).

- **Structured assets** live in `assets/gep/`:
  - `assets/gep/genes.json`
  - `assets/gep/capsules.json`
  - `assets/gep/events.jsonl`
- **Selector** logic uses extracted signals to prefer existing Genes/Capsules and emits a JSON selector decision in the prompt.
- **Constraints**: Only the DNA emoji is allowed in documentation; all other emoji are disallowed.

## Usage

### Standard Run (Automated)
```bash
node index.js
```

### Review Mode (Human-in-the-Loop)
```bash
node index.js --review
```

### Continuous Loop
```bash
node index.js --loop
```

### With Strategy Preset
```bash
EVOLVE_STRATEGY=innovate node index.js --loop   # maximize new features
EVOLVE_STRATEGY=harden node index.js --loop     # focus on stability
EVOLVE_STRATEGY=repair-only node index.js --loop # emergency fix mode
```

### Operations (Lifecycle Management)
```bash
node src/ops/lifecycle.js start    # start evolver loop in background
node src/ops/lifecycle.js stop     # graceful stop (SIGTERM -> SIGKILL)
node src/ops/lifecycle.js status   # show running state
node src/ops/lifecycle.js check    # health check + auto-restart if stagnant
```

## Public Release

This repository is the public distribution.

- Build public output: `npm run build`
- Publish public output: `npm run publish:public`
- Dry run: `DRY_RUN=true npm run publish:public`

Required env vars:

- `PUBLIC_REMOTE` (default: `public`)
- `PUBLIC_REPO` (e.g. `autogame-17/evolver`)
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

### v1.10.3
- **Configurable Blast Radius Policy**: `computeBlastRadius()` now separates runtime artifacts (logs, memory, capsules, events) from functional code. Only code/config files count toward `max_files` constraints. Policy is configurable via `openclaw.json` at `evolver.constraints.countedFilePolicy`.
- **Structured Status Output**: `solidify()` now generates a structured status payload (`result`, `en`, `zh`, `meta`) and writes it to a cycle status file, providing downstream reporters with rich evolution context (intent, gene, signals, blast radius, validation results).
- **Solidify CLI Observability**: `index.js solidify` prints `[SOLIDIFY_STATUS]` and `[SOLIDIFY_STATUS_FILE]` lines for wrapper integration.

### v1.10.1
- **Innovation Cooldown**: Track recent innovation targets in `analyzeRecentHistory()` and inject `Context [Innovation Cooldown]` into GEP prompt, preventing the Hand Agent from repeatedly innovating on the same skill/module across consecutive cycles.
- **Signal Enhancement**: `analyzeRecentHistory()` now returns `recentInnovationTargets` (map of target path to count in last 10 events).

### v1.10.0
- **Operations Module** (`src/ops/`): 6 portable modules extracted from environment-specific wrapper:
  - `lifecycle.js` -- process start/stop/restart/status/health check
  - `skills_monitor.js` -- skill health audit with auto-heal (npm install, SKILL.md stub)
  - `cleanup.js` -- GEP artifact disk cleanup
  - `trigger.js` -- wake signal mechanism
  - `commentary.js` -- persona-based cycle commentary
  - `self_repair.js` -- git emergency repair (abort rebase, remove stale locks)
- **Configurable Evolution Strategy** (`EVOLVE_STRATEGY` env var):
  - 4 presets: `balanced` (default 50/30/20), `innovate` (80/15/5), `harden` (20/40/40), `repair-only` (0/20/80)
  - Strategy-aware signal filtering with per-preset repair loop thresholds
  - Backward compatible: `FORCE_INNOVATION=true` maps to `innovate`
- **Signal De-duplication**: repair ratio check forces innovation when >= 50% of last 8 cycles are repairs (threshold varies by strategy).
- **Tool Usage Analytics**: detects high-frequency tool usage patterns in logs (auto-evolved by Hand Agent).
- **Protected Source Files** (GEP Section IX): evolver core .js files listed as immutable to prevent Hand Agent overwrites.
- **Forbidden Innovation Zones** (GEP Section X): prevents creation of skills that duplicate existing infrastructure (process management, health monitoring, scheduling).
- **Known Issues List** (GEP Section VII.6): tells the LLM to skip already-fixed errors.
- **Resilience**: replaced `process.exit(2)` with `throw Error()` for MemoryGraph failures (loop survives transient errors).
- **Gene Limits Relaxed**: repair max_files 12->20, innovate max_files 8->25.
- `paths.js`: added `getWorkspaceRoot()`, `getSkillsDir()`, `getLogsDir()`.

### v1.9.2
- Intermediate release with strategy presets and protected files.

### v1.9.1
- Signal de-duplication (repair ratio check).
- Singleton Guard (PID lock file).
- Environment fingerprint in GEP prompt.

### v1.6.0
- Add innovation/opportunity signal detection: user_feature_request, user_improvement_suggestion, perf_bottleneck, capability_gap, stable_success_plateau, external_opportunity.
- Add innovate Gene (gene_gep_innovate_from_opportunity) for proactive feature development.
- Auto-innovate mutation when opportunity signals are present (no longer requires --drift flag).
- Personality evolution now responds to opportunity signals by increasing creativity.
- Safety: repair still takes priority over innovate when errors are present.

### v1.5.1
- Add containerized vibe testing framework (Docker + node:22-bookworm, OpenClaw-compatible environment).
- 7 end-to-end tests: module load, dry-run solidify, schema compliance, A2A round-trip, full evolve+solidify, loop gating, env fingerprint.
- Add internal daemon loop with suicide guard for memory leak protection.
- One-command test: `npm run test:vibe`.

### v1.5.0
- Add content-addressable asset IDs (SHA-256 canonical hashing) for deduplication, tamper detection, and cross-node consistency.
- Add environment fingerprint capture (node version, platform, arch, evolver version) embedded in EvolutionEvents, Capsules, and ValidationReports.
- Add standardized ValidationReport type with machine-readable schema, full command results, and env fingerprint.
- Add GEP A2A protocol layer with 6 message types (hello/publish/fetch/report/decision/revoke) and pluggable transport interface.
- Add FileTransport as default A2A transport (JSONL outbox/inbox).
- Add asset_id integrity verification on A2A ingest; reject tampered assets.
- Add schema_version field to all GEP asset types (Gene, Capsule, EvolutionEvent, ValidationReport).
- Fix: dry-run mode no longer triggers rollback.
- Merge backport/online-fixes: self-contained crash recovery with recover_loop.js.

### v1.4.4
- Add validation command safety check: Gene validation commands are gated by prefix whitelist (node/npm/npx) and shell operator blocking.
- Add validation audit on A2A Gene promotion: external Genes with unsafe validation commands are rejected before promotion.
- Add Security Model documentation to README.

### v1.4.3
- Release preparation for v1.4.3.

### v1.4.2
- Add loop gating: do not start a new cycle until the previous run is solidified (prevents fast empty cycles).
- Preserve `last_solidify` when writing solidify state (merge instead of overwrite).

### v1.4.1
- Add execute-by-default bridge: after generating the GEP prompt, emit `sessions_spawn(...)` to spawn an executor agent.
- Write prompt artifacts to `memory/` for reliable handoff and auditing.

### v1.4.0
- Add explicit Mutation protocol (repair/optimize/innovate) and require Mutation per evolution run.
- Add evolvable PersonalityState with small PersonalityMutation steps and natural selection statistics.
- Extend EvolutionEvent with `mutation_id` and `personality_state`; record both into Memory Graph events.
- Add `scripts/gep_personality_report.js` to observe personality success rates and convergence.

### v1.3.1
- Release preparation for v1.3.1.

### v1.3.0
- Release preparation for v1.3.0.

### v1.2.0
- Memory Graph v2 and A2A exchange protocol integration.

### v1.1.0
- Public build/publish pipeline, prompt budget enforcement, and structured GEP asset storage.

## Security Model

This section describes the execution boundaries and trust model of the Capability Evolver.

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

## Configuration & Decoupling

This skill is designed to be **environment-agnostic**. It uses standard OpenClaw tools by default.

### Local Overrides (Injection)
You can inject local preferences (e.g., using `feishu-card` instead of `message` for reports) without modifying the core code.

**Method 1: Environment Variables**
Set `EVOLVE_REPORT_TOOL` in your `.env` file:
```bash
EVOLVE_REPORT_TOOL=feishu-card
```

**Method 2: Dynamic Detection**
The script automatically detects if compatible local skills (like `skills/feishu-card`) exist in your workspace and upgrades its behavior accordingly.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=autogame-17/evolver&type=Date)](https://star-history.com/#autogame-17/evolver&Date)

## Acknowledgments

- [onthebigtree](https://github.com/onthebigtree) -- Inspired the creation of evomap evolution network.
- [lichunr](https://github.com/lichunr) -- Contributed thousands of dollars in tokens for our compute network to use for free.
- [shinjiyu](https://github.com/shinjiyu) -- Submitted numerous bug reports for evolver and evomap.
- [upbit](https://github.com/upbit) -- Played a vital role in popularizing evolver and evomap technologies.
- More contributors to be added.

## License

MIT


