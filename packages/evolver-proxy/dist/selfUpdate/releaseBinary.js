import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { createGunzip } from 'node:zlib';
import { ops } from '@evomap/evolver-core';
import { SELF_UPDATE_FAILURE_CODES, SelfUpdateFailureError, selfUpdateFailure } from './failureCodes.js';
const DEFAULT_RELEASES_URL = 'https://github.com/EvoMap/evolver/releases';
const SIGNED_MANIFEST_ASSET = 'evolver-update-manifest.json';
const RELEASE_DOWNLOAD_TIMEOUT_MS = 60_000;
/**
 * Hard ceiling for primary release binaries. The binary is buffered before its
 * manifest hash is verified, so an unbounded response could exhaust memory
 * before the verification gate runs. 128MiB leaves headroom above current
 * single-platform binaries while bounding that pre-verification allocation.
 */
export const MAX_PRIMARY_BINARY_BYTES = 128 * 1024 * 1024;
/** Release metadata is untrusted and buffered before parsing or verification. */
export const MAX_RELEASE_METADATA_BYTES = 256 * 1024;
/**
 * Hard ceiling for Channel 1b tarball downloads. A compromised/corrupt release
 * could advertise a multi-GB tar.gz and OOM us because tarballBytes is buffered
 * before extraction. 64MB is well above any real single-platform precompiled
 * release tarball today.
 */
export const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
/**
 * Hard ceiling for the decompressed tar stream. This is intentionally larger
 * than the compressed-body cap so normal binary tarballs still fit, while gzip
 * bombs fail before the extractor accumulates unbounded output in memory.
 */
export const MAX_EXTRACTED_TARBALL_BYTES = 128 * 1024 * 1024;
const SELF_UPDATE_RELEASE_BINARY_RE = /^evolver(?:\.exe|-(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)|windows-x64\.exe))?$/;
export function isStandaloneReleaseBinaryName(name) {
    return SELF_UPDATE_RELEASE_BINARY_RE.test(name.toLowerCase());
}
export function requiredVersionForRelease(raw) {
    try {
        return ops.requireSelfUpdateVersion(raw, 'required_version');
    }
    catch (err) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.BAD_REQUIRED_VERSION, errorDetail(err), { cause: err });
    }
}
export function releaseAssetName(platform = process.platform, arch = process.arch) {
    if (platform === 'darwin' && arch === 'arm64')
        return 'evolver-darwin-arm64';
    if (platform === 'darwin' && arch === 'x64')
        return 'evolver-darwin-x64';
    if (platform === 'linux' && arch === 'arm64')
        return 'evolver-linux-arm64';
    if (platform === 'linux' && arch === 'x64')
        return 'evolver-linux-x64';
    if (platform === 'win32' && arch === 'x64')
        return 'evolver-windows-x64.exe';
    throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_FAILED, `unsupported_release_platform:${platform}:${arch}`);
}
export async function resolveGithubReleaseManifest(directive, opts = {}) {
    assertGithubUpdateChannelAvailable(directive);
    const version = requiredVersionForRelease(directive.required_version);
    const assetName = releaseAssetName(opts.platform, opts.arch);
    if (opts.requireSignedManifest) {
        return fetchSignedReleaseManifest(directive.release_url, version, assetName, opts.fetchFn);
    }
    const sumsUrl = releaseDownloadUrl(directive.release_url, version, 'SHA256SUMS.txt');
    const text = await fetchText(sumsUrl, opts.fetchFn);
    const sha256 = shaForAsset(text, assetName);
    return { version, artifacts: [{ path: assetName, sha256 }] };
}
export async function downloadGithubReleaseArtifact(targetVersion, directive, opts = {}) {
    assertGithubUpdateChannelAvailable(directive);
    const version = requiredVersionForRelease(targetVersion);
    const assetName = releaseAssetName(opts.platform, opts.arch);
    // Channel 1a: try the precompiled binary asset first (the normal happy path).
    // Channel 1b: if 1a fails — release rate-limited / asset missing / geo-blocked —
    // fall through to a same-release `.tar.gz` form and extract the binary out of it.
    // The signed-manifest sha256 gate (verifyManifest) is unchanged either way: the
    // staged bytes still have to hash to the manifest's art.sha256 for assetName.
    // See PORT v1 #282: "force-update: add tarball fallback for self-update".
    let primaryError;
    try {
        return await downloadBinaryAsset(version, assetName, directive, opts);
    }
    catch (err) {
        primaryError = err;
    }
    return downloadGithubReleaseTarball(version, assetName, directive, opts, primaryError);
}
async function downloadBinaryAsset(version, assetName, directive, opts) {
    const assetUrl = releaseDownloadUrl(directive.release_url, version, assetName);
    const bytes = Buffer.from(await fetchBytes(assetUrl, opts.fetchFn, resolvedPrimaryBinaryLimit(opts.maxPrimaryBinaryBytes)));
    if (bytes.byteLength === 0) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_INCOMPLETE, `empty release asset:${assetName}`);
    }
    return stageStagedBinary(bytes, assetName, opts, 'binary');
}
/**
 * Channel 1b: download the same release's `<assetName>.tar.gz` and extract the
 * binary file matching `assetName` (or its basename). The tarball MUST contain
 * an entry that matches the asset name — anything else and we fail closed with
 * `fallback_missing_binary` (no half-extracted state).
 *
 * Note: we do NOT use `codeload.github.com/.../tar.gz` here. Codeload returns
 * the SOURCE tree, which has no compiled binary; V2 ships a single binary, so
 * the fallback only restores the DOWNLOAD leg, not an "install from source"
 * leg. If a deployment wants the source-tree fallback V1 had, that is a
 * separate, signed channel that doesn't exist yet in V2.
 *
 * The returned DownloadResult is shape-compatible with the primary path: same
 * `artifacts[].path` (assetName) and a sha256 over the EXTRACTED binary bytes,
 * so the executor's verifyManifest gate still enforces signature + hash before
 * any atomicReplace.
 */
export async function downloadGithubReleaseTarball(version, assetName, directive, opts, primaryError) {
    const tarballName = `${assetName}.tar.gz`;
    const tarballUrl = releaseDownloadUrl(directive.release_url, version, tarballName);
    let tarballBytes;
    try {
        const arr = await fetchBytes(tarballUrl, opts.fetchFn, MAX_TARBALL_BYTES);
        tarballBytes = Buffer.from(arr);
    }
    catch (err) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.FALLBACK_DOWNLOAD_FAILED, `${tarballName}:${primaryDetail(primaryError)}|tarball:${errorDetail(err)}`, { cause: err });
    }
    if (tarballBytes.byteLength === 0) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.FALLBACK_DOWNLOAD_FAILED, `${tarballName}:${primaryDetail(primaryError)}|empty_release_tarball`);
    }
    // OOM guard: a malicious or corrupt release could advertise a multi-GB tarball
    // that we'd otherwise buffer entirely in memory before rejecting at extract
    // time. Cap the body length BEFORE extraction so the worst case is bounded.
    // 64MB is comfortably above any real precompiled evolver binary (single-binary
    // build is < 100MB compressed across all platforms today), and small enough
    // that bin-only nodes don't OOM on it.
    if (tarballBytes.byteLength > MAX_TARBALL_BYTES) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.FALLBACK_DOWNLOAD_FAILED, `${tarballName}:${primaryDetail(primaryError)}|tarball_too_large:${tarballBytes.byteLength} > ${MAX_TARBALL_BYTES}`);
    }
    let binaryBytes;
    try {
        binaryBytes = await extractBinaryFromTarball(tarballBytes, assetName, resolvedExtractedTarballLimit(opts.maxExtractedTarballBytes));
    }
    catch (err) {
        if (err instanceof SelfUpdateFailureError)
            throw err;
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.FALLBACK_EXTRACT_FAILED, `${tarballName}:${primaryDetail(primaryError)}|extract:${errorDetail(err)}`, { cause: err });
    }
    return stageStagedBinary(binaryBytes, assetName, opts, 'tarball');
}
async function stageStagedBinary(bytes, assetName, opts, appliedVia) {
    const root = join(opts.tmpDir ?? tmpdir(), `evolver-update-${process.pid}-${randomBytes(6).toString('hex')}`);
    await mkdir(root, { recursive: true });
    const stagedPath = join(root, assetName);
    await writeFile(stagedPath, bytes, { mode: 0o755 });
    await chmod(stagedPath, 0o755);
    return {
        stagedPath,
        artifacts: [{ path: assetName, sha256: createHash('sha256').update(bytes).digest('hex') }],
        appliedVia,
    };
}
function primaryDetail(err) {
    if (err instanceof SelfUpdateFailureError) {
        const codePrefix = err.failureCode ? `${err.failureCode}:` : '';
        return `primary=${codePrefix}${err.message}`;
    }
    return `primary=${errorDetail(err)}`;
}
export async function atomicReplaceExecutable(stagedPath, opts = {}) {
    // The staged download must always be cleaned up, even when target resolution
    // or the install guard rejects BEFORE the copy: a verified release that then
    // fails the guard must not leave its temp staging file on disk. So the whole
    // body runs inside this try/finally, not just the copy/rename step.
    try {
        const target = resolveSelfUpdateTarget(opts);
        const targetPath = target.path;
        assertSafeExecutableTarget(targetPath, target.explicit);
        let st;
        try {
            st = await stat(stagedPath);
        }
        catch (err) {
            // The staged file existed right after download; a missing/unreadable file
            // here is a replace-phase precondition failure, so the failureCode must
            // line up with the executor's `replace_failed` coarse outcome rather than
            // misreport a download problem.
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, errorDetail(err), { cause: err });
        }
        if (!st.isFile()) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REPLACE_FAILED, 'staged_release_not_file');
        }
        const tmpPath = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${randomBytes(6).toString('hex')}.evolver-tmp`);
        try {
            await copyFile(stagedPath, tmpPath);
            await chmod(tmpPath, 0o755);
            if (process.platform === 'win32')
                await rm(targetPath, { force: true });
            await rename(tmpPath, targetPath);
        }
        catch (err) {
            await rm(tmpPath, { force: true }).catch(() => { });
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.COPY_FAILED, errorDetail(err), { cause: err });
        }
    }
    finally {
        await rm(stagedPath, { force: true }).catch(() => { });
    }
}
export function resolveSelfUpdateTarget(opts = {}) {
    const explicitTarget = opts.targetPath ?? opts.env?.['EVOLVER_SELF_UPDATE_TARGET_PATH']?.trim();
    if (explicitTarget)
        return { path: explicitTarget, explicit: true };
    const execPath = opts.processExecPath ?? process.execPath;
    // Split on both separators so a win32-shaped path (backslashes) is classified
    // correctly even when this check runs on a POSIX host (shape probes, tests).
    const segments = execPath.split(/[/\\]+/).filter(Boolean);
    const name = (segments.length > 0 ? segments[segments.length - 1] : basename(execPath)).toLowerCase();
    if (isStandaloneReleaseBinaryName(name))
        return { path: execPath, explicit: false };
    throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.INSTALL_GUARD_UNREADABLE, `self_update_target_required:${execPath}`);
}
export function assertSelfUpdateProcessTargetBound(options, allowUnresolvedTarget = false) {
    let targetPath;
    try {
        targetPath = resolveSelfUpdateTarget(options).path;
    }
    catch {
        if (allowUnresolvedTarget)
            return;
        throw new Error('self_update_process_target_mismatch');
    }
    const processExecPath = options.processExecPath ?? process.execPath;
    try {
        if (canonicalExecutablePath(processExecPath) !== canonicalExecutablePath(targetPath)) {
            throw new Error('self_update_process_target_mismatch');
        }
    }
    catch {
        throw new Error('self_update_process_target_mismatch');
    }
}
export function selfUpdateProcessTargetBindable(options) {
    try {
        assertSelfUpdateProcessTargetBound(options);
        return true;
    }
    catch {
        return false;
    }
}
function canonicalExecutablePath(path) {
    const canonical = realpathSync.native(path);
    if (process.platform !== 'win32')
        return resolve(canonical);
    const withoutNamespace = canonical
        .replace(/^\\\\\?\\UNC\\/i, '\\\\')
        .replace(/^\\\\\?\\/i, '');
    return win32.normalize(withoutNamespace).toLowerCase();
}
function releaseDownloadUrl(releaseUrl, version, assetName) {
    let base;
    try {
        base = new URL(releaseUrl && releaseUrl.trim() ? releaseUrl : DEFAULT_RELEASES_URL);
    }
    catch (err) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_FAILED, 'invalid_release_url', { cause: err });
    }
    if (base.username || base.password) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_FAILED, 'invalid_release_url_credentials');
    }
    if (base.protocol !== 'https:' || base.hostname !== 'github.com') {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_FAILED, 'invalid_release_url_origin');
    }
    const parts = base.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'EvoMap' || parts[1] !== 'evolver' || parts[2] !== 'releases') {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_FAILED, 'invalid_release_url_repo');
    }
    return `https://github.com/EvoMap/evolver/releases/download/v${version}/${assetName}`;
}
async function fetchSignedReleaseManifest(releaseUrl, version, assetName, fetchFn) {
    const manifestUrl = releaseDownloadUrl(releaseUrl, version, SIGNED_MANIFEST_ASSET);
    const raw = await fetchText(manifestUrl, fetchFn);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_INCOMPLETE, `signed_manifest_invalid_json:${errorDetail(err)}`, { cause: err });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_INCOMPLETE, 'signed_manifest_invalid');
    }
    const manifest = parsed;
    if (typeof manifest.signature !== 'string' || manifest.signature.length === 0) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REJECTED_VERIFICATION, 'signed_manifest_missing_signature');
    }
    if (manifest.signatureAlg !== 'ed25519') {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.REJECTED_VERIFICATION, 'signed_manifest_unsupported_signature_alg');
    }
    const manifestVersion = ops.normalizeConcreteVersion(manifest.version);
    if (!manifestVersion) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_INCOMPLETE, 'signed_manifest_invalid_version');
    }
    if (manifestVersion !== version) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOADED_VERSION_MISMATCH, 'signed_manifest_version_mismatch');
    }
    const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
    if (!artifacts.some((artifact) => artifact && typeof artifact.path === 'string' && basename(artifact.path) === assetName)) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_INCOMPLETE, `signed_manifest_asset_missing:${assetName}`);
    }
    return manifest;
}
async function fetchText(url, fetchFn) {
    const fetched = await fetchWith(url, fetchFn);
    const bytes = await readBodyWithTimeout(url, 'text', () => readBytesWithLimit(fetched.response, MAX_RELEASE_METADATA_BYTES, fetched.abort), fetched.abort);
    return Buffer.from(bytes).toString('utf8');
}
async function fetchBytes(url, fetchFn, maxBytes) {
    const fetched = await fetchWith(url, fetchFn);
    return readBodyWithTimeout(url, 'arrayBuffer', () => readBytesWithLimit(fetched.response, maxBytes, fetched.abort), fetched.abort);
}
async function readBytesWithLimit(response, maxBytes, abort) {
    if (maxBytes === undefined || !response.body) {
        const arr = await response.arrayBuffer();
        if (maxBytes !== undefined && arr.byteLength > maxBytes) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_INCOMPLETE, `release_body_too_large:${arr.byteLength} > ${maxBytes}`);
        }
        return arr;
    }
    const declaredBytes = parseContentLength(response.headers.get('content-length'));
    if (declaredBytes !== undefined && declaredBytes > maxBytes) {
        abort();
        await response.body.cancel().catch(() => { });
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_INCOMPLETE, `release_body_too_large:${declaredBytes} > ${maxBytes}`);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (!value)
                continue;
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
                abort();
                await reader.cancel().catch(() => { });
                throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_INCOMPLETE, `release_body_too_large:${totalBytes} > ${maxBytes}`);
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const out = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out.buffer;
}
function parseContentLength(raw) {
    const trimmed = raw?.trim();
    if (!trimmed || !/^\d+$/.test(trimmed))
        return undefined;
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed))
        return Number.POSITIVE_INFINITY;
    return parsed;
}
async function fetchWith(url, fetchFn) {
    const fn = fetchFn ?? globalThis.fetch;
    if (!fn)
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_FAILED, 'fetch_unavailable');
    const controller = new AbortController();
    const res = await withReleaseDownloadTimeout(() => fn(url, { signal: controller.signal }), `release_fetch_timeout:${url}`, () => controller.abort());
    if (!res.ok) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DEGIT_FAILED, `release_fetch_failed:${res.status}:${url}`);
    }
    return { response: res, abort: () => controller.abort() };
}
async function readBodyWithTimeout(url, bodyKind, read, abort) {
    try {
        return await withReleaseDownloadTimeout(read, `release_body_timeout:${bodyKind}:${url}`, abort);
    }
    catch (err) {
        if (isSelfUpdateFailureCode(err, SELF_UPDATE_FAILURE_CODES.DEGIT_TIMEOUT))
            throw err;
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_INCOMPLETE, `release_body_read_failed:${bodyKind}:${errorDetail(err)}`, { cause: err });
    }
}
async function withReleaseDownloadTimeout(operation, timeoutDetail, onTimeout) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            onTimeout?.();
            reject(selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DEGIT_TIMEOUT, timeoutDetail));
        }, RELEASE_DOWNLOAD_TIMEOUT_MS);
        unrefTimer(timeoutId);
    });
    try {
        return await Promise.race([operation(), timeout]);
    }
    finally {
        clearTimeout(timeoutId);
    }
}
function unrefTimer(timeoutId) {
    if (timeoutId
        && typeof timeoutId === 'object'
        && 'unref' in timeoutId
        && typeof timeoutId.unref === 'function') {
        timeoutId.unref();
    }
}
function isSelfUpdateFailureCode(err, failureCode) {
    return err instanceof SelfUpdateFailureError && err.failureCode === failureCode;
}
function assertGithubUpdateChannelAvailable(directive) {
    if (directive.update_channels && !directive.update_channels.includes('github')) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.ALL_CHANNELS_EXHAUSTED, 'github_update_channel_unavailable');
    }
}
function shaForAsset(sums, assetName) {
    for (const line of sums.split(/\r?\n/)) {
        const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
        if (match && basename(match[2] ?? '') === assetName)
            return (match[1] ?? '').toLowerCase();
    }
    throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.DOWNLOAD_INCOMPLETE, `release_sha_missing:${assetName}`);
}
function assertSafeExecutableTarget(targetPath, explicitTarget) {
    const name = basename(targetPath).toLowerCase();
    if (!isStandaloneReleaseBinaryName(name) && !explicitTarget) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.INSTALL_GUARD_NAME_MISMATCH, `unsafe_self_update_target:${targetPath}`);
    }
}
function errorDetail(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
/**
 * Extract the binary `assetName` (matched by basename) out of a gzipped tar.
 * Inline parser — V2 has no `tar` dep and inheriting V1 #282's approach keeps
 * the install surface single-binary, no native deps. The parser is intentionally
 * minimal: it reads ustar/POSIX headers, joins prefix+name, and only accepts
 * regular file entries (type '0' / '\0'). Anything weird (symlinks, hard links,
 * device nodes, longlink GNU extensions for the binary name we care about) is
 * skipped — a release that hides the binary behind a symlink is treated the
 * same as one that omitted it, i.e. fallback_missing_binary, fail-closed.
 *
 * Path safety (basename-match is the safety mechanism, not a bug):
 *   We match entries by `basename(name)`, NOT by the full archived path. That
 *   means `./evolver-linux-x64`, `nested/dir/evolver-linux-x64`, AND a hostile
 *   `../../../etc/evolver-linux-x64` all resolve to the same matched entry —
 *   this is intentional. Legitimate goreleaser/release-it tarballs vary in how
 *   they nest the binary, so allowing any path with the right basename keeps
 *   the fallback robust. The hostile `../` case is harmless HERE because we
 *   NEVER use the archive-supplied `name` as a write target: we return the
 *   bytes in memory and `stageStagedBinary` writes them to its OWN tmpdir
 *   under `assetName` (a constant from `releaseAssetName()`), not under any
 *   archive-controlled path. Then the executor's verifyManifest gate hashes
 *   those bytes against the signed manifest before atomicReplace runs.
 *
 *   The V1 "unsafe tar entry" class of bugs comes from extracting EVERY entry
 *   to disk using its declared path. We don't extract to disk and we only ever
 *   touch the one entry whose basename matches — so there is no extraction
 *   tempdir to traverse out of.
 */
async function extractBinaryFromTarball(archive, assetName, maxExtractedBytes) {
    const raw = await gunzipWithExtractedLimit(archive, maxExtractedBytes);
    const targetName = basename(assetName);
    let offset = 0;
    while (offset + 512 <= raw.length) {
        const header = raw.subarray(offset, offset + 512);
        offset += 512;
        if (isZeroTarBlock(header))
            break;
        let name = readTarString(header, 0, 100);
        const prefix = readTarString(header, 345, 155);
        if (prefix)
            name = `${prefix}/${name}`;
        const size = readTarOctal(header, 124, 12);
        const typeFlag = readTarString(header, 156, 1) || '0';
        if (offset + size > raw.length) {
            throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.FALLBACK_EXTRACT_FAILED, `truncated_tar_entry:${name}`);
        }
        const isRegularFile = typeFlag === '0' || typeFlag === '\0';
        if (isRegularFile && basename(name) === targetName) {
            return Buffer.from(raw.subarray(offset, offset + size));
        }
        // Advance past the entry body, rounded up to a 512-byte boundary.
        offset += Math.ceil(size / 512) * 512;
    }
    throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.FALLBACK_MISSING_BINARY, `fallback_missing_binary:${targetName}`);
}
function gunzipWithExtractedLimit(archive, maxExtractedBytes) {
    return new Promise((resolve, reject) => {
        const gunzip = createGunzip();
        const chunks = [];
        let totalBytes = 0;
        let settled = false;
        const fail = (err) => {
            if (settled)
                return;
            settled = true;
            gunzip.destroy();
            reject(err);
        };
        gunzip.on('data', (chunk) => {
            if (settled)
                return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += bytes.byteLength;
            if (totalBytes > maxExtractedBytes) {
                fail(selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.FALLBACK_EXTRACT_FAILED, `tarball_extracted_too_large:${totalBytes} > ${maxExtractedBytes}`));
                return;
            }
            chunks.push(bytes);
        });
        gunzip.once('error', (err) => {
            fail(selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.FALLBACK_EXTRACT_FAILED, `gunzip:${errorDetail(err)}`, { cause: err }));
        });
        gunzip.once('end', () => {
            if (settled)
                return;
            settled = true;
            resolve(Buffer.concat(chunks, totalBytes));
        });
        try {
            gunzip.end(archive);
        }
        catch (err) {
            fail(selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.FALLBACK_EXTRACT_FAILED, `gunzip:${errorDetail(err)}`, { cause: err }));
        }
    });
}
function resolvedExtractedTarballLimit(requested) {
    if (requested === undefined)
        return MAX_EXTRACTED_TARBALL_BYTES;
    if (!Number.isFinite(requested) || requested <= 0)
        return MAX_EXTRACTED_TARBALL_BYTES;
    return Math.min(Math.floor(requested), MAX_EXTRACTED_TARBALL_BYTES);
}
function resolvedPrimaryBinaryLimit(requested) {
    if (requested === undefined)
        return MAX_PRIMARY_BINARY_BYTES;
    if (!Number.isFinite(requested) || requested <= 0)
        return MAX_PRIMARY_BINARY_BYTES;
    // Tests may lower the cap without providing a production escape hatch that
    // could raise or disable the hard safety boundary.
    return Math.min(Math.floor(requested), MAX_PRIMARY_BINARY_BYTES);
}
function readTarString(block, start, length) {
    let end = start;
    const max = start + length;
    while (end < max && block[end] !== 0)
        end++;
    return block.toString('utf8', start, end);
}
function readTarOctal(block, start, length) {
    const trimmed = readTarString(block, start, length).trim();
    if (!trimmed)
        return 0;
    const parsed = parseInt(trimmed, 8);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw selfUpdateFailure(SELF_UPDATE_FAILURE_CODES.FALLBACK_EXTRACT_FAILED, `invalid_tar_numeric_field:${trimmed}`);
    }
    return parsed;
}
function isZeroTarBlock(block) {
    for (let i = 0; i < block.length; i++) {
        if (block[i] !== 0)
            return false;
    }
    return true;
}