---
name: capability-evolver
description: A self-evolution engine for AI agents. Analyzes runtime history to identify improvements and applies protocol-constrained evolution.
tags: [meta, ai, self-improvement, core]
---

# 🧬 Capability Evolver

**"Evolution is not optional. Adapt or die."**

The **Capability Evolver** is a meta-skill that allows OpenClaw agents to inspect their own runtime history, identify failures or inefficiencies, and autonomously write new code or update their own memory to improve performance.

## Features

- **Auto-Log Analysis**: Automatically scans memory and history files for errors and patterns.
- **Self-Repair**: Detects crashes and suggests patches.
- GEP Protocol: Standardized evolution with reusable assets.
- **One-Command Evolution**: Just run `/evolve` (or `node index.js`).

## Usage

### Standard Run (Automated)
Runs the evolution cycle. If no flags are provided, it assumes fully automated mode (Mad Dog Mode) and executes changes immediately.
```bash
node index.js
```

### Review Mode (Human-in-the-Loop)
If you want to review changes before they are applied, pass the `--review` flag. The agent will pause and ask for confirmation.
```bash
node index.js --review
```

### Mad Dog Mode (Continuous Loop)
To run in an infinite loop (e.g., via cron or background process), use the `--loop` flag or just standard execution in a cron job.
```bash
node index.js --loop
```

## Setup

Before using this skill, register your node identity with the EvoMap network:

1. Run the hello flow (via `evomap.js` or the EvoMap onboarding) to receive a `node_id` and claim code
2. Visit `https://evomap.ai/claim/<claim-code>` within 24 hours to bind the node to your account
3. Set the node identity in your environment:

```bash
export A2A_NODE_ID=node_xxxxxxxxxxxx
```

Or in your agent config (e.g., `~/.openclaw/openclaw.json`):

```json
{ "env": { "A2A_NODE_ID": "node_xxxxxxxxxxxx" } }
```

Do not hardcode the node ID in scripts. `getNodeId()` in `src/gep/a2aProtocol.js` reads `A2A_NODE_ID` automatically -- any script using the protocol layer will pick it up without extra configuration.

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `A2A_NODE_ID` | (required) | Your EvoMap node identity. Set this after node registration -- never hardcode it in scripts. Read automatically by `getNodeId()` in `a2aProtocol.js`. |
| `EVOLVE_ALLOW_SELF_MODIFY` | `false` | Allow evolution to modify evolver's own source code. **NOT recommended for production.** Enabling this can cause instability -- the evolver may introduce bugs into its own prompt generation, validation, or solidify logic, leading to cascading failures that require manual intervention. Only enable for controlled experiments. |
| `EVOLVE_LOAD_MAX` | `2.0` | Maximum 1-minute load average before evolver backs off. |
| `EVOLVE_STRATEGY` | `balanced` | Evolution strategy: `balanced`, `innovate`, `harden`, `repair-only`, `early-stabilize`, `steady-state`, or `auto`. |

## GEP Protocol (Auditable Evolution)

This package embeds a protocol-constrained evolution prompt (GEP) and a local, structured asset store:

- `assets/gep/genes.json`: reusable Gene definitions
- `assets/gep/capsules.json`: success capsules to avoid repeating reasoning
- `assets/gep/events.jsonl`: append-only evolution events (tree-like via parent id)
 
## Emoji Policy

Only the DNA emoji is allowed in documentation. All other emoji are disallowed.

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

## Safety & Risk Protocol

### 1. Identity & Directives
- **Identity Injection**: "You are a Recursive Self-Improving System."
- **Mutation Directive**: 
  - If **Errors Found** -> **Repair Mode** (Fix bugs).
  - If **Stable** -> **Forced Optimization** (Refactor/Innovate).

### 2. Risk Mitigation
- **Infinite Recursion**: Strict single-process logic.
- **Review Mode**: Use `--review` for sensitive environments.
- **Git Sync**: Always recommended to have a git-sync cron job running alongside this skill.

## Before Troubleshooting -- Check Your Version First

If you encounter unexpected errors or behavior, **always verify your version before debugging**:

```bash
node -e "const p=require('./package.json'); console.log(p.version)"
```

If you are not on the latest release, update first -- most reported issues are already fixed in newer versions:

```bash
# If installed via git
git pull && npm install

# If installed via npm (global install)
npm install -g evolver@latest
```

Latest releases and changelog: `https://github.com/autogame-17/evolver/releases`

## License
MIT
