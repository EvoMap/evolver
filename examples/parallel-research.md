# Research errors with Parallel Search MCP

When an unfamiliar error appears in an Evolver-assisted Claude Code session,
use current upstream documentation and issue reports to check a repair idea.
[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
provides web search and page fetching without an account or API key. Anonymous
search uses Fast mode and is rate limited.

This guide adds research tools to the **Claude Code host session**. Evolver's
hooks continue to load evolution memory, detect signals and record outcomes;
Evolver itself does not call this MCP server. Its offline workflow and the
Evolver skill's network permissions stay unchanged.

## Prerequisites

- Evolver installed and Claude Code hooks configured using the
  [runtime setup guide](../README.md#4-wire-up-your-agent-runtime-optional).
- [Claude Code](https://code.claude.com/docs/en/overview) installed and signed in.
- A project you can open in Claude Code, with network access to
  `https://search.parallel.ai/mcp`.

## Add the research tools

Run these commands from your project directory:

```bash
claude mcp add --transport http --scope local evolver-parallel-search \
  https://search.parallel.ai/mcp \
  --header "User-Agent: evolver-research-guide/1.0"
claude mcp get evolver-parallel-search
```

The saved entry should show HTTP transport and the URL above. Local scope stores
it privately for this project in `~/.claude.json`; it does not add a shared
`.mcp.json`. If that server name is already configured, inspect it before making
changes. Keep any existing server and provider choices you want to use.

Start a new `claude` session in the same directory. Run `/mcp`, confirm
`evolver-parallel-search` is connected, and inspect its `web_search` and
`web_fetch` tools. The anonymous endpoint does not need an Authorization header
or an OAuth sign-in. See [Claude Code's MCP guide](https://code.claude.com/docs/en/mcp)
if your environment restricts MCP servers or outbound connections.

## Research before choosing a repair

For example, if a Windows subprocess fails with `spawn EINVAL`, give Claude the
actual Node version and a redacted error, then ask:

```text
Use evolver-parallel-search to investigate Node.js spawn EINVAL on Windows
when launching npm .cmd shims. Search current Node.js documentation and upstream
issue reports, then fetch the most relevant pages. Check whether the findings
apply to my Node version and launcher. Summarize the cause, source URLs and
remaining uncertainty, and propose a focused regression check before editing.
Do not send credentials, private code or raw session logs to the search service.
```

Look for source URLs in the search result and a summary grounded in the fetched
pages. Review version-specific advice against your local reproduction before
applying a change. Evolver's existing
[child-process convention](../CONTRIBUTING.md#engineering-conventions) is also
relevant to this example.

Search queries and fetched URLs go to Parallel, so use only information you
intend to send to an external service. If the service reports a quota limit,
follow its retry guidance or continue the local investigation without web tools.

## Remove the optional server

From the same project directory:

```bash
claude mcp remove --scope local evolver-parallel-search
```

This removes the research server entry; Evolver hooks remain installed.
