// Obfuscation-leak guard for self-PRs (ported from v1 src/gep/selfPR.js loadObfuscatedFromManifest /
// isPublicNonObfuscated, the `public.manifest.json` obfuscate slice). Some files ship OBFUSCATED on the public
// repo: a self-PR that touches one of those would land RAW SOURCE there, leaking implementation detail. This
// module reads `public.manifest.json`'s `obfuscate` array (literal string paths) and exposes a segment-aware
// membership check.
//
// FAIL-CLOSED (matches v1): when the manifest is MISSING / unreadable / invalid, loadObfuscatedFiles returns
// null and isObfuscatedFile treats EVERY file as obfuscated (rejects), so a missing manifest can never silently
// let a potentially-leaking file through. The manifest read is INJECTABLE so tests are hermetic and never depend
// on a real public.manifest.json on disk. Pure + injectable; the cache is resettable. Hub-agnostic (no economy).
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
/** Normalize a path for comparison: backslash→slash, strip leading `./`, trim. Mirrors v1 normalizeRel. */
export function normalizeManifestPath(filePath) {
    return String(filePath ?? '')
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .trim();
}
/** Default manifest reader: reads `<repoRoot>/public.manifest.json`, returning null on any failure. */
export function defaultReadManifest(repoRoot) {
    return () => {
        try {
            return readFileSync(joinPath(repoRoot, 'public.manifest.json'), 'utf8');
        }
        catch {
            return null;
        }
    };
}
const MANIFEST_TRANSIENT_RETRY_MS = 5 * 60 * 1000;
// Resettable cache keyed by the reader identity, so distinct readers (e.g. per test) don't bleed into each other.
// Success is cached permanently for the reader. Failures remain fail-closed, but transient reads retry for a
// short window before stabilizing to null for the process lifetime.
const cache = new WeakMap();
/** Test/maintenance hook: drop any cached load for a reader (or all readers) so the load path re-runs. */
export function resetObfuscatedCache(reader) {
    if (reader)
        cache.delete(reader);
    // A WeakMap can't be cleared wholesale; callers that need a clean slate pass a fresh reader instead.
}
/**
 * Load the obfuscated-file set from the manifest. Returns a normalized Set, or null when the manifest is
 * missing / unreadable / structurally invalid (NOT an `obfuscate` array of literal string paths). null is the
 * fail-closed signal: the caller must then reject all files. Success is cached per reader; failures retry briefly
 * so startup-time transient filesystem errors do not disable self-PR until process restart.
 */
export function loadObfuscatedFiles(readManifest) {
    const cached = cache.get(readManifest);
    if (cached?.kind === 'loaded')
        return cached.files;
    if (cached?.kind === 'failed' && cached.stable)
        return null;
    let result;
    try {
        const raw = readManifest();
        if (raw === null)
            throw new Error('public.manifest.json not found / unreadable');
        const manifest = JSON.parse(raw);
        if (!Array.isArray(manifest.obfuscate)) {
            throw new Error('public.manifest.json missing `obfuscate` array');
        }
        // Reject globs / non-strings: a glob would silently miss exact-path matches and reintroduce drift.
        for (const f of manifest.obfuscate) {
            if (typeof f !== 'string' || /[*?[\]]/.test(f)) {
                throw new Error(`public.manifest.json \`obfuscate\` must contain literal paths, got: ${JSON.stringify(f)}`);
            }
        }
        result = new Set(manifest.obfuscate.map((f) => normalizeManifestPath(f)).filter(Boolean));
    }
    catch {
        const now = Date.now();
        const firstFailedAt = cached?.kind === 'failed' ? cached.firstFailedAt : now;
        cache.set(readManifest, {
            kind: 'failed',
            firstFailedAt,
            stable: now - firstFailedAt >= MANIFEST_TRANSIENT_RETRY_MS,
        });
        return null; // fail-closed: an unreadable/invalid manifest rejects everything
    }
    cache.set(readManifest, { kind: 'loaded', files: result });
    return result;
}
/**
 * Is `changedFile` one of the obfuscated files? FAIL-CLOSED: when the manifest can't be loaded (null) every
 * file is treated as obfuscated. Matching is on the normalized relative path (exact, segment-aware) — the
 * manifest holds literal file paths, so a similarly-named non-obfuscated file (e.g. "src/secret_helper.ts"
 * vs an obfuscated "src/secret.ts") is NOT a false positive.
 */
export function isObfuscatedFile(changedFile, readManifest) {
    const obfuscated = loadObfuscatedFiles(readManifest);
    if (obfuscated === null)
        return true; // fail-closed
    const rel = normalizeManifestPath(changedFile);
    if (!rel)
        return false;
    return obfuscated.has(rel);
}