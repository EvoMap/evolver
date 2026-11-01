/**
 * Derive the stable idempotency key of one logical reuse report.
 *
 * Parts are joined with NUL, the same convention the Hub (`strings.Join(parts, "\x00")`) and the
 * CLI outbox identity (`digest(`${claimRootDigest}\0${assetId}`)`) use. A part that itself
 * contains NUL could shift a boundary, but the Hub hashes the asset id separately into its event
 * id, so two reports of DIFFERENT assets can never collapse onto one event. The result is
 * `${REUSE_IDEMPOTENCY_KEY_PREFIX}` + 64 hex chars (81 characters total).
 */
export declare function reuseResultIdempotencyKey(parts: readonly string[]): string;