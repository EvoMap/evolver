import { join } from 'node:path';
import { events, issueReporter } from '@evomap/evolver-core';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
import { runDoctorChecks } from './doctor.js';
import { getCliVersion } from './version.js';
const GITHUB_FETCH_TIMEOUT_MS = 15_000;
function parseFlags(argv) {
    const flags = {
        json: false,
        cycleIds: [],
        eventIds: [],
        traceIds: [],
        steps: [],
        diagnosticCodes: [],
        approved: false,
        notCreated: false,
        abandon: false,
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        const next = () => argv[++index];
        if (arg === '--root')
            flags.root = next() ?? flags.root;
        else if (arg === '--json')
            flags.json = true;
        else if (arg === '--source')
            flags.source = next();
        else if (arg === '--error-class')
            flags.errorClass = next();
        else if (arg === '--failure-class')
            flags.failureClass = next();
        else if (arg === '--cycle') {
            const value = next();
            if (value)
                flags.cycleIds.push(value);
        }
        else if (arg === '--event') {
            const value = next();
            if (value)
                flags.eventIds.push(value);
        }
        else if (arg === '--trace') {
            const value = next();
            if (value)
                flags.traceIds.push(value);
        }
        else if (arg === '--step') {
            const value = next();
            if (value)
                flags.steps.push(value);
        }
        else if (arg === '--diagnostic') {
            const value = next();
            if (value)
                flags.diagnosticCodes.push(value);
        }
        else if (arg === '--repo')
            flags.repo = next();
        else if (arg === '--approve')
            flags.approved = true;
        else if (arg === '--not-created')
            flags.notCreated = true;
        else if (arg === '--abandon')
            flags.abandon = true;
        else if (arg === '--issue-number') {
            const value = Number(next());
            if (Number.isInteger(value) && value > 0)
                flags.issueNumber = value;
        }
        else if (arg === '--issue-url')
            flags.issueUrl = next();
    }
    return flags;
}
function reporterOptions(flags, env, deps) {
    const envRoot = env['EVOLVER_ISSUE_REPORT_ROOT']?.trim();
    return {
        rootDir: flags.root ?? (envRoot || join(events.evomapHome(env), 'evolution', 'issue-reporter')),
        workspaceScope: process.cwd(),
        env,
        now: deps.now,
        logger: (entry) => process.stderr.write(`[issue-report] fingerprint=${entry.fingerprint} status=${entry.status}${entry.errorClass ? ` error_class=${entry.errorClass}` : ''}\n`),
    };
}
function writeResult(value, json) {
    process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${String(value)}\n`);
}
function publicDraftState(draft) {
    return { fingerprint: draft.fingerprint, status: draft.status };
}
function publicSubmitResult(result) {
    return {
        status: result.status,
        ...('errorClass' in result ? { errorClass: result.errorClass } : {}),
        draft: publicDraftState(result.draft),
    };
}
function githubTransport(token, fetchFn) {
    return {
        async listOpenIssues(input) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
            timer.unref?.();
            try {
                const response = await fetchFn(`https://api.github.com/repos/${input.repo}/issues?state=open&per_page=${input.perPage}&page=${input.page}`, {
                    method: 'GET',
                    signal: controller.signal,
                    headers: {
                        accept: 'application/vnd.github+json',
                        authorization: `Bearer ${token}`,
                        'user-agent': 'evolver-v2-safe-issue-reporter',
                        'x-github-api-version': '2022-11-28',
                    },
                });
                if (!response.ok)
                    throw new issueReporter.GithubIssueTransportError('not_created');
                const payload = await response.json();
                if (!Array.isArray(payload))
                    throw new issueReporter.GithubIssueTransportError('not_created');
                return {
                    issues: payload.map((item) => {
                        const record = item;
                        return {
                            number: Number(record['number']),
                            url: String(record['html_url'] ?? ''),
                            body: typeof record['body'] === 'string' ? record['body'] : '',
                            isPullRequest: record['pull_request'] !== undefined,
                        };
                    }),
                    hasNextPage: /<[^>]+>;\s*rel="next"/.test(response.headers.get('link') ?? ''),
                };
            }
            finally {
                clearTimeout(timer);
            }
        },
        async createIssue(input) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
            timer.unref?.();
            try {
                const response = await fetchFn(`https://api.github.com/repos/${input.repo}/issues`, {
                    method: 'POST',
                    signal: controller.signal,
                    headers: {
                        accept: 'application/vnd.github+json',
                        authorization: `Bearer ${token}`,
                        'content-type': 'application/json',
                        'user-agent': 'evolver-v2-safe-issue-reporter',
                        'x-github-api-version': '2022-11-28',
                    },
                    body: JSON.stringify({ title: input.title, body: input.body }),
                });
                if (!response.ok) {
                    throw new issueReporter.GithubIssueTransportError(response.status >= 400 && response.status < 500 ? 'not_created' : 'ambiguous');
                }
                const payload = await response.json();
                return { number: Number(payload.number), url: String(payload.html_url ?? '') };
            }
            finally {
                clearTimeout(timer);
            }
        },
    };
}
export async function runIssueReportCommand(argv, deps = {}) {
    const action = argv[0];
    const fingerprint = argv[1];
    const flags = parseFlags(argv.slice(action === 'submit' || action === 'reject' || action === 'resolve' ? 2 : 1));
    const env = { ...(deps.env ?? process.env) };
    if (action === 'submit' || action === 'resolve') {
        const envLoad = loadEnvFileFromEnv(env);
        if (envLoad.error) {
            process.stderr.write('issue_report_env_file_error\n');
            return 1;
        }
    }
    const options = reporterOptions(flags, env, { ...deps, env });
    if (action === 'draft') {
        let input = null;
        if (flags.cycleIds[0]) {
            input = issueReporter.issueReportInputFromCycle(events.readEvents(), flags.cycleIds[0]);
        }
        else if (flags.source === 'doctor') {
            input = issueReporter.issueReportInputFromDoctor(runDoctorChecks().map(({ name, status }) => ({ name, status })));
        }
        else if (issueReporter.isIssueReportSource(flags.source) && flags.errorClass) {
            input = {
                source: flags.source,
                errorClass: flags.errorClass,
                failureClass: flags.failureClass,
                cycleIds: flags.cycleIds,
                eventIds: flags.eventIds,
                traceIds: flags.traceIds,
                reproductionSteps: flags.steps,
                diagnosticCodes: flags.diagnosticCodes,
                version: getCliVersion(),
            };
        }
        if (!input) {
            process.stderr.write('用法: evolver issue-report draft (--cycle <id> | --source <doctor|review|event|cycle_failure> --error-class <class>) [--json]\n');
            return 1;
        }
        if (flags.traceIds.length > 0) {
            input.traceIds = [...(input.traceIds ?? []), ...flags.traceIds];
        }
        input.version ??= getCliVersion();
        const result = issueReporter.createIssueDraft(input, options);
        writeResult(flags.json ? result : `${result.status}: ${result.draft.fingerprint}`, flags.json);
        return 0;
    }
    if ((action === 'submit' || action === 'reject' || action === 'resolve') && fingerprint) {
        const lookup = issueReporter.lookupIssueDraft(options.rootDir, fingerprint);
        if (lookup.status !== 'found') {
            if (flags.json && /^[a-f0-9]{20}$/.test(fingerprint)) {
                writeResult({
                    status: 'failed',
                    errorClass: lookup.status === 'missing' ? 'draft_not_found' : 'unsafe_draft',
                    draft: { fingerprint, status: 'draft' },
                }, true);
            }
            else {
                process.stderr.write('issue draft not found\n');
            }
            return 1;
        }
        const { draft } = lookup;
        if (action === 'resolve') {
            const repo = flags.repo ?? env['EVOLVER_ISSUE_REPO'];
            const resolution = flags.notCreated
                ? { outcome: 'not_created' }
                : flags.abandon
                    ? { outcome: 'abandoned' }
                    : flags.issueNumber && flags.issueUrl && repo
                        ? { outcome: 'submitted', issueNumber: flags.issueNumber, url: flags.issueUrl, repo }
                        : null;
            if (!resolution) {
                process.stderr.write('resolve requires --not-created, --abandon, or --issue-number/--issue-url/--repo\n');
                return 1;
            }
            try {
                const resolved = issueReporter.resolveIssueSubmission(fingerprint, resolution, options);
                writeResult(flags.json ? publicDraftState(resolved) : `${resolved.status}: ${resolved.fingerprint}`, flags.json);
                return 0;
            }
            catch (error) {
                const errorClass = error instanceof issueReporter.IssueDraftConflictError
                    ? error.errorClass
                    : 'invalid_resolution';
                writeResult(flags.json ? { status: 'failed', errorClass, draft: publicDraftState(draft) } : `failed: ${draft.fingerprint}`, flags.json);
                return 1;
            }
        }
        if (action === 'reject') {
            let rejected;
            try {
                rejected = issueReporter.rejectIssueDraft(draft, options);
            }
            catch (error) {
                if (!(error instanceof issueReporter.IssueDraftConflictError))
                    throw error;
                const result = {
                    status: 'rate_limited',
                    errorClass: error.errorClass,
                    draft: publicDraftState(draft),
                };
                writeResult(flags.json ? result : `${result.status}: ${draft.fingerprint}`, flags.json);
                return 1;
            }
            writeResult(flags.json ? publicDraftState(rejected) : `${rejected.status}: ${rejected.fingerprint}`, flags.json);
            return rejected.status === 'submitted' ? 1 : 0;
        }
        const repo = flags.repo ?? env['EVOLVER_ISSUE_REPO'];
        const token = env['GITHUB_TOKEN'] ?? env['GH_TOKEN'];
        const operatorPolicy = env['EVOLVER_ISSUE_SUBMIT_POLICY']?.trim().toLowerCase() === 'allow';
        if (!repo || !token) {
            process.stderr.write('submit requires --repo and GITHUB_TOKEN/GH_TOKEN\n');
            return 1;
        }
        const result = await issueReporter.submitIssueDraft(draft, {
            repo,
            approved: flags.approved || operatorPolicy,
            approvalSource: operatorPolicy ? 'operator_policy' : flags.approved ? 'human' : undefined,
            transport: githubTransport(token, deps.fetch ?? fetch),
        }, options);
        writeResult(flags.json ? publicSubmitResult(result) : `${result.status}: ${result.draft.fingerprint}`, flags.json);
        return result.status === 'submitted' || result.status === 'already_submitted' ? 0 : 1;
    }
    process.stderr.write('用法: evolver issue-report <draft|submit|reject|resolve> ...\n');
    return 1;
}