import type { assetstore } from '@evomap/evolver-core';
/** A recall context is forwarded whole when it is a plain JSON object of bounded size; anything else is dropped. */
export declare function recallContextOf(value: unknown): assetstore.RecallContext | undefined;