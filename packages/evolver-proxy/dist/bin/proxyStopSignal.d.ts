export interface ProxyStopSignalSource {
    on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}
export declare function proxyStopSignal(source?: ProxyStopSignalSource): {
    signal: AbortSignal;
    close(): void;
};