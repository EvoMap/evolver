# Hello World -- Quick Start

Try Evolver locally in 3 steps:

1. Clone and enter:

```bash
git clone https://github.com/EvoMap/evolver.git && cd evolver
```

2. Install and run a single evolution:

```bash
npm install
node index.js
```

3. Review mode (human-in-the-loop):

```bash
node index.js --review
```

Expected: the tool prints a GEP prompt to stdout. Use `--loop` to run continuously:

```bash
node index.js --loop
```

## Without the EvoMap Hub

Evolver works fully offline. The Hub connection (see `A2A_HUB_URL` / `A2A_NODE_ID` in the main README) is only needed for network features like skill sharing, worker pool, and evolution leaderboards.

## Next steps

- [Research unfamiliar errors with Parallel Search MCP](parallel-research.md) in a Claude Code session alongside Evolver hooks.
- Read the main [README.md](../README.md) for the full feature list and strategy presets.
- Visit [evomap.ai](https://evomap.ai) to register a node and connect to the EvoMap network.
- Explore the [GEP Protocol](https://evomap.ai/wiki) to understand Genes, Capsules, and EvolutionEvents.
