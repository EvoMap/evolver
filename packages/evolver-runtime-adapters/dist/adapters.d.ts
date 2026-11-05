import { type SessionLogAdapter } from './types.js';
export declare const claudeCodeAdapter: SessionLogAdapter;
export declare const cursorAdapter: SessionLogAdapter;
export declare const codexAdapter: SessionLogAdapter;
export declare const geminiAdapter: SessionLogAdapter;
export declare const antigravityAdapter: SessionLogAdapter;
export declare const genericChatAdapter: SessionLogAdapter;
export declare const kimiAdapter: SessionLogAdapter;
export declare const kiroRemovedAdapter: SessionLogAdapter;
export declare const opencodeRemovedAdapter: SessionLogAdapter;
/** Explicitly removed transcript adapters — path fail-closed only. Never walk this list for content probes. */
export declare const REMOVED_ADAPTERS: readonly SessionLogAdapter[];
export declare const ADAPTERS: readonly SessionLogAdapter[];
export declare function adapterForPath(path: string): SessionLogAdapter | undefined;
/** Read a session log as the text its adapter parses; plain JSONL hosts are UTF-8, others decode their bytes. */
export declare function readSessionLog(path: string): string;
/** True when the agent id has an explicit removed transcript sentinel (see REMOVED_ADAPTERS). */
export declare function isRemovedAdapter(agent: string): boolean;