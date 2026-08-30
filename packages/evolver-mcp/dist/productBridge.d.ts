export declare const PRODUCT_BRIDGE_SERVER_ID = "evox-product";
export declare const PRODUCT_BRIDGE_MANAGED_KEY = "_evox_product_managed";
export declare const PRODUCT_BRIDGE_PREVIOUS_KEY = "_evox_product_previous";
export declare const PRODUCT_BRIDGE_GRANT_SCHEMA = "evox.product_bridge.grant.v1";
/** Resolve only a compiled JavaScript shim. Source TypeScript is never written into runtime config. */
export declare function productBridgeShimPath(): string;
/** Ownership is explicit. A matching filename alone is never enough to delete a user's server. */
export declare function isOwnedProductBridge(entry: unknown): boolean;
/** Restore a user entry previously preserved by an explicit force takeover. */
export declare function restoreProductBridgeEntry(entry: unknown): {
    restored: boolean;
    entry?: unknown;
};
/** Merge a managed evox-product server into a parsed MCP JSON object (project .mcp.json or ~/.claude.json). */
export declare function withClaudeProductBridge(data: Record<string, unknown>, force?: boolean): {
    changed: boolean;
    skipped?: boolean;
    data: Record<string, unknown>;
};
/** Merge a managed evox-product table into parsed Codex TOML. */
export declare function withCodexProductBridge(data: Record<string, unknown>, force?: boolean): {
    changed: boolean;
    skipped?: boolean;
    data: Record<string, unknown>;
};
export declare function installClaudeProductBridge(configRoot: string, force?: boolean): {
    changed: boolean;
    skipped?: boolean;
    path: string;
};
export declare function uninstallClaudeProductBridge(configRoot: string): boolean;
export declare function installCodexProductBridge(configRoot: string, force?: boolean): {
    changed: boolean;
    skipped?: boolean;
    path: string;
};
export declare function uninstallCodexProductBridge(configRoot: string): boolean;