/**
 * canonicalize 黄金向量 (M3-0). asset_id = SHA256(canonicalize(asset 去 asset_id)) 是跨 Go/JS/Rust
 * 逐字节一致的命门; 任何实现必须复现下列 canonical 字节, 否则互相 reject 资产 (硬化 A5).
 *
 * 三陷阱(必须照 JS 语义实现, 非各语言原生):
 *  1. number = JS Number→String 最短往返 (1.0→"1", 1e21→"1e+21", -0→"0", 非有限→"null").
 *  2. string = JSON.stringify, **不转义 HTML** (`<`/`>`/`&`/`/` 原样). Go 必须 json Encoder.SetEscapeHTML(false).
 *  3. object 键排序 = **UTF-16 码元序** (JS Array.sort 默认), 非 UTF-8 字节/码点序.
 *     非 BMP 字符(emoji)按 surrogate 首单元 0xD800–0xDBFF 排, 排在 U+E000–U+FFFF 之前 — 见 key-order-divergent.
 */
export interface CanonicalVector {
    name: string;
    input: unknown;
    canonical: string;
}
export declare const CANONICAL_VECTORS: readonly CanonicalVector[];
/** asset_id 黄金: 固定资产 → 固定 sha256. excludeFields 默认 ['asset_id']. */
export interface AssetIdVector {
    name: string;
    asset: Record<string, unknown>;
    assetId: string;
}
export declare const ASSET_ID_VECTORS: readonly AssetIdVector[];