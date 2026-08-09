// Self-update DECISION + VERIFY core (ported from v1 src/forceUpdate.js — parseVer/isAtLeast/version compare —
// PLUS the security gate v1 lacked). This module is PURE and hub-agnostic: it makes the
// update/noop/reject decision and verifies already-downloaded artifact bytes/hashes against a signed manifest.
// It performs NO I/O — no download, no filesystem write, no process control. Those live in the proxy executor
// (evolver-proxy/src/selfUpdate/executor.ts) which CALLS verifyManifest before touching disk (verify-before-apply).
//
// Why split this way (the boundary rule): a compromised hub must not equal fleet RCE. The decision of whether to
// apply AND the verification of what to apply are deterministic, fully unit-testable, and must never depend on
// who is calling. The risky part (writing files, exit(78)) is isolated in proxy behind injected seams.
import { createHash, verify as cryptoVerify, createPublicKey } from 'node:crypto';
const SEMVER_NUMERIC_IDENTIFIER = '0|[1-9]\\d*';
const SEMVER_PRERELEASE_IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER_BUILD_IDENTIFIER = '[0-9A-Za-z-]+';
const CONCRETE_SEMVER_RE = new RegExp(`^(${SEMVER_NUMERIC_IDENTIFIER})\\.(${SEMVER_NUMERIC_IDENTIFIER})\\.(${SEMVER_NUMERIC_IDENTIFIER})`
    + `(?:-(${SEMVER_PRERELEASE_IDENTIFIER}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER})*))?`
    + `(?:\\+(${SEMVER_BUILD_IDENTIFIER}(?:\\.${SEMVER_BUILD_IDENTIFIER})*))?$`);
export const SELF_UPDATE_VERSION_MAX = 32;
/** Parse a version under the self-update contract. Invalid strings default to 0.0.0 for this legacy helper. */
export function parseVersion(v) {
    const version = normalizeConcreteVersion(v);
    const parsed = version ? parseConcreteVersion(version) : undefined;
    return parsed ? { major: parsed.major, minor: parsed.minor, patch: parsed.patch } : { major: 0, minor: 0, patch: 0 };
}
/** -1 if a<b, 0 if equal, 1 if a>b (SemVer precedence; build metadata ignored). */
export function compareVersions(a, b) {
    return compareConcreteVersions(normalizeConcreteVersion(a) ?? '0.0.0', normalizeConcreteVersion(b) ?? '0.0.0') ?? 0;
}
/** True if `current` >= `required` (faithful to v1 isAtLeast: equal counts as satisfied). */
export function isAtLeast(current, required) {
    return compareVersions(current, required) >= 0;
}
export function normalizeSelfUpdateVersion(value, field = 'version') {
    if (typeof value !== 'string')
        return { ok: false, reason: `${field}_missing` };
    const normalized = value.replace(/^[>=^~\s]+/, '').replace(/^v/, '');
    if (normalized.length === 0)
        return { ok: false, reason: `${field}_missing` };
    if (normalized.length > SELF_UPDATE_VERSION_MAX)
        return { ok: false, reason: `${field}_too_long` };
    if (!CONCRETE_SEMVER_RE.test(normalized))
        return { ok: false, reason: `${field}_invalid` };
    return { ok: true, version: normalized };
}
export function requireSelfUpdateVersion(value, field = 'version') {
    const normalized = normalizeSelfUpdateVersion(value, field);
    if (!normalized.ok)
        throw new Error(normalized.reason);
    return normalized.version;
}
/** Normalize a concrete semver value under the self-update contract. */
export function normalizeConcreteVersion(value) {
    const normalized = normalizeSelfUpdateVersion(value);
    return normalized.ok ? normalized.version : undefined;
}
/** Normalize the hub's required_version floor. Mirrors v1 forceUpdate.js strip + validate behavior. */
export function normalizeRequiredVersion(value) {
    return normalizeConcreteVersion(value);
}
export function compareConcreteVersions(left, right) {
    const leftVersion = normalizeConcreteVersion(left);
    const rightVersion = normalizeConcreteVersion(right);
    if (!leftVersion || !rightVersion)
        return null;
    const a = parseConcreteVersion(leftVersion);
    const b = parseConcreteVersion(rightVersion);
    if (!a || !b)
        return null;
    const majorCmp = compareNumericIdentifierStrings(a.majorRaw, b.majorRaw);
    if (majorCmp !== 0)
        return majorCmp < 0 ? -1 : 1;
    const minorCmp = compareNumericIdentifierStrings(a.minorRaw, b.minorRaw);
    if (minorCmp !== 0)
        return minorCmp < 0 ? -1 : 1;
    const patchCmp = compareNumericIdentifierStrings(a.patchRaw, b.patchRaw);
    if (patchCmp !== 0)
        return patchCmp < 0 ? -1 : 1;
    if (a.prerelease.length === 0 && b.prerelease.length === 0)
        return 0;
    if (a.prerelease.length === 0)
        return 1;
    if (b.prerelease.length === 0)
        return -1;
    const max = Math.max(a.prerelease.length, b.prerelease.length);
    for (let i = 0; i < max; i += 1) {
        const av = a.prerelease[i];
        const bv = b.prerelease[i];
        if (av === undefined)
            return -1;
        if (bv === undefined)
            return 1;
        const cmp = comparePrereleaseIdentifiers(av, bv);
        if (cmp !== 0)
            return cmp < 0 ? -1 : 1;
    }
    return 0;
}
export function currentSatisfiesRequiredVersion(current, required) {
    const currentVersion = normalizeConcreteVersion(current);
    const requiredVersion = normalizeRequiredVersion(required);
    if (!currentVersion || !requiredVersion)
        return false;
    const cmp = compareConcreteVersions(currentVersion, requiredVersion);
    return cmp !== null && cmp >= 0;
}
function parseConcreteVersion(value) {
    const match = CONCRETE_SEMVER_RE.exec(value);
    if (!match)
        return undefined;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        majorRaw: match[1] ?? '0',
        minorRaw: match[2] ?? '0',
        patchRaw: match[3] ?? '0',
        prerelease: match[4] ? match[4].split('.') : [],
    };
}
function isNumericPrereleaseIdentifier(value) {
    return /^\d+$/.test(value);
}
function compareNumericIdentifierStrings(left, right) {
    if (left.length !== right.length)
        return left.length - right.length;
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}
function comparePrereleaseIdentifiers(left, right) {
    const leftNumeric = isNumericPrereleaseIdentifier(left);
    const rightNumeric = isNumericPrereleaseIdentifier(right);
    if (leftNumeric && rightNumeric)
        return compareNumericIdentifierStrings(left, right);
    if (leftNumeric)
        return -1;
    if (rightNumeric)
        return 1;
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}
/** Shallow structural validation of a manifest — returns null if structurally usable, else a reject reason. */
function manifestStructuralError(manifest) {
    if (!manifest || typeof manifest !== 'object')
        return 'manifest_missing';
    const m = manifest;
    if (typeof m.version !== 'string' || !m.version.trim())
        return 'manifest_no_version';
    if (!normalizeConcreteVersion(m.version))
        return 'manifest_bad_version';
    if (!Array.isArray(m.artifacts) || m.artifacts.length === 0)
        return 'manifest_no_artifacts';
    for (const a of m.artifacts) {
        if (!a || typeof a.path !== 'string' || !a.path.trim())
            return 'manifest_bad_artifact_path';
        if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(a.sha256))
            return 'manifest_bad_artifact_sha256';
    }
    return null;
}
/**
 * Decide whether to apply an update. PURE. Fail-closed: a missing/malformed manifest, or a target that does not
 * advance past `current`, never proceeds.
 *   - reject : manifest missing/malformed, or required target not satisfiable by the manifest version.
 *   - noop   : current already satisfies the requested target (no restart needed) — v1's NOOP branch.
 *   - proceed: manifest is valid AND advances current. Caller must STILL verifyManifest before applying.
 *
 * `required` is the hub's force_update `required_version` (what the hub demands). `manifest.version` is what the
 * download would deliver. We refuse if the manifest can't actually satisfy the requirement.
 */
export function decideUpdate(input) {
    const structErr = manifestStructuralError(input.manifest);
    if (structErr)
        return { action: 'reject', reason: structErr };
    const manifest = input.manifest;
    const manifestVersion = normalizeConcreteVersion(manifest.version);
    if (!manifestVersion)
        return { action: 'reject', reason: 'manifest_bad_version' };
    const required = input.required !== undefined && String(input.required) !== ''
        ? normalizeRequiredVersion(input.required)
        : manifestVersion;
    if (!required)
        return { action: 'reject', reason: 'required_version_invalid' };
    // The manifest must be able to deliver at least the required version, otherwise applying it is pointless/unsafe.
    const manifestCmp = compareConcreteVersions(manifestVersion, required);
    if (manifestCmp === null)
        return { action: 'reject', reason: 'manifest_bad_version' };
    if (manifestCmp < 0) {
        return { action: 'reject', reason: 'manifest_below_required', targetVersion: manifestVersion };
    }
    // Already at/above what the hub requires → nothing to do, do NOT restart (v1 NOOP).
    const currentVersion = normalizeConcreteVersion(input.current);
    if (!currentVersion)
        return { action: 'reject', reason: 'current_version_invalid' };
    const currentCmp = compareConcreteVersions(currentVersion, required);
    if (currentCmp !== null && currentCmp >= 0) {
        return { action: 'noop', reason: 'already_satisfied', targetVersion: required };
    }
    return { action: 'proceed', reason: 'update_available', targetVersion: manifestVersion };
}
// ---------------------------------------------------------------------------------------------------------------
// Manifest verification (the security gate v1 lacked). sha256-per-artifact is MANDATORY; Ed25519 signature is the
// strong form, enforced ONLY when a public key is configured — and then fail-closed.
// ---------------------------------------------------------------------------------------------------------------
/** sha256 hex of the given bytes — the digest each downloaded artifact is checked against. */
export function sha256Hex(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
/**
 * Canonical bytes the signature is computed over: a deterministic JSON of {version, artifacts:[{path,sha256}]}
 * with artifacts sorted by path and sha256 lowercased, so signer and verifier agree byte-for-byte regardless of
 * key order or casing. The release pipeline MUST sign exactly these bytes.
 */
export function canonicalManifestBytes(manifest) {
    const canonical = {
        version: requireSelfUpdateVersion(manifest.version, 'manifest_version'),
        artifacts: [...manifest.artifacts]
            .map((a) => ({ path: a.path, sha256: a.sha256.toLowerCase() }))
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    };
    return new TextEncoder().encode(JSON.stringify(canonical));
}
/**
 * Parse a configured public key (PEM, raw 32-byte base64, SPKI DER base64, or a KeyObject) into a node KeyObject.
 *
 * The base64 forms mirror scripts/release-update-manifest.mjs parsePublicKey exactly: the release pipeline and the
 * built-in channel key ship the full SPKI DER blob (44 bytes for Ed25519), while operator overrides may supply the
 * bare 32-byte raw key. Anything that does not decode to a valid Ed25519 SPKI key throws (fail-closed).
 */
export function toPublicKey(publicKey) {
    if (typeof publicKey !== 'string')
        return publicKey;
    const trimmed = publicKey.trim();
    if (trimmed.includes('BEGIN PUBLIC KEY'))
        return createPublicKey(trimmed);
    const decoded = Buffer.from(trimmed, 'base64');
    // Raw 32-byte Ed25519 key, base64 → wrap in DER SPKI so createPublicKey accepts it;
    // any other length is assumed to already be a full SPKI DER blob.
    const der = decoded.length === 32
        ? Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), decoded])
        : decoded;
    let key;
    try {
        key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    }
    catch {
        throw new Error('ed25519 public key must be a raw 32-byte or SPKI DER base64 key');
    }
    if (key.asymmetricKeyType !== 'ed25519')
        throw new Error('ed25519 public key must be an Ed25519 key');
    return key;
}
/** Verify the signature over the complete canonical manifest when a public key is configured. */
function verifyConfiguredManifestSignature(manifest, publicKey) {
    if (!publicKey)
        return { ok: true, reason: 'signature_not_required' };
    if (!manifest.signature)
        return { ok: false, reason: 'signature_required_but_missing' };
    if (manifest.signatureAlg && manifest.signatureAlg !== 'ed25519') {
        return { ok: false, reason: 'signature_alg_unsupported' };
    }
    try {
        const key = toPublicKey(publicKey);
        const ok = cryptoVerify(null, // Ed25519 ignores the digest-name arg
        canonicalManifestBytes(manifest), key, Buffer.from(manifest.signature, 'base64'));
        return ok ? { ok: true, reason: 'signature_verified' } : { ok: false, reason: 'signature_invalid' };
    }
    catch (err) {
        return { ok: false, reason: `signature_verify_error: ${err instanceof Error ? err.message : String(err)}` };
    }
}
/**
 * Verify downloaded artifacts against the manifest. PURE + deterministic (takes already-read bytes/hashes; does
 * NO I/O). Two layers:
 *   1. sha256-per-artifact (ALWAYS): every manifest artifact must have a matching downloaded artifact whose
 *      sha256 equals the manifest's. Missing, extra-unmatched, or mismatched → reject.
 *   2. Ed25519 signature (ONLY when `publicKey` is configured): the manifest MUST carry a valid signature over
 *      canonicalManifestBytes. A configured key + missing/badly-signed/wrong-alg manifest → reject (fail-closed).
 *      With NO key configured, signature is not required (sha256 is still mandatory) — the node operator opts into
 *      the strong form by configuring a key. No key is ever hardcoded.
 *
 * Fail-closed everywhere: any doubt (bad structure, hash gap, signature failure, thrown crypto error) → reject.
 */
export function verifyManifest(manifest, downloaded, publicKey) {
    const structErr = manifestStructuralError(manifest);
    if (structErr)
        return { ok: false, reason: structErr };
    const m = manifest;
    // Layer 1: sha256 per artifact (mandatory). Index downloads by path; every manifest entry must match.
    const byPath = new Map();
    for (const d of downloaded)
        byPath.set(d.path, d);
    for (const art of m.artifacts) {
        const got = byPath.get(art.path);
        if (!got)
            return { ok: false, reason: `artifact_missing: ${art.path}` };
        let digest;
        if (got.sha256)
            digest = got.sha256.toLowerCase();
        else if (got.bytes)
            digest = sha256Hex(got.bytes);
        else
            return { ok: false, reason: `artifact_no_content: ${art.path}` };
        if (digest !== art.sha256.toLowerCase())
            return { ok: false, reason: `sha256_mismatch: ${art.path}` };
    }
    // Layer 2: Ed25519 signature — enforced ONLY when a key is configured (then fail-closed).
    const signature = verifyConfiguredManifestSignature(m, publicKey);
    if (!signature.ok)
        return signature;
    return { ok: true, reason: 'verified' };
}
/**
 * Verify exactly one explicitly selected download against a complete release manifest.
 *
 * Unlike verifyManifest, this verifier does not require downloading every platform artifact. When a public key is
 * configured it first verifies the Ed25519 signature over the complete canonical manifest, then requires exactly
 * one downloaded artifact and exactly one manifest entry with the same path, and finally checks that artifact's
 * sha256. The complete manifest is never filtered or reconstructed before signature verification.
 */
export function verifySelectedManifestArtifact(manifest, downloaded, publicKey) {
    const structErr = manifestStructuralError(manifest);
    if (structErr)
        return { ok: false, reason: structErr };
    const m = manifest;
    const signature = verifyConfiguredManifestSignature(m, publicKey);
    if (!signature.ok)
        return signature;
    if (downloaded.length !== 1) {
        return { ok: false, reason: `downloaded_artifact_count_invalid: ${downloaded.length}` };
    }
    const selected = downloaded[0];
    if (!selected || typeof selected.path !== 'string' || !selected.path) {
        return { ok: false, reason: 'downloaded_artifact_path_invalid' };
    }
    const matches = m.artifacts.filter((artifact) => artifact.path === selected.path);
    if (matches.length === 0)
        return { ok: false, reason: `artifact_missing: ${selected.path}` };
    if (matches.length !== 1)
        return { ok: false, reason: `artifact_duplicate: ${selected.path}` };
    const expected = matches[0];
    if (!expected)
        return { ok: false, reason: `artifact_missing: ${selected.path}` };
    let digest;
    if (selected.sha256)
        digest = selected.sha256.toLowerCase();
    else if (selected.bytes)
        digest = sha256Hex(selected.bytes);
    else
        return { ok: false, reason: `artifact_no_content: ${selected.path}` };
    if (digest !== expected.sha256.toLowerCase()) {
        return { ok: false, reason: `sha256_mismatch: ${selected.path}` };
    }
    return { ok: true, reason: 'verified' };
}