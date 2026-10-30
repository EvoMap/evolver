/**
 * A feedback delivery may be replayed after its local append was committed but before the
 * writer received an acknowledgement. Count that delivery once. If the same operation ID
 * names conflicting facts, count neither: arrival order must not decide whether an asset
 * receives a positive or negative signal.
 *
 * Historical autoexec fetch-time hits had a recognizable cycle prefix but no
 * application binding. They were not terminal reuse evidence and are excluded
 * from projections without rewriting the append-only audit log. Other legacy
 * (including MCP result) events retain their existing counting semantics.
 */
import { type ReferenceScope } from '../reference/guard.js';
export declare function hasReusePayload<T extends {
    payload?: unknown;
}>(event: T): event is T & {
    payload: Record<string, unknown>;
};
export declare function uniqueReuseFactSteps<T extends {
    type: string;
    payload?: unknown;
}>(events: readonly T[], scope?: ReferenceScope): Generator<void, T[]>;
export declare function uniqueReuseFacts<T extends {
    type: string;
    payload?: unknown;
}>(events: readonly T[], scope?: ReferenceScope): T[];