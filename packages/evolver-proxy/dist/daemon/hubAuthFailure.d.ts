import type { mailbox } from '@evomap/evolver-core';
export declare const HUB_AUTH_STATUS_STATE_KEY = "hub:auth_status";
export declare const HUB_AUTH_FAILED = "auth_failed";
export declare function captureHubAuthRecoveryState(store: mailbox.MailboxStore): () => boolean;
export declare function isSupersededHubAuthFailure(error: unknown): boolean;
export declare function recordHubAuthFailure(store: mailbox.MailboxStore, error: unknown, message: string): boolean;
export declare function writeForCurrentHubAuthFailure(store: mailbox.MailboxStore, error: unknown, write: () => void): boolean;