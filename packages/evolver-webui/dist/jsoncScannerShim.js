// jsonc-parser's main entry is a UMD wrapper whose shadowed `require` leaves
// './impl/format' unresolved inside bun standalone binaries, and its ESM entry
// uses extensionless imports that Node ESM rejects. Depend on the scanner impl
// directly: it has no sibling dependencies, so bundlers can inline it safely.
// Use a default import because the impl is CommonJS and named CJS exports are
// not reliably detected by Node's ESM loader. The explicit JsoncScanner type
// keeps the emitted .d.ts self-contained so consumers never resolve the deep
// specifier.
import scannerImpl from 'jsonc-parser/lib/umd/impl/scanner.js';
export const createScanner = scannerImpl.createScanner;