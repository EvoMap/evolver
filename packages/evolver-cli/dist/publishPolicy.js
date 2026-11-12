import { assetstore, events } from '@evomap/evolver-core';
import { SMALL_REQUEST_BYTES, operationOf, readJsonRequest, requestLocale, requiredEnum, runJsonCommand } from './jsonCommand.js';
const PUBLISH_POLICY_COMMAND_SCHEMA = 'evolver.publish-policy.v1';
/**
 * `evolver publish-policy get|set --json`. In `manual` the Proxy's background curation still promotes trial Genes but
 * never enqueues a publish; the policy lives with this node's asset store and the Proxy rereads it every pass.
 */
export async function runPublishPolicyCommand(argv, io = {}) {
    const { operation, error } = operationOf(argv, ['get', 'set'], io);
    return runJsonCommand(PUBLISH_POLICY_COMMAND_SCHEMA, operation, io, async () => {
        if (error)
            throw error;
        const dir = events.assetsDir(io.env ?? process.env);
        if (operation === 'get')
            return assetstore.readPublishPolicy(dir);
        const request = await readJsonRequest(SMALL_REQUEST_BYTES, io);
        return assetstore.writePublishPolicy(dir, requiredEnum(request, 'mode', assetstore.PUBLISH_MODES, requestLocale(request, io)));
    });
}