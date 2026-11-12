import { type JsonCommandIo } from './jsonCommand.js';
/**
 * `evolver publish-policy get|set --json`. In `manual` the Proxy's background curation still promotes trial Genes but
 * never enqueues a publish; the policy lives with this node's asset store and the Proxy rereads it every pass.
 */
export declare function runPublishPolicyCommand(argv: string[], io?: JsonCommandIo): Promise<number>;