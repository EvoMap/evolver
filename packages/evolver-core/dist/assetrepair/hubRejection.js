const MAX_ISSUES = 50;
const MAX_MESSAGE_CHARS = 300;
const REASON_TOKEN = /^[a-z][a-z0-9_]*$/;
const REASON_PREFIXES = [
    { prefix: 'gene', assetType: 'Gene' },
    { prefix: 'capsule', assetType: 'Capsule' },
    { prefix: 'event', assetType: 'EvolutionEvent' },
    { prefix: 'bundle' },
];
const REPAIRABLE_REASON_PATHS = new Map([
    ['asset_id_verification_failed', 'asset_id'],
    ['missing_asset_id', 'asset_id'],
]);
export function hubRejectionIssues(body, options = {}) {
    const fieldReport = fieldLevelIssues(body);
    if (fieldReport.issues.length > 0)
        return fieldReport;
    return ruleReasonIssues(body, options.assetTypes ?? []);
}
function fieldLevelIssues(body) {
    const report = { issues: [], byAssetIndex: new Map() };
    for (const raw of detailRows(body).slice(0, MAX_ISSUES)) {
        const detail = asRecord(raw);
        if (!detail)
            continue;
        const path = pathSegments(detail['path']);
        const message = text(detail['message']) ?? text(detail['code']);
        if (!message)
            continue;
        const issue = {
            path: assetRelativePath(path),
            keyword: text(detail['code']) ?? 'invalid',
            message: message.slice(0, MAX_MESSAGE_CHARS),
            source: 'hub',
        };
        report.issues.push(issue);
        const index = assetIndex(path);
        const bucket = report.byAssetIndex.get(index);
        if (bucket)
            bucket.push(issue);
        else
            report.byAssetIndex.set(index, [issue]);
    }
    return report;
}
function ruleReasonIssues(body, assetTypes) {
    const report = { issues: [], byAssetIndex: new Map() };
    const reason = ruleReason(body);
    if (!reason)
        return report;
    const prefix = REASON_PREFIXES.find((entry) => reason.token.startsWith(`${entry.prefix}_`));
    if (!prefix)
        return report;
    const issue = {
        path: REPAIRABLE_REASON_PATHS.get(reason.token.slice(prefix.prefix.length + 1)) ?? '',
        keyword: reason.token,
        message: reason.message.slice(0, MAX_MESSAGE_CHARS),
        source: 'hub',
    };
    const index = prefix.assetType === undefined ? -1 : assetTypes.indexOf(prefix.assetType);
    report.issues.push(issue);
    report.byAssetIndex.set(index, [issue]);
    return report;
}
function ruleReason(body) {
    const root = asRecord(body);
    if (!root)
        return undefined;
    const payload = asRecord(root['payload']);
    const raw = [root['error'], root['reason'], payload?.['error'], payload?.['reason']]
        .map((candidate) => text(candidate))
        .find((candidate) => candidate !== undefined);
    if (!raw)
        return undefined;
    const token = raw.split(":", 1)[0]?.trim() ?? '';
    return REASON_TOKEN.test(token) ? { token, message: raw } : undefined;
}
function detailRows(body) {
    const root = asRecord(body);
    if (!root)
        return [];
    const payload = asRecord(root['payload']);
    for (const candidate of [root['details'], root['errors'], payload?.['details'], payload?.['errors']]) {
        if (Array.isArray(candidate))
            return candidate;
    }
    return [];
}
function pathSegments(value) {
    if (!Array.isArray(value))
        return typeof value === 'string' ? value.split('.') : [];
    return value.filter((segment) => typeof segment === 'string' || typeof segment === 'number');
}
/** `['payload','assets',0,'constraints','forbidden_paths']` → `constraints.forbidden_paths`. */
function assetRelativePath(path) {
    const at = path.findIndex((segment) => typeof segment === 'number');
    const tail = at >= 0 ? path.slice(at + 1) : path.filter((segment) => segment !== 'payload');
    return tail.join('.');
}
function assetIndex(path) {
    const found = path.find((segment) => typeof segment === 'number');
    return typeof found === 'number' ? found : -1;
}
function text(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}