import type { AssetRecord } from '../assetstore/provider.js';
export declare function embeddedSourceTexts(asset: AssetRecord): string[];
export type EmbeddedSourceIntegrity = {
    ok: true;
} | {
    ok: false;
    reason: 'embedded_source_manifest_invalid' | 'embedded_source_hash_mismatch';
};
export declare function checkEmbeddedSourceIntegrity(asset: AssetRecord): EmbeddedSourceIntegrity;
/** No source exemption: scan assembled files once, including matches across fragment boundaries. */
export declare function sanitizeEmbeddedSourceContent(content: unknown, redact: (value: unknown) => unknown, withheld: string, redactSource?: (text: string) => unknown): unknown;