import { type PluginRuntime } from './pluginRuntime.js';
export declare const PLUGIN_USAGE = "Usage: evolver plugin list [--json]\n       evolver plugin install [--host <host>] [--scope user|project] [--root <dir>]\n                              [--profile <dsh-profile>] [--trust] [--dry-run] [--json]\n\nHosts: claude-code, codex, grok, qoder, antigravity, opencode, dsh,\n       cursor, workbuddy, mcp-generic\nDefault scope: user. dsh default profile: dsh-tui.\n--trust says you trust the plugin's hooks; only hosts that require it (grok) accept it.\nWith no host, only a single discovered native host is selected; otherwise choose --host.\nCursor, WorkBuddy and generic MCP return manual_required without writing client config.\nDry-run performs no download, host command or config write and proves no installed state.\nInstallation uses EvoMap/evolver-agent-plugin and does not replace setup-hooks.\nExit codes: 0 verified install/already-installed/list/preview; 2 action required\n(including trust_required and profile_store_mismatch); 1 conflict or failure.\n";
export interface PluginCommandDeps {
    runtime?: PluginRuntime;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
}
export declare function runPluginCommand(argv: readonly string[], deps?: PluginCommandDeps): Promise<number>;