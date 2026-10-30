import { type SpawnCaptureOptions, type SpawnCaptureResult } from './runnerRegistry.js';
export interface TriggerFeedbackLocalFacade {
    invoke(action: 'sync' | 'get', runId: string, remote?: boolean): Promise<Record<string, unknown>>;
    recover?(signal?: AbortSignal): Promise<Record<string, unknown>>;
}
export declare function triggerFeedbackScopeEnv(env: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv | undefined;
export declare function createTriggerFeedbackLocalFacade(env: Readonly<NodeJS.ProcessEnv>, options?: {
    resolveDispatch?: () => string;
    capture?: (command: string, args: readonly string[], options: SpawnCaptureOptions) => Promise<SpawnCaptureResult>;
    now?: () => number;
}): TriggerFeedbackLocalFacade | undefined;