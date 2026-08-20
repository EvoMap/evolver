import { posix, win32 } from 'node:path';
import { parseFileLockProcessStartIdentity, sameFileLockProcessStartIdentity, } from '../util/fileLock.js';
export const LIFECYCLE_BOOTSTRAP_MARKER_SCHEMA = 'evolver.lifecycle-bootstrap.v1';
export const LIFECYCLE_BOOTSTRAP_LEGACY_BINDING = 'legacy-v907';
export const LIFECYCLE_BOOTSTRAP_LEGACY_ENV_FILE_STATE_ROOT_PROOF = 'legacy-v907-env-file';
export const LIFECYCLE_BOOTSTRAP_DEADLINE_ENV = 'EVOLVER_INTERNAL_BOOTSTRAP_DEADLINE_MS';
export const LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV = 'EVOLVER_INTERNAL_BOOTSTRAP_TRANSACTION_ID';
export const LIFECYCLE_BOOTSTRAP_SUCCESS_FILE = 'bootstrap.json';
export const LIFECYCLE_BOOTSTRAP_JOURNAL_FILE = 'bootstrap-transaction.json';
export const LIFECYCLE_BOOTSTRAP_OWNER_LOCK_FILE = 'bootstrap-owner.lock';
export const LIFECYCLE_BOOTSTRAP_READINESS_FILE = 'bootstrap-readiness.json';
export const LIFECYCLE_BOOTSTRAP_READINESS_LOCK_FILE = 'bootstrap-readiness.lock';
export const LIFECYCLE_BOOTSTRAP_READINESS_SCHEMA = 'evolver.lifecycle-bootstrap-readiness.v1';
export const LIFECYCLE_BOOTSTRAP_MANUAL_TRANSITION_FILE = 'bootstrap-manual-transition.json';
export const LIFECYCLE_BOOTSTRAP_MANUAL_TRANSITION_SCHEMA = 'evolver.lifecycle-bootstrap-manual-transition.v1';
export const MAX_LIFECYCLE_BOOTSTRAP_MANUAL_TRANSITION_BYTES = 4 * 1024;
export const LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_FILE = 'bootstrap-registration.intent.json';
export const LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_TERMINAL_FILE = 'bootstrap-registration.intent.terminal';
export const LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_CLEARING_FILE = 'bootstrap-registration.intent.clearing';
export const LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_SCHEMA = 'evolver.bootstrap-registration-intent.v1';
export const LIFECYCLE_BOOTSTRAP_REGISTRATION_TOKEN_ENV = 'EVOLVER_INTERNAL_BOOTSTRAP_REGISTRATION_TOKEN';
export const MAX_LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_BYTES = 4 * 1024;
const TARGETS = new Set(['launchd', 'systemd', 'windows']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
function canonicalBootstrapPath(path, target) {
    return target === 'windows'
        ? win32.isAbsolute(path) && win32.normalize(path) === path
        : posix.isAbsolute(path) && posix.normalize(path) === path;
}
function bootstrapPathKey(path, target) {
    return target === 'windows' ? win32.normalize(path).toLowerCase() : path;
}
function boundedText(value, maxLength) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength)
        return false;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 0x1f || code === 0x7f)
            return false;
    }
    return true;
}
function exactRecordKeys(record, expected) {
    const actual = Object.keys(record).sort();
    const sortedExpected = [...expected].sort();
    return actual.length === sortedExpected.length
        && actual.every((key, index) => key === sortedExpected[index]);
}
function exactIsoTimestamp(value) {
    if (typeof value !== 'string')
        return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
export function parseLifecycleBootstrapRegistrationToken(value) {
    return typeof value === 'string' && UUID_RE.test(value) ? value : undefined;
}
function exactProcessStartIdentityKeys(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value;
    if (record['source'] === 'linux-proc') {
        return exactRecordKeys(record, ['source', 'bootId', 'startTicks']);
    }
    if (record['source'] === 'windows-powershell') {
        return exactRecordKeys(record, ['source', 'startTimeTicks']);
    }
    if (record['source'] === 'darwin-ps') {
        return exactRecordKeys(record, ['source', 'startTime']);
    }
    return false;
}
export function parseLifecycleBootstrapManualTransition(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    if (!exactRecordKeys(record, ['schema', 'transitionId', 'removedTransactionId', 'target', 'service', 'createdAt'])
        || record['schema'] !== LIFECYCLE_BOOTSTRAP_MANUAL_TRANSITION_SCHEMA
        || typeof record['transitionId'] !== 'string' || !UUID_RE.test(record['transitionId'])
        || typeof record['removedTransactionId'] !== 'string'
        || !UUID_RE.test(record['removedTransactionId'])
        || typeof record['target'] !== 'string'
        || !TARGETS.has(record['target'])
        || !boundedText(record['service'], 128)
        || !exactIsoTimestamp(record['createdAt'])) {
        return undefined;
    }
    return {
        schema: LIFECYCLE_BOOTSTRAP_MANUAL_TRANSITION_SCHEMA,
        transitionId: record['transitionId'],
        removedTransactionId: record['removedTransactionId'],
        target: record['target'],
        service: record['service'],
        createdAt: record['createdAt'],
    };
}
export function parseLifecycleBootstrapManualTransitionJson(raw) {
    try {
        return parseLifecycleBootstrapManualTransition(JSON.parse(raw));
    }
    catch {
        return undefined;
    }
}
export function parseLifecycleBootstrapRegistrationIntent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    const ownerValue = record['owner'];
    if (record['schema'] !== LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_SCHEMA
        || !ownerValue || typeof ownerValue !== 'object' || Array.isArray(ownerValue)
        || !exactRecordKeys(ownerValue, ['pid', 'token', 'processStartIdentity'])
        || !Number.isSafeInteger(ownerValue['pid'])
        || ownerValue['pid'] <= 0
        || !parseLifecycleBootstrapRegistrationToken(ownerValue['token'])
        || !exactProcessStartIdentityKeys(ownerValue['processStartIdentity'])
        || !exactIsoTimestamp(record['createdAt'])) {
        return undefined;
    }
    const processStartIdentity = parseFileLockProcessStartIdentity(ownerValue['processStartIdentity']);
    if (!processStartIdentity)
        return undefined;
    const owner = {
        pid: ownerValue['pid'],
        token: ownerValue['token'],
        processStartIdentity,
    };
    const base = {
        schema: LIFECYCLE_BOOTSTRAP_REGISTRATION_INTENT_SCHEMA,
        owner,
        createdAt: record['createdAt'],
    };
    if (record['state'] === 'registering') {
        if (!exactRecordKeys(record, ['schema', 'state', 'owner', 'createdAt']))
            return undefined;
        return { ...base, state: 'registering' };
    }
    const terminalOutcomes = new Set([
        'committed',
        'rolled_back',
        'no_child',
        'cancelled',
    ]);
    if (record['state'] !== 'terminal'
        || typeof record['outcome'] !== 'string'
        || !terminalOutcomes.has(record['outcome'])
        || !exactIsoTimestamp(record['terminalAt'])) {
        return undefined;
    }
    const outcome = record['outcome'];
    if (outcome === 'committed') {
        if (!exactRecordKeys(record, ['schema', 'state', 'owner', 'createdAt', 'outcome', 'terminalAt', 'transactionId'])
            || typeof record['transactionId'] !== 'string'
            || !UUID_RE.test(record['transactionId'])) {
            return undefined;
        }
        return {
            ...base,
            state: 'terminal',
            outcome,
            terminalAt: record['terminalAt'],
            transactionId: record['transactionId'],
        };
    }
    if (!exactRecordKeys(record, ['schema', 'state', 'owner', 'createdAt', 'outcome', 'terminalAt'])
        || record['transactionId'] !== undefined) {
        return undefined;
    }
    return { ...base, state: 'terminal', outcome, terminalAt: record['terminalAt'] };
}
export function parseLifecycleBootstrapRegistrationIntentJson(raw) {
    try {
        return parseLifecycleBootstrapRegistrationIntent(JSON.parse(raw));
    }
    catch {
        return undefined;
    }
}
export function parseLifecycleBootstrapMarker(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    if (record['schema'] !== LIFECYCLE_BOOTSTRAP_MARKER_SCHEMA)
        return undefined;
    const markerKeys = [
        'schema',
        'transactionId',
        'bootstrappedAt',
        'target',
        'service',
        'files',
        'managerArtifactPath',
        'artifacts',
        ...(record['managerBindingKind'] === undefined ? [] : ['managerBindingKind']),
        ...(record['preservedArtifacts'] === undefined ? [] : ['preservedArtifacts']),
        ...(record['legacyStateRootProof'] === undefined ? [] : ['legacyStateRootProof']),
    ];
    if (!exactRecordKeys(record, markerKeys))
        return undefined;
    if (typeof record['transactionId'] !== 'string' || !UUID_RE.test(record['transactionId']))
        return undefined;
    if (typeof record['bootstrappedAt'] !== 'string' || Number.isNaN(Date.parse(record['bootstrappedAt'])))
        return undefined;
    if (typeof record['target'] !== 'string' || !TARGETS.has(record['target']))
        return undefined;
    if (!boundedText(record['service'], 128))
        return undefined;
    if (!Array.isArray(record['files']) || record['files'].length === 0 || record['files'].length > 32)
        return undefined;
    if (!record['files'].every((file) => boundedText(file, 4_096)))
        return undefined;
    const files = record['files'];
    const target = record['target'];
    if (files.some((file) => !canonicalBootstrapPath(file, target)))
        return undefined;
    const pathKeys = files.map((file) => bootstrapPathKey(file, target));
    if (new Set(pathKeys).size !== pathKeys.length)
        return undefined;
    if (!boundedText(record['managerArtifactPath'], 4_096)
        || !canonicalBootstrapPath(record['managerArtifactPath'], target)
        || !pathKeys.includes(bootstrapPathKey(record['managerArtifactPath'], target)))
        return undefined;
    const managerBindingKind = record['managerBindingKind'];
    if (managerBindingKind !== undefined
        && managerBindingKind !== 'transaction'
        && managerBindingKind !== LIFECYCLE_BOOTSTRAP_LEGACY_BINDING)
        return undefined;
    if (!Array.isArray(record['artifacts']))
        return undefined;
    const parseArtifact = (artifact) => {
        if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact))
            return undefined;
        const value = artifact;
        if (!exactRecordKeys(value, ['path', 'size', 'sha256', 'device', 'inode']))
            return undefined;
        if (!boundedText(value['path'], 4_096) || !canonicalBootstrapPath(value['path'], target)
            || !Number.isSafeInteger(value['size']) || value['size'] < 0
            || typeof value['sha256'] !== 'string' || !SHA256_RE.test(value['sha256']))
            return undefined;
        if (typeof value['device'] !== 'string' || !/^[0-9]+$/.test(value['device'])
            || BigInt(value['device']) <= 0n
            || typeof value['inode'] !== 'string' || !/^[0-9]+$/.test(value['inode'])
            || BigInt(value['inode']) <= 0n)
            return undefined;
        return {
            path: value['path'],
            size: value['size'],
            sha256: value['sha256'],
            device: value['device'],
            inode: value['inode'],
        };
    };
    const artifacts = record['artifacts'].map(parseArtifact);
    const preservedArtifacts = record['preservedArtifacts'] === undefined
        ? []
        : Array.isArray(record['preservedArtifacts'])
            ? record['preservedArtifacts'].map(parseArtifact)
            : [undefined];
    if (record['preservedArtifacts'] !== undefined
        && (managerBindingKind !== LIFECYCLE_BOOTSTRAP_LEGACY_BINDING
            || preservedArtifacts.length === 0))
        return undefined;
    const legacyStateRootProofValue = record['legacyStateRootProof'];
    let legacyStateRootProof;
    if (legacyStateRootProofValue !== undefined) {
        if (managerBindingKind !== LIFECYCLE_BOOTSTRAP_LEGACY_BINDING
            || !legacyStateRootProofValue
            || typeof legacyStateRootProofValue !== 'object'
            || Array.isArray(legacyStateRootProofValue))
            return undefined;
        const proof = legacyStateRootProofValue;
        if (!exactRecordKeys(proof, ['kind', 'envFilePath', 'stateDir'])
            || proof['kind'] !== LIFECYCLE_BOOTSTRAP_LEGACY_ENV_FILE_STATE_ROOT_PROOF
            || !boundedText(proof['envFilePath'], 4_096)
            || !canonicalBootstrapPath(proof['envFilePath'], target)
            || !boundedText(proof['stateDir'], 4_096)
            || !canonicalBootstrapPath(proof['stateDir'], target))
            return undefined;
        legacyStateRootProof = {
            kind: LIFECYCLE_BOOTSTRAP_LEGACY_ENV_FILE_STATE_ROOT_PROOF,
            envFilePath: proof['envFilePath'],
            stateDir: proof['stateDir'],
        };
    }
    if (managerBindingKind !== LIFECYCLE_BOOTSTRAP_LEGACY_BINDING
        && artifacts.length !== files.length)
        return undefined;
    const receipts = [...artifacts, ...preservedArtifacts];
    if (receipts.length !== files.length
        || receipts.some((artifact) => artifact === undefined)
        || receipts.some((artifact, index) => bootstrapPathKey(artifact.path, target) !== pathKeys[index]))
        return undefined;
    const ownedKeys = new Set(artifacts.map((artifact) => bootstrapPathKey(artifact.path, target)));
    if (!ownedKeys.has(bootstrapPathKey(record['managerArtifactPath'], target)))
        return undefined;
    if (legacyStateRootProof) {
        const proofKey = bootstrapPathKey(legacyStateRootProof.envFilePath, target);
        const preservedKeys = new Set(preservedArtifacts.map((artifact) => bootstrapPathKey(artifact.path, target)));
        if (!preservedKeys.has(proofKey) || ownedKeys.has(proofKey))
            return undefined;
    }
    return {
        schema: LIFECYCLE_BOOTSTRAP_MARKER_SCHEMA,
        transactionId: record['transactionId'],
        bootstrappedAt: record['bootstrappedAt'],
        target,
        service: record['service'],
        files: [...files],
        managerArtifactPath: record['managerArtifactPath'],
        ...(managerBindingKind === undefined ? {} : {
            managerBindingKind: managerBindingKind,
        }),
        artifacts: artifacts,
        ...(preservedArtifacts.length === 0 ? {} : {
            preservedArtifacts: preservedArtifacts,
        }),
        ...(legacyStateRootProof ? { legacyStateRootProof } : {}),
    };
}
export function parseLegacyLifecycleBootstrapMarker(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    if (!exactRecordKeys(record, ['bootstrappedAt', 'target', 'service', 'files'])
        || !exactIsoTimestamp(record['bootstrappedAt'])
        || typeof record['target'] !== 'string'
        || !TARGETS.has(record['target'])
        || !boundedText(record['service'], 128)
        || !Array.isArray(record['files'])
        || record['files'].length === 0
        || record['files'].length > 32
        || !record['files'].every((file) => boundedText(file, 4_096)))
        return undefined;
    const target = record['target'];
    const service = record['service'];
    const expectedService = target === 'systemd'
        ? 'systemd-user'
        : target === 'launchd'
            ? 'launchd'
            : 'windows-scheduled-task';
    const files = record['files'];
    if (service !== expectedService
        || files.some((file) => !canonicalBootstrapPath(file, target)))
        return undefined;
    const pathKeys = files.map((file) => bootstrapPathKey(file, target));
    if (new Set(pathKeys).size !== pathKeys.length)
        return undefined;
    return {
        bootstrappedAt: record['bootstrappedAt'],
        target,
        service,
        files: [...files],
    };
}
export function parseLegacyLifecycleBootstrapMarkerJson(raw) {
    try {
        return parseLegacyLifecycleBootstrapMarker(JSON.parse(raw));
    }
    catch {
        return undefined;
    }
}
export function parseLifecycleBootstrapMarkerJson(raw) {
    try {
        return parseLifecycleBootstrapMarker(JSON.parse(raw));
    }
    catch {
        return undefined;
    }
}
export function parseLifecycleBootstrapReadiness(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    if (!exactRecordKeys(record, [
        'schema',
        'transactionId',
        'pid',
        'pidProcessStartIdentity',
        'supervisorPid',
        'supervisorProcessStartIdentity',
        'startedAt',
        'ipcUrl',
    ])
        || record['schema'] !== LIFECYCLE_BOOTSTRAP_READINESS_SCHEMA
        || typeof record['transactionId'] !== 'string' || !UUID_RE.test(record['transactionId'])
        || !Number.isSafeInteger(record['pid']) || record['pid'] <= 0
        || !Number.isSafeInteger(record['supervisorPid']) || record['supervisorPid'] <= 0
        || !exactProcessStartIdentityKeys(record['pidProcessStartIdentity'])
        || !exactProcessStartIdentityKeys(record['supervisorProcessStartIdentity'])
        || !exactIsoTimestamp(record['startedAt'])
        || !boundedText(record['ipcUrl'], 2_048))
        return undefined;
    const pidProcessStartIdentity = parseFileLockProcessStartIdentity(record['pidProcessStartIdentity']);
    const supervisorProcessStartIdentity = parseFileLockProcessStartIdentity(record['supervisorProcessStartIdentity']);
    if (!pidProcessStartIdentity || !supervisorProcessStartIdentity)
        return undefined;
    if (record['pid'] === record['supervisorPid']
        && !sameFileLockProcessStartIdentity(pidProcessStartIdentity, supervisorProcessStartIdentity))
        return undefined;
    try {
        const url = new URL(record['ipcUrl']);
        const port = Number(url.port);
        if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())
            || !Number.isSafeInteger(port) || port <= 0 || port > 65_535
            || url.username !== '' || url.password !== '' || url.pathname !== '/'
            || url.search !== '' || url.hash !== '') {
            return undefined;
        }
    }
    catch {
        return undefined;
    }
    return {
        schema: LIFECYCLE_BOOTSTRAP_READINESS_SCHEMA,
        transactionId: record['transactionId'],
        pid: record['pid'],
        pidProcessStartIdentity,
        supervisorPid: record['supervisorPid'],
        supervisorProcessStartIdentity,
        startedAt: record['startedAt'],
        ipcUrl: record['ipcUrl'],
    };
}
export function parseLifecycleBootstrapReadinessJson(raw) {
    try {
        return parseLifecycleBootstrapReadiness(JSON.parse(raw));
    }
    catch {
        return undefined;
    }
}