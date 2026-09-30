import { verify } from '@evomap/evolver-core';
import type { MaterialCycleOptions } from './cycleConsumer.js';
/** Read the operator's acceptance plan once, before any material is claimed or model dispatched. */
export declare function readCycleValidationSpec(path: string): verify.DeclarativeValidationSpec;
/** The LLM file executor is opt-in and never converts a script validation plan into a weaker check. */
export declare function prepareLlmCycle(options: MaterialCycleOptions): MaterialCycleOptions;