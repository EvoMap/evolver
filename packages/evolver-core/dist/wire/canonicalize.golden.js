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
export const CANONICAL_VECTORS = [
    { name: 'null', input: null, canonical: 'null' },
    { name: 'bool-true', input: true, canonical: 'true' },
    { name: 'int', input: 42, canonical: '42' },
    { name: 'float', input: 0.1, canonical: '0.1' },
    { name: 'float-trailing-zero', input: 1.0, canonical: '1' }, // 陷阱1: 无 ".0"
    { name: 'big-exp', input: 1e21, canonical: '1e+21' }, // 陷阱1: 指数形式
    { name: 'neg-zero', input: -0, canonical: '0' }, // 陷阱1: -0→"0"
    { name: 'str-basic', input: 'hello', canonical: '"hello"' },
    { name: 'str-html', input: 'a<b>&"/', canonical: '"a<b>&\\"/"' }, // 陷阱2: HTML 不转义, 仅 \" 转义
    { name: 'str-unicode', input: '认证 \u{1F9EC}', canonical: '"认证 \u{1F9EC}"' },
    { name: 'empty-array', input: [], canonical: '[]' },
    { name: 'empty-object', input: {}, canonical: '{}' },
    { name: 'nested', input: { b: 2, a: [1, { z: 'x', a: null }] }, canonical: '{"a":[1,{"a":null,"z":"x"}],"b":2}' },
    // 陷阱3: 键 UTF-16 序 — 'a'(0x61) < emoji(surrogate 0xD83E) < U+F8FF(0xF8FF). 码点序会把 emoji 排最后.
    { name: 'key-order-divergent', input: { a: 3, '\u{1F9EC}': 2, '': 1 }, canonical: '{"a":3,"\u{1F9EC}":2,"":1}' },
];
export const ASSET_ID_VECTORS = [
    {
        name: 'gene',
        asset: {
            type: 'Gene', schema_version: '1.11.0', id: 'gene-1', category: 'repair',
            signals_match: ['auth', '401'], strategy: ['s1'], constraints: { max_files: 3, forbidden_paths: [] },
            validation: ['v'], asset_id: 'IGNORED',
        },
        assetId: 'sha256:402ea1911984bd7b24ffa3faf18c5679cdb5f0c5215700cbdd1519705f9b9453',
    },
    {
        name: 'capsule',
        asset: {
            type: 'Capsule', schema_version: '1.11.0', id: 'cap-1', trigger: ['t'], gene: 'gene-1', summary: 's',
            confidence: 0.9, blast_radius: { files: 1, lines: 10 }, outcome: { status: 'success', score: 0.8 }, asset_id: 'IGNORED',
        },
        assetId: 'sha256:fa352d440ace8505f4e06d6cf9d215c9b03b9799cd34f0afb6eec18a5878ee60',
    },
];