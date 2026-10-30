import { exec as execCore } from '@evomap/evolver-core';
import { type ProxyStopSignalSource } from './proxyStopSignal.js';
export declare function recoverTriggerFeedbackBeforeHub(feedback: execCore.TriggerFeedbackLocalFacade | undefined, options?: {
    signals?: ProxyStopSignalSource;
    logger?: {
        write(message: string): unknown;
    };
}): Promise<void>;