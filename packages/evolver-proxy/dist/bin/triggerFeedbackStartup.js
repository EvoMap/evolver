import { exec as execCore } from '@evomap/evolver-core';
import { proxyStopSignal } from './proxyStopSignal.js';
export async function recoverTriggerFeedbackBeforeHub(feedback, options = {}) {
    if (!feedback?.recover)
        return;
    const stop = proxyStopSignal(options.signals);
    const logger = options.logger ?? process.stderr;
    try {
        const result = await feedback.recover(stop.signal);
        if (stop.signal.aborted)
            throw new Error('trigger_feedback_startup_cancelled');
        if (result['ok'] !== true)
            logger.write('[evolver-proxy] trigger feedback startup recovery is pending or unavailable\n');
    }
    catch {
        if (stop.signal.aborted)
            throw new Error('trigger_feedback_startup_cancelled');
        logger.write('[evolver-proxy] trigger feedback startup recovery is pending or unavailable\n');
    }
    finally {
        stop.close();
    }
}