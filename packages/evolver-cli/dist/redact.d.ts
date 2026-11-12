import { type JsonCommandIo } from './jsonCommand.js';
/** `evolver redact --json`: what would be removed from each text before it leaves this machine, with exact offsets. Read-only. */
export declare function runRedactCommand(argv: string[], io?: JsonCommandIo): Promise<number>;