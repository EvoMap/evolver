import type { ConversationDistillInput, ConversationDistillOptions, ConversationDistillResult, PortabilityCheck } from './conversationDistiller.js';
import { type CompiledSessionGene } from './sessionGeneIr.js';
/** A plugin's session IR, compiled into the fields the conversation distiller already turns into a Gene. */
export interface SessionGeneRequest {
    input: ConversationDistillInput;
    opts: ConversationDistillOptions;
    compiled: CompiledSessionGene;
    portability: PortabilityCheck;
    metrics: Record<string, number>;
}
/** The compiled request, why the IR cannot become a Gene, or undefined for a request that carries no IR. */
export declare function sessionGeneRequest(input: ConversationDistillInput, opts: ConversationDistillOptions): SessionGeneRequest | {
    rejection: ConversationDistillResult;
} | undefined;
/** The free-form request's own diff still marks what only its project has. */
export declare function freeFormProvenance(input: ConversationDistillInput): PortabilityCheck['provenance'];