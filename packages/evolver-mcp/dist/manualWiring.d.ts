import type { McpServerCmd, SetupRuntime } from './injection.js';
export interface ManualWiringContext {
    /** The evolver MCP stdio server launch command — the SAME one the installed runtimes register. Its `env` may
     *  carry an `EVOLVER_ENV_FILE` pointer (when the operator passed --env-file); no secrets ever live here. */
    server: McpServerCmd;
    /** Adapter-supplied wiring lines (e.g. the PrivateHub HTTP/A2A endpoint for http-agent). v2 prints them
     *  verbatim and never hardcodes hub policy itself. */
    hints?: readonly string[];
}
/**
 * Render the manual wiring instructions for a `manual`-class runtime. Returns a multi-line, copy-pasteable block.
 * Pure given its inputs. The caller (setup-hooks) only invokes this when runtimeSupport(...) === 'manual'.
 */
export declare function renderManualWiring(runtime: SetupRuntime, ctx: ManualWiringContext): string;