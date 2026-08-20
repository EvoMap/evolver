/**
 * V1 → V2 environment variable compatibility layer (#698).
 *
 * Evolver V1 used several env var names that are no longer recognized by V2
 * resolvers. When operators upgrade from V1 to V2 without updating their env
 * files, these legacy names silently do nothing. This module detects the
 * presence of deprecated V1 env vars and emits structured warnings so
 * operators know which knobs to migrate.
 *
 * ## Migration map
 *
 * | V1 name | V2 equivalent | Notes |
 * |---|---|---|
 * | `OPENCLAW_WORKSPACE` | *(manual)* | Partial V2 support does not preserve V1 workspace and bridge semantics |
 * | `EVOLVER_NO_PARENT_GIT` | *(none)* | V2 uses `EVOLVER_REPO_ROOT` or nearest Git root |
 * | `EVOLVER_VERBOSE` | *(none)* | V2 has no global switch; opt in to feature-specific diagnostics manually |
 * | `EVOLVER_OPENAI_COMPATIBLE_BASE_URLS` | *(manual)* | Defensive compatibility spelling; canonical V1 used the EVOMAP-prefixed key |
 * | `EVOMAP_OPENAI_COMPATIBLE_BASE_URLS` | *(manual)* | Canonical V1 compatible-origin allowlist; selected base and credential were separate |
 * | `EVOLVER_AUTO_ISSUE` | *(none)* | V2 creates local drafts; submit requires explicit approval-gated flow |
 * | `EVOLVER_ROLLBACK_MODE` | *(none)* | V2 uses worktree/snapshot/recovery policy |
 * | `WORKER_ENABLED` | *(none)* | No merchant-worker resolver in V2 |
 * | `WORKER_DOMAINS` | *(none)* | No merchant-worker resolver in V2 |
 * | `WORKER_MAX_LOAD` | *(none)* | No merchant-worker resolver in V2 |
 * | `EVOLVER_MEMORY_GRAPH_AUTO_ROTATE` | *(none)* | V2 LocalMemoryGraph always performs bounded maintenance |
 * | `EVOLVER_MEMORY_GRAPH_MAX_SIZE_MB` | *(none)* | V2 LocalMemoryGraph uses a fixed 4 MiB active-file limit |
 * | `EVOLVER_MEMORY_GRAPH_RETENTION_COUNT` | *(none)* | V2 LocalMemoryGraph retains three archives by default |
 * | `GITHUB_TOKEN` | `GITHUB_TOKEN` | Already supported by V2 issue reporter and PR tooling |
 *
 * GITHUB_TOKEN is NOT deprecated — it's actively used. We only note its
 * presence for observability.
 */
/**
 * The canonical table of V1 → V2 env var deprecations.
 *
 * Order matters for deterministic output; the scan iterates this list
 * and checks each entry against the provided `env` object.
 */
export const V1_DEPRECATION_TABLE = [
    {
        v1Name: 'OPENCLAW_WORKSPACE',
        v2Equivalent: null,
        migrationAction: 'manual',
        guidance: 'OPENCLAW_WORKSPACE is still read directly by the pending-signals resolver. ' +
            'Do not copy it verbatim: identify the Git repo root before setting EVOLVER_REPO_ROOT, ' +
            'and migrate V1 bridge behavior separately.',
    },
    {
        v1Name: 'EVOLVER_NO_PARENT_GIT',
        v2Equivalent: null,
        migrationAction: 'remove',
        guidance: 'V2 uses EVOLVER_REPO_ROOT or the nearest Git root for workspace detection. ' +
            'Prefer EVOLVER_REPO_ROOT; EVOLVER_NO_PARENT_GIT has no V2 effect.',
    },
    {
        v1Name: 'EVOLVER_VERBOSE',
        v2Equivalent: null,
        migrationAction: 'remove',
        guidance: 'V2 has no global verbose switch. Remove this variable and opt in to a ' +
            'feature-specific flag such as EVOLVER_HOOK_VERBOSE=1 only when hook diagnostics are needed.',
    },
    {
        v1Name: 'EVOLVER_OPENAI_COMPATIBLE_BASE_URLS',
        v2Equivalent: null,
        migrationAction: 'manual',
        guidance: 'This compatibility spelling was not resolved by the canonical V1 runtime, but it is tracked defensively. ' +
            'V2 has no multi-base or arbitrary OpenAI-compatible resolver. Review the workload before cutover. ' +
            'While either legacy list key remains set, configure the exact canonical pair EVOLVER_LLM_OPENAI_BASE_URL ' +
            'and EVOLVER_LLM_OPENAI_API_KEY for one official https://*.api.openai.com/v1 endpoint. ' +
            'LiteLLM, OpenRouter, Azure OpenAI, MiniMax, DeepSeek, Moonshot, and custom endpoints are not drop-in routes; ' +
            'do not copy their credentials into the V2 OpenAI route.',
    },
    {
        v1Name: 'EVOMAP_OPENAI_COMPATIBLE_BASE_URLS',
        v2Equivalent: null,
        migrationAction: 'manual',
        guidance: 'Canonical V1 treated this comma-separated value as an allowed-origin list; EVOMAP_OPENAI_BASE_URL still selected one ' +
            'endpoint and EVOMAP_OPENAI_API_KEY or OPENAI_API_KEY supplied its credential. V2 requires a workload-by-workload review ' +
            'and has no automatic mapping. While the legacy list remains set, only the exact canonical pair ' +
            'EVOLVER_LLM_OPENAI_BASE_URL and EVOLVER_LLM_OPENAI_API_KEY acknowledges migration; otherwise keep the incompatible ' +
            'workload outside the V2 OpenAI route.',
    },
    {
        v1Name: 'EVOLVER_AUTO_ISSUE',
        v2Equivalent: null,
        migrationAction: 'remove',
        guidance: 'V2 does not auto-submit issues. It creates local drafts and requires ' +
            'explicit approval-gated submission via `evolver issue-report submit`.',
    },
    {
        v1Name: 'EVOLVER_ROLLBACK_MODE',
        v2Equivalent: null,
        migrationAction: 'remove',
        guidance: 'V2 uses worktree, snapshot, and recovery policy instead of legacy hard-reset. ' +
            'Remove this variable; it has no effect.',
    },
    {
        v1Name: 'WORKER_ENABLED',
        v2Equivalent: null,
        migrationAction: 'remove',
        guidance: 'V2 has no merchant-worker resolver. Remove this variable; it has no effect.',
    },
    {
        v1Name: 'WORKER_DOMAINS',
        v2Equivalent: null,
        migrationAction: 'remove',
        guidance: 'V2 has no merchant-worker resolver. Remove this variable; it has no effect.',
    },
    {
        v1Name: 'WORKER_MAX_LOAD',
        v2Equivalent: null,
        migrationAction: 'remove',
        guidance: 'V2 has no merchant-worker resolver. Remove this variable; it has no effect.',
    },
    {
        v1Name: 'EVOLVER_MEMORY_GRAPH_AUTO_ROTATE',
        v2Equivalent: null,
        migrationAction: 'remove',
        guidance: 'V2 LocalMemoryGraph always rotates and compacts automatically at its bounded defaults. ' +
            'There is no environment override; remove this variable.',
    },
    {
        v1Name: 'EVOLVER_MEMORY_GRAPH_MAX_SIZE_MB',
        v2Equivalent: null,
        migrationAction: 'remove',
        guidance: 'V2 LocalMemoryGraph uses a fixed 4 MiB active-file limit before rotation and compaction. ' +
            'There is no environment override; remove this variable.',
    },
    {
        v1Name: 'EVOLVER_MEMORY_GRAPH_RETENTION_COUNT',
        v2Equivalent: null,
        migrationAction: 'remove',
        guidance: 'V2 LocalMemoryGraph retains three archives by default and prunes older archives automatically. ' +
            'There is no environment override; remove this variable.',
    },
    {
        v1Name: 'EVOLVER_ATP',
        v2Equivalent: null,
        migrationAction: 'manual',
        guidance: 'V1 auto/on/off controlled merchant/provider lifecycle, which has no one-to-one V2 resolver. '
            + 'Review the missing merchant workflow before removing this key. Do not map it to `evolver atp enable` '
            + 'or EVOLVER_ATP_AUTOBUY; those controls authorize autonomous buyer spending. If V1 off meant no '
            + 'provider or delivery activity, set EVOLVER_ATP_AUTODELIVER=off explicitly as hardening, not as an equivalent mapping.',
    },
    {
        v1Name: 'EVOLVER_SESSION_SOURCE',
        v2Equivalent: null,
        migrationAction: 'manual',
        guidance: 'V1 auto/cursor/openclaw/merge selected session collectors, which has no one-to-one V2 resolver. '
            + 'Review the workload before removing this key. Supported trajectory export requires explicit runtime '
            + 'discovery or transcript-directory controls; setting another aggregate key does not restore OpenClaw collection.',
    },
];
/**
 * Scan the provided environment for deprecated V1 env vars and return
 * structured results. This function is purely read-only and never mutates
 * the `env` object.
 *
 * @param env  The environment to scan (defaults to `process.env`).
 * @returns    Structured scan results including detected deprecations.
 */
export function scanV1EnvCompat(env = typeof process !== 'undefined' ? process.env : {}) {
    const detected = [];
    for (const entry of V1_DEPRECATION_TABLE) {
        const value = env[entry.v1Name];
        if (value !== undefined && value.trim() !== '') {
            detected.push(entry);
        }
    }
    const githubTokenPresent = (env['GITHUB_TOKEN'] !== undefined && env['GITHUB_TOKEN'].trim() !== '') ||
        (env['GH_TOKEN'] !== undefined && env['GH_TOKEN'].trim() !== '');
    return { detected, githubTokenPresent };
}
/** Resolve the migration action while preserving compatibility with pre-action table entries. */
export function resolveV1EnvMigrationAction(entry) {
    return entry.migrationAction ?? (entry.v2Equivalent ? 'map' : 'remove');
}
/**
 * Emit deprecation warnings to the provided logger for all detected
 * deprecated V1 env vars. This is the primary integration point for
 * entrypoints that want human-readable console output.
 *
 * @param result  The scan result from `scanV1EnvCompat`.
 * @param warn    Logger function (defaults to `console.warn`).
 */
export function emitV1DeprecationWarnings(result, warn = (msg) => console.warn(msg)) {
    for (const dep of result.detected) {
        const action = resolveV1EnvMigrationAction(dep);
        const v2Hint = action === 'map' && dep.v2Equivalent
            ? ` Use ${dep.v2Equivalent} instead.`
            : '';
        const lead = action === 'manual'
            ? `Deprecated env var ${dep.v1Name} is set and requires manual migration.`
            : action === 'map'
                ? `Deprecated env var ${dep.v1Name} is set.`
                : `Deprecated env var ${dep.v1Name} is set but has no V2 resolver.`;
        warn(`[evolver:v1-compat] ${lead}${v2Hint} ${dep.guidance}`);
    }
    // githubTokenPresent is intentionally not warned: GITHUB_TOKEN/GH_TOKEN remain
    // supported by V2 issue reporter / PR tooling. Flag retained for callers/tests.
}
/**
 * Convenience function: scan + emit in one call. Intended for early
 * bootstrap in CLI/proxy/MCP entrypoints.
 *
 * @param env  The environment to scan.
 * @param warn Logger function.
 * @returns    The scan result (useful for programmatic inspection).
 */
export function checkV1EnvCompat(env = typeof process !== 'undefined' ? process.env : {}, warn) {
    const result = scanV1EnvCompat(env);
    if (result.detected.length > 0) {
        emitV1DeprecationWarnings(result, warn);
    }
    return result;
}
const V1_IMPLICIT_DEFAULT_CAVEATS = [
    'V1 treated unset EVOLVER_ATP and EVOLVER_SESSION_SOURCE as auto. A clean key scan therefore does not prove '
        + 'merchant/provider or session-collection workflow parity; audit both before cutover.',
];
/**
 * Build an offline V1→V2 env translation report.
 * Does not write files; callers decide how to present or apply suggestions.
 * Raw values are retained only as v2Value for mappable non-secret keys.
 * GITHUB_TOKEN and GH_TOKEN are reported as keep without retaining their values.
 */
export function translateV1Env(env = typeof process !== 'undefined' ? process.env : {}) {
    const suggestions = [];
    for (const entry of V1_DEPRECATION_TABLE) {
        const raw = env[entry.v1Name];
        if (raw === undefined || raw.trim() === '')
            continue;
        const action = resolveV1EnvMigrationAction(entry);
        if (action === 'map') {
            if (!entry.v2Equivalent)
                throw new Error(`missing V2 equivalent for ${entry.v1Name}`);
            suggestions.push({
                v1Name: entry.v1Name,
                action: 'map',
                v2Name: entry.v2Equivalent,
                v2Value: raw,
                guidance: entry.guidance,
            });
        }
        else {
            suggestions.push({
                v1Name: entry.v1Name,
                action,
                guidance: entry.guidance,
            });
        }
    }
    const githubTokenPresent = (env['GITHUB_TOKEN'] !== undefined && env['GITHUB_TOKEN'].trim() !== '') ||
        (env['GH_TOKEN'] !== undefined && env['GH_TOKEN'].trim() !== '');
    if (githubTokenPresent) {
        const key = env['GITHUB_TOKEN']?.trim() ? 'GITHUB_TOKEN' : 'GH_TOKEN';
        suggestions.push({
            v1Name: key,
            action: 'keep',
            v2Name: key,
            guidance: 'GITHUB_TOKEN/GH_TOKEN remain valid for issue submit and gh-based PR tooling. ' +
                'Prefer GH_TOKEN when using the GitHub CLI.',
        });
    }
    return {
        suggestions,
        detectedCount: suggestions.filter((s) => s.action !== 'keep').length,
        mappableCount: suggestions.filter((s) => s.action === 'map').length,
        manualCount: suggestions.filter((s) => s.action === 'manual').length,
        removableCount: suggestions.filter((s) => s.action === 'remove').length,
        githubTokenPresent,
        caveats: V1_IMPLICIT_DEFAULT_CAVEATS,
    };
}
/** Human-readable report (never prints secret-looking values; only key names + actions). */
export function formatV1EnvTranslationReport(report) {
    const lines = [
        'V1 → V2 env translation (offline, no writes):',
        `  detected_deprecated=${report.detectedCount} map=${report.mappableCount} manual=${report.manualCount} remove=${report.removableCount} github_token=${report.githubTokenPresent ? 'present' : 'absent'}`,
    ];
    for (const caveat of report.caveats ?? [])
        lines.push(`  caveat: ${caveat}`);
    if (report.suggestions.length === 0) {
        lines.push('  (no explicit V1-only knobs detected)');
        return `${lines.join('\n')}\n`;
    }
    for (const s of report.suggestions) {
        if (s.action === 'map') {
            lines.push(`  map  ${s.v1Name} → ${s.v2Name}`);
        }
        else if (s.action === 'manual') {
            lines.push(`  review ${s.v1Name} (manual migration required)`);
        }
        else if (s.action === 'remove') {
            lines.push(`  drop ${s.v1Name} (no V2 resolver)`);
        }
        else {
            lines.push(`  keep ${s.v1Name} (still valid in V2)`);
        }
        lines.push(`       ${s.guidance}`);
    }
    lines.push('  See docs/migration-guide.md and docs/config-env.md § V1 变量不再是 V2 的有效配置.');
    return `${lines.join('\n')}\n`;
}