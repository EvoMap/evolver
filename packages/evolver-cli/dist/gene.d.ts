import { type JsonCommandIo } from './jsonCommand.js';
/** `evolver gene <operation> --json`: author, check and distill Genes locally. Nothing is stored, published or sent to a model. */
export declare function runGeneCommand(argv: string[], io?: JsonCommandIo): Promise<number>;