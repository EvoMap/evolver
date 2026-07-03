export declare const DEFAULT_UNHANDLED_REJECTION_WINDOW_MS: number;
export declare const DEFAULT_UNHANDLED_REJECTION_THRESHOLD = 5;
export type UnhandledRejectionListener = (reason: unknown, promise?: Promise<unknown>) => void;
export interface UnhandledRejectionProcess {
    on(event: 'unhandledRejection', listener: UnhandledRejectionListener): unknown;
    off?(event: 'unhandledRejection', listener: UnhandledRejectionListener): unknown;
    removeListener?(event: 'unhandledRejection', listener: UnhandledRejectionListener): unknown;
}
export interface UnhandledRejectionWindowOptions {
    windowMs?: number;
    threshold?: number;
    now?: () => number;
    write?: (line: string) => void;
    beforeExit?: () => void;
    exit?: (code: number) => void;
}
export interface InstallUnhandledRejectionWindowOptions extends UnhandledRejectionWindowOptions {
    process?: UnhandledRejectionProcess;
}
export declare function createUnhandledRejectionWindowHandler(options?: UnhandledRejectionWindowOptions): UnhandledRejectionListener;
export declare function installUnhandledRejectionWindow(options?: InstallUnhandledRejectionWindowOptions): () => void;