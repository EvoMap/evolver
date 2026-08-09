export interface ClaimNudgeHelloResult {
    ok: boolean;
    claimCode?: string;
    claimUrl?: string;
}
export interface ClaimNudgeStateStore {
    getState(key: string): string | undefined;
    setState(key: string, value: string): void;
}
export interface ClaimNudgeOptions {
    store: ClaimNudgeStateStore;
    hubUrl: string;
    env?: Readonly<Record<string, string | undefined>>;
    now?: () => number;
    write?: (text: string) => void;
}
export type ClaimNudge = (result: ClaimNudgeHelloResult) => boolean;
export declare function createClaimNudge(options: ClaimNudgeOptions): ClaimNudge;
export declare function wrapHelloWithClaimNudge<T extends ClaimNudgeHelloResult, O>(hello: (options: O) => Promise<T>, nudge: ClaimNudge): (options: O) => Promise<T>;
export declare function claimNudgeCooldownMs(raw: string | undefined): number;