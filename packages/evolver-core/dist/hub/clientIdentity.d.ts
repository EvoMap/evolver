/**
 * Which host agent and plugin drive this evolver, as they declare it: request headers on the Proxy, environment
 * variables on a process they start. Self-declared and unauthenticated, so it is attribution, never authorization.
 */
export interface ClientIdentity {
    readonly agent: string;
    readonly agent_version?: string;
    readonly plugin: string;
    readonly plugin_version?: string;
}
export interface SeenClient extends ClientIdentity {
    readonly last_seen: string;
}
export declare const CLIENT_HEADERS: Readonly<{
    agent: "x-evomap-client-agent";
    agentVersion: "x-evomap-client-agent-version";
    plugin: "x-evomap-client-plugin";
    pluginVersion: "x-evomap-client-plugin-version";
}>;
export declare const CLIENT_ENV: Readonly<{
    agent: "EVOLVER_CLIENT_AGENT";
    agentVersion: "EVOLVER_CLIENT_AGENT_VERSION";
    plugin: "EVOLVER_CLIENT_PLUGIN";
    pluginVersion: "EVOLVER_CLIENT_PLUGIN_VERSION";
}>;
/** The identity a value carries in wire shape (`{agent, agent_version, plugin, plugin_version}`), or undefined. */
export declare function clientIdentityOf(value: unknown): ClientIdentity | undefined;
/** The identity a Proxy request declares in its `x-evomap-client-*` headers (Node lower-cases header names). */
export declare function clientIdentityFromHeaders(headers: Readonly<Record<string, string | readonly string[] | undefined>>): ClientIdentity | undefined;
/** The identity the process that started this one declared in `EVOLVER_CLIENT_*`. */
export declare function clientIdentityFromEnv(env: Readonly<Record<string, string | undefined>>): ClientIdentity | undefined;
/**
 * The clients a long-lived Proxy served lately, most recent first and at most MAX_SEEN_CLIENTS: one Proxy serves
 * every host agent on the machine, so hello and heartbeat report the set rather than one caller.
 */
export declare class RecentClients {
    private readonly now;
    private seen;
    constructor(now?: () => number);
    record(client: ClientIdentity | undefined): void;
    list(): readonly SeenClient[];
}
/** Runs `fn` on behalf of `client`, so the Hub calls it makes, through caches and resolvers, can name their caller. */
export declare function withRequestClient<T>(client: ClientIdentity | undefined, fn: () => T): T;
/** The client of the request being served, or undefined outside one. */
export declare function currentRequestClient(): ClientIdentity | undefined;