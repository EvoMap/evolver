import { type KeyObject } from 'node:crypto';
export interface ParsedVersion {
    major: number;
    minor: number;
    patch: number;
}
export interface NormalizedSelfUpdateVersion {
    ok: true;
    version: string;
}
export interface InvalidSelfUpdateVersion {
    ok: false;
    reason: string;
}
export type SelfUpdateVersionResult = NormalizedSelfUpdateVersion | InvalidSelfUpdateVersion;
export declare const SELF_UPDATE_VERSION_MAX = 32;
/** Parse a version under the self-update contract. Invalid strings default to 0.0.0 for this legacy helper. */
export declare function parseVersion(v: string | null | undefined): ParsedVersion;
/** -1 if a<b, 0 if equal, 1 if a>b (SemVer precedence; build metadata ignored). */
export declare function compareVersions(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1;
/** True if `current` >= `required` (faithful to v1 isAtLeast: equal counts as satisfied). */
export declare function isAtLeast(current: string | null | undefined, required: string | null | undefined): boolean;
export declare function normalizeSelfUpdateVersion(value: unknown, field?: string): SelfUpdateVersionResult;
export declare function requireSelfUpdateVersion(value: unknown, field?: string): string;
/** Normalize a concrete semver value under the self-update contract. */
export declare function normalizeConcreteVersion(value: unknown): string | undefined;
/** Normalize the hub's required_version floor. Mirrors v1 forceUpdate.js strip + validate behavior. */
export declare function normalizeRequiredVersion(value: unknown): string | undefined;
export declare function compareConcreteVersions(left: string, right: string): -1 | 0 | 1 | null;
export declare function currentSatisfiesRequiredVersion(current: unknown, required: unknown): boolean;
/** One downloadable artifact the release pipeline must publish a hash for. */
export interface UpdateArtifact {
    /** Path/name of the artifact relative to the package root (e.g. `dist/evolver.tar.gz`). */
    path: string;
    /** Lowercase hex sha256 the release pipeline computed for this artifact. */
    sha256: string;
}
/**
 * The release manifest the hub points the node at. The release-CI side publishes this alongside the GitHub
 * Release. `signature` + `signatureAlg` are OPTIONAL on the wire but REQUIRED to pass when a public key is
 * configured on the node (fail-closed). The signature is over the canonical JSON of {version, artifacts}.
 */
export interface UpdateManifest {
    /** The version this manifest publishes (e.g. `1.4.0`). */
    version: string;
    /** Per-artifact sha256 list — MUST be non-empty (nothing to verify = nothing to trust). */
    artifacts: readonly UpdateArtifact[];
    /** base64 Ed25519 signature over canonicalManifestBytes({version, artifacts}). Optional on wire. */
    signature?: string;
    /** Signature algorithm tag; only 'ed25519' is accepted. */
    signatureAlg?: string;
}
export type UpdateAction = 'proceed' | 'noop' | 'reject';
export interface UpdateDecision {
    action: UpdateAction;
    reason: string;
    targetVersion?: string;
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
export declare function decideUpdate(input: {
    current: string;
    required?: string;
    manifest: unknown;
}): UpdateDecision;
/** sha256 hex of the given bytes — the digest each downloaded artifact is checked against. */
export declare function sha256Hex(bytes: Uint8Array): string;
/**
 * Canonical bytes the signature is computed over: a deterministic JSON of {version, artifacts:[{path,sha256}]}
 * with artifacts sorted by path and sha256 lowercased, so signer and verifier agree byte-for-byte regardless of
 * key order or casing. The release pipeline MUST sign exactly these bytes.
 */
export declare function canonicalManifestBytes(manifest: Pick<UpdateManifest, 'version' | 'artifacts'>): Uint8Array;
export interface VerifyResult {
    ok: boolean;
    reason: string;
}
/** A downloaded artifact's content, supplied to verifyManifest as already-read bytes (or a precomputed digest). */
export interface DownloadedArtifact {
    path: string;
    /** Raw bytes of the downloaded file (preferred). */
    bytes?: Uint8Array;
    /** Or a precomputed lowercase-hex sha256, if the caller hashed during streaming (avoids buffering). */
    sha256?: string;
}
/**
 * Parse a configured public key (PEM, raw 32-byte base64, SPKI DER base64, or a KeyObject) into a node KeyObject.
 *
 * The base64 forms mirror scripts/release-update-manifest.mjs parsePublicKey exactly: the release pipeline and the
 * built-in channel key ship the full SPKI DER blob (44 bytes for Ed25519), while operator overrides may supply the
 * bare 32-byte raw key. Anything that does not decode to a valid Ed25519 SPKI key throws (fail-closed).
 */
export declare function toPublicKey(publicKey: string | KeyObject): KeyObject;
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
export declare function verifyManifest(manifest: unknown, downloaded: readonly DownloadedArtifact[], publicKey?: string | KeyObject): VerifyResult;
/**
 * Verify exactly one explicitly selected download against a complete release manifest.
 *
 * Unlike verifyManifest, this verifier does not require downloading every platform artifact. When a public key is
 * configured it first verifies the Ed25519 signature over the complete canonical manifest, then requires exactly
 * one downloaded artifact and exactly one manifest entry with the same path, and finally checks that artifact's
 * sha256. The complete manifest is never filtered or reconstructed before signature verification.
 */
export declare function verifySelectedManifestArtifact(manifest: unknown, downloaded: readonly DownloadedArtifact[], publicKey?: string | KeyObject): VerifyResult;