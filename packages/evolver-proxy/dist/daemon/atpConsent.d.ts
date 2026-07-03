export type AtpConsentSource = 'env' | 'ack' | 'default';
export interface AtpOrderConsentGate {
    assertAllowed(): void;
}
export declare class AtpProxySpendConsentError extends Error {
    readonly source: AtpConsentSource;
    constructor(source: AtpConsentSource);
}
export declare function getAtpProxyConsent(env?: Record<string, string | undefined>, ackPath?: string): {
    enabled: boolean;
    source: AtpConsentSource;
};
export declare function createAtpOrderConsentGate(env?: Record<string, string | undefined>, ackPath?: string): AtpOrderConsentGate;