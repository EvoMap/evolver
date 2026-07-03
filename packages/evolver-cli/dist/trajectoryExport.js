import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, delimiter, dirname, extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { events, ops, trace } from '@evomap/evolver-core';
import { ADAPTERS, adapterForPath, genericChatAdapter, isCursorStateVscdbPath, parseCursorStateVscdb, parseJsonlLines, parseJsonlLinesWithStats, } from '@evomap/evolver-runtime-adapters';
const TRACE_FILE_RE = /(^|[/\\])llm-trace-[^/\\]*\.jsonl$/i;
const RUNTIME_SESSION_ENABLE_ENV = 'EVOLVER_TRAJECTORY_RUNTIME_SESSIONS';
const RUNTIME_SESSION_ENABLE_ENV_LEGACY = 'EVOLVER_TRAJECTORY_EXPORT_RUNTIME_SESSIONS';
const RUNTIME_SESSION_DIRS_ENV = 'EVOLVER_TRAJECTORY_RUNTIME_SESSION_DIRS';
const RUNTIME_SESSION_DIRS_ENV_LEGACY = 'EVOLVER_TRAJECTORY_EXPORT_RUNTIME_SESSION_DIRS';
const RUNTIME_DISCOVERY_AGENTS = new Set(['codex', 'claude-code', 'cursor', 'gemini', 'kimi']);
// Agents whose session files carry NO per-file cwd/workspace marker (Gemini chat: only sessionId+projectHash;
// Kimi wire.jsonl: raw wire log). The workspace-cwd gate (runtimeSessionBelongsToWorkspace) would reject every
// such file because transcriptCwd() returns undefined -> silently dropping ALL real sessions. For these agents
// we skip workspace scoping (the goal of this discovery is broad "采全" collection) and accept .json too, since
// Gemini's older/common session format is `.json`, not `.jsonl`.
const CWDLESS_DISCOVERY_AGENTS = new Set(['gemini', 'kimi']);
// Claude transcripts can carry several meta/preamble records before the first
// record that names the cwd; a 5-line / 4KB window dropped whole sessions when
// the preamble was one line longer than expected. Scan a wider window instead.
const TRANSCRIPT_CWD_HEAD_BYTES = 65536;
const TRANSCRIPT_CWD_MAX_LINES = 50;
// Marker gate (strict by default): the runtime-session discovery链路 only collects a session if evolver itself
// marked it. evolver's SessionStart hook (`evolver inject session-start --hook-stdin`) stamps the runtime
// `session_id` onto a `value.inject` root_event, so root_events.jsonl IS the registry of "sessions evolver
// actively touched". A discovered runtime session is collected only when its session_id ∈ that set. Sessions
// from tools with no hook installed (gemini/kimi), and history predating the hook install, carry no marker and
// are excluded — by design. `--include-unmarked` (or the env below) reopens the legacy "采全" behavior.
const INCLUDE_UNMARKED_ENV = 'EVOLVER_TRAJECTORY_INCLUDE_UNMARKED';
// Second gate (also strict by default): skip a discovered runtime session whose session_id the gateway already
// captured (in ~/.evomap/.../llm-trace-*.jsonl). The proxy extracts the SAME session_id the tool names its
// transcript with, so this de-dupes the two collection rails — the session链路 only fills gateway gaps.
// `--include-gateway-captured` (or the env below) disables this second gate.
const INCLUDE_GATEWAY_CAPTURED_ENV = 'EVOLVER_TRAJECTORY_INCLUDE_GATEWAY_CAPTURED';
function flagValue(arg, name) {
    const prefix = `--${name}=`;
    return arg.startsWith(prefix) ? arg.slice(prefix.length) : undefined;
}
function parseExportFlags(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] ?? '';
        if (arg === '--help' || arg === '-h')
            out.help = true;
        if (arg === '--allow-partial')
            out.allowPartial = true;
        if (arg === '--include-unmarked')
            out.includeUnmarked = true;
        if (arg === '--include-gateway-captured')
            out.includeGatewayCaptured = true;
        if (arg === '--runtime-sessions') {
            out.runtimeSessions = true;
            continue;
        }
        for (const name of ['input', 'output', 'runtime-session-dir', 'node-secret', 'node-secret-file', 'node-secret-env', 'node-secret-keyring', 'hub-private-key']) {
            const inline = flagValue(arg, name);
            if (inline !== undefined) {
                if (name === 'input')
                    out.input = inline;
                else if (name === 'output')
                    out.output = inline;
                else if (name === 'runtime-session-dir')
                    (out.runtimeSessionDirs ??= []).push(inline);
                else if (name === 'node-secret')
                    out.nodeSecret = inline;
                else if (name === 'node-secret-file')
                    out.nodeSecretFile = inline;
                else if (name === 'node-secret-env')
                    out.nodeSecretEnv = inline;
                else if (name === 'node-secret-keyring')
                    out.nodeSecretKeyring = inline;
                else
                    out.hubPrivateKey = inline;
                continue;
            }
            if (arg === `--${name}`) {
                const value = argv[i + 1];
                if (value === undefined || value.startsWith('--'))
                    throw new Error(`missing value for --${name}`);
                if (name === 'input')
                    out.input = value;
                else if (name === 'output')
                    out.output = value;
                else if (name === 'runtime-session-dir')
                    (out.runtimeSessionDirs ??= []).push(value);
                else if (name === 'node-secret')
                    out.nodeSecret = value;
                else if (name === 'node-secret-file')
                    out.nodeSecretFile = value;
                else if (name === 'node-secret-env')
                    out.nodeSecretEnv = value;
                else if (name === 'node-secret-keyring')
                    out.nodeSecretKeyring = value;
                else
                    out.hubPrivateKey = value;
                i++;
            }
        }
    }
    return out;
}
function readSecretFile(path) {
    if (path === undefined)
        return undefined;
    return readFileSync(resolve(path), 'utf8').trim();
}
function readNodeSecretEnv(name) {
    if (name === undefined)
        return undefined;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error('invalid environment variable name for --node-secret-env');
    const secret = String(process.env[name] ?? '').trim();
    if (!secret)
        throw new Error('node secret environment variable is empty or unset');
    return secret;
}
function readNodeSecretKeyring(path) {
    if (!path)
        return undefined;
    const parsed = JSON.parse(readFileSync(resolve(path), 'utf8'));
    if ((parsed && typeof parsed === 'object' && !Array.isArray(parsed)) || Array.isArray(parsed)) {
        return parsed;
    }
    throw new Error('node secret keyring must be a JSON object or array');
}
function defaultNodeSecret() {
    const envSecret = process.env['EVOMAP_NODE_SECRET'] ?? process.env['A2A_NODE_SECRET'];
    if (typeof envSecret === 'string' && envSecret.length > 0)
        return envSecret;
    const home = events.evomapHome();
    for (const file of [join(home, 'node_secret')]) {
        if (existsSync(file))
            return readFileSync(file, 'utf8').trim();
    }
    return undefined;
}
function resolveNodeSecret(flags) {
    const sources = [flags.nodeSecret, flags.nodeSecretFile, flags.nodeSecretEnv].filter((value) => value !== undefined).length;
    if (sources > 1)
        throw new Error('use only one node secret source');
    if (flags.nodeSecretFile !== undefined)
        return readSecretFile(flags.nodeSecretFile);
    if (flags.nodeSecretEnv !== undefined)
        return readNodeSecretEnv(flags.nodeSecretEnv);
    if (flags.nodeSecret !== undefined)
        return existsSync(flags.nodeSecret) ? readSecretFile(flags.nodeSecret) : flags.nodeSecret;
    return defaultNodeSecret();
}
function isJsonCandidate(path) {
    const ext = extname(path).toLowerCase();
    const name = basename(path).toLowerCase();
    return ext === '.json' || ext === '.jsonl' || name === '.json' || name === '.jsonl';
}
function isJsonlCandidate(path) {
    const ext = extname(path).toLowerCase();
    return ext === '.jsonl' || basename(path).toLowerCase() === '.jsonl';
}
function isTraceLikeRow(row) {
    return row['event'] === 'llm_turn'
        || row['prism_compatible'] === true
        || row['encrypted'] === true
        || row['event'] === 'llm_trace_envelope';
}
function traceLikeContent(chunk) {
    return parseJsonlLines(chunk).some(isTraceLikeRow);
}
function adapterForContent(chunk) {
    for (const adapter of [genericChatAdapter, ...ADAPTERS.filter((candidate) => candidate !== genericChatAdapter)]) {
        if (adapter.parse(chunk).some((turn) => turn.isMeta !== true))
            return adapter;
    }
    return undefined;
}
function adapterParsesRuntimeTurns(adapter, chunk) {
    if (adapter.parseSessions)
        return adapter.parseSessions(chunk).some((session) => session.turns.some((turn) => turn.isMeta !== true));
    if (adapter.parseSession)
        return adapter.parseSession(chunk).turns.some((turn) => turn.isMeta !== true);
    return adapter.parse(chunk).some((turn) => turn.isMeta !== true);
}
function truthyEnv(value) {
    if (value === undefined)
        return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
function splitEnvDirs(value) {
    if (!value)
        return [];
    return value.split(delimiter).flatMap((part) => part.split(',')).map((dir) => dir.trim()).filter(Boolean);
}
function cursorGlobalStorageDir(home) {
    return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
}
function cursorGlobalStorageDirs(home) {
    const dirs = [
        cursorGlobalStorageDir(home),
        join(home, '.config', 'Cursor', 'User', 'globalStorage'),
    ];
    const appData = process.env['APPDATA'];
    if (appData)
        dirs.push(join(appData, 'Cursor', 'User', 'globalStorage'));
    return Array.from(new Set(dirs.map((dir) => resolve(dir))));
}
function runtimeHome() {
    return process.env['HOME'] || homedir();
}
function defaultRuntimeSessionDirs() {
    const home = runtimeHome();
    // ~/.gemini/tmp holds per-project <hash>/chats/session-*.{json,jsonl}; the gemini
    // adapter's detect() only matches those session files (never logs.json).
    // Cursor's globalStorage holds state.vscdb (sqlite) — discovered via isCursorStateVscdbPath.
    // ~/.kimi holds Kimi CLI wire.jsonl logs (no per-file cwd) — discovered as a cwd-less agent.
    return [
        join(home, '.codex', 'sessions'),
        join(home, '.claude', 'projects'),
        join(home, '.gemini', 'tmp'),
        join(home, '.kimi'),
        ...cursorGlobalStorageDirs(home),
    ];
}
function runtimeSessionDirs(flags) {
    const dirs = [];
    for (const path of flags.runtimeSessionDirs ?? [])
        dirs.push({ path, required: true });
    for (const path of [
        ...splitEnvDirs(process.env[RUNTIME_SESSION_DIRS_ENV]),
        ...splitEnvDirs(process.env[RUNTIME_SESSION_DIRS_ENV_LEGACY]),
        ...splitEnvDirs(process.env['EVOLVER_CURSOR_TRANSCRIPTS_DIR']),
    ])
        dirs.push({ path, required: true });
    if (flags.runtimeSessions
        || truthyEnv(process.env[RUNTIME_SESSION_ENABLE_ENV])
        || truthyEnv(process.env[RUNTIME_SESSION_ENABLE_ENV_LEGACY])) {
        for (const path of defaultRuntimeSessionDirs())
            dirs.push({ path, required: false });
    }
    const seen = new Set();
    return dirs.filter((dir) => {
        const key = resolve(dir.path);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function assertRuntimeSessionDirBoundary(path) {
    const resolved = resolve(path);
    const home = resolve(runtimeHome());
    const root = resolve(sep);
    if (resolved === root || resolved === home || home.startsWith(`${resolved}${sep}`)) {
        throw new Error(`runtime session directory is too broad: ${resolved}`);
    }
    if (resolved === join(home, '.codex') || resolved === join(home, '.claude') || resolved === join(home, '.gemini')) {
        throw new Error(`runtime session directory must be a session subdirectory: ${resolved}`);
    }
}
function runtimeSessionFileForPath(path) {
    const adapter = adapterForPath(path);
    if (!adapter || !RUNTIME_DISCOVERY_AGENTS.has(adapter.agent))
        return null;
    return { path, kind: 'session', adapter, fromRuntimeDiscovery: true };
}
function readFileHead(path, maxBytes) {
    const fd = openSync(path, 'r');
    try {
        const buffer = Buffer.alloc(maxBytes);
        const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
        return buffer.slice(0, bytesRead).toString('utf8');
    }
    finally {
        closeSync(fd);
    }
}
function transcriptCwd(path) {
    try {
        const head = readFileHead(path, TRANSCRIPT_CWD_HEAD_BYTES);
        for (const line of head.split('\n').slice(0, TRANSCRIPT_CWD_MAX_LINES)) {
            if (!line.trim())
                continue;
            // Parse per line: a truncated final line (the head window may cut JSON
            // mid-record) must not discard a cwd found on an earlier line.
            let row;
            try {
                row = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (!row || typeof row !== 'object' || Array.isArray(row))
                continue;
            const record = row;
            const payload = record['payload'];
            if (record['type'] === 'session_meta' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
                const cwd = payload['cwd'];
                if (typeof cwd === 'string' && cwd.trim())
                    return cwd;
            }
            const cwd = record['cwd'];
            if (typeof cwd === 'string' && cwd.trim())
                return cwd;
            const data = record['data'];
            if (data && typeof data === 'object' && !Array.isArray(data)) {
                const nested = data['cwd'];
                if (typeof nested === 'string' && nested.trim())
                    return nested;
            }
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
function normalizeWorkspacePath(path) {
    if (!path)
        return undefined;
    try {
        const resolved = resolve(path).replace(/[\\/]+$/, '');
        try {
            return realpathSync.native(resolved).replace(/[\\/]+$/, '');
        }
        catch {
            return realpathSync(resolved).replace(/[\\/]+$/, '');
        }
    }
    catch {
        try {
            return resolve(path).replace(/[\\/]+$/, '');
        }
        catch {
            return undefined;
        }
    }
}
function findGitRoot(start) {
    let current = normalizeWorkspacePath(start);
    while (current && current !== dirname(current)) {
        if (existsSync(join(current, '.git')))
            return current;
        current = dirname(current);
    }
    return undefined;
}
function runtimeWorkspaceRoots() {
    const roots = [
        process.env['EVOLVER_REPO_ROOT'],
        process.cwd(),
        findGitRoot(process.cwd()),
    ].map(normalizeWorkspacePath).filter((value) => Boolean(value));
    return Array.from(new Set(roots));
}
function runtimeSessionBelongsToWorkspace(path, roots) {
    const cwd = normalizeWorkspacePath(transcriptCwd(path));
    if (!cwd)
        return false;
    return roots.some((root) => cwd === root || cwd.startsWith(`${root}${sep}`));
}
function inputFileForPath(path, explicit, strictUnknownJson = false) {
    if (TRACE_FILE_RE.test(path))
        return { path, kind: 'trace' };
    // Cursor stores chat in a binary sqlite (state.vscdb), not a JSONL transcript — route it to the
    // dedicated sqlite reader instead of trying to read it as a text chunk.
    if (isCursorStateVscdbPath(path))
        return { path, kind: 'cursor-vscdb' };
    const adapter = adapterForPath(path);
    if (adapter) {
        if (explicit && strictUnknownJson && isJsonCandidate(path)) {
            const chunk = readFileSync(path, 'utf8');
            if (adapterParsesRuntimeTurns(adapter, chunk))
                return { path, kind: 'session', adapter };
            if (traceLikeContent(chunk))
                return { path, kind: 'trace' };
            const contentAdapter = adapterForContent(chunk);
            if (contentAdapter)
                return { path, kind: 'session', adapter: contentAdapter };
            if (isJsonlCandidate(path))
                throw new Error(`trajectory input format is not recognized: ${path}`);
            return null;
        }
        return { path, kind: 'session', adapter };
    }
    if (!explicit || !isJsonCandidate(path))
        return null;
    const chunk = readFileSync(path, 'utf8');
    if (traceLikeContent(chunk))
        return { path, kind: 'trace' };
    const contentAdapter = adapterForContent(chunk);
    if (contentAdapter)
        return { path, kind: 'session', adapter: contentAdapter };
    if (!strictUnknownJson && !isJsonlCandidate(path))
        return null;
    throw new Error(`trajectory input format is not recognized: ${path}`);
}
function collectInputFiles(dir, explicit) {
    const out = [];
    const walk = (current) => {
        for (const name of readdirSync(current).sort()) {
            const path = join(current, name);
            const st = lstatSync(path);
            if (st.isSymbolicLink())
                continue;
            if (st.isDirectory()) {
                walk(path);
                continue;
            }
            if (!st.isFile())
                continue;
            const file = inputFileForPath(path, explicit, false);
            if (file)
                out.push(file);
        }
    };
    walk(dir);
    return out;
}
function collectRuntimeSessionInputFiles(dirs) {
    const out = [];
    const workspaceRoots = runtimeWorkspaceRoots();
    const walk = (current) => {
        let names;
        try {
            names = readdirSync(current).sort();
        }
        catch {
            return;
        }
        for (const name of names) {
            const path = join(current, name);
            let st;
            try {
                st = lstatSync(path);
            }
            catch {
                continue;
            }
            if (st.isSymbolicLink())
                continue;
            if (st.isDirectory()) {
                walk(path);
                continue;
            }
            if (!st.isFile())
                continue;
            // Cursor state.vscdb is a binary sqlite holding many cross-workspace composers; there is no per-file cwd to
            // filter on, so discover it directly (workspace scoping is a no-op for a shared db).
            if (isCursorStateVscdbPath(path)) {
                out.push({ path, kind: 'cursor-vscdb', fromRuntimeDiscovery: true });
                continue;
            }
            // Resolve the adapter first so cwd-less agents (gemini/kimi) can be accepted as .json and bypass the
            // workspace-cwd gate that would otherwise silently drop every one of their files.
            const adapter = adapterForPath(path);
            const cwdless = adapter !== undefined && CWDLESS_DISCOVERY_AGENTS.has(adapter.agent);
            // cwd-less agents may use .json (Gemini) or .jsonl; cwd-bearing agents stay .jsonl-only as before.
            if (cwdless ? !isJsonCandidate(path) : !isJsonlCandidate(path))
                continue;
            // cwd-less agents have no per-file cwd to scope on -> include them broadly; others keep workspace scoping.
            if (!cwdless && !runtimeSessionBelongsToWorkspace(path, workspaceRoots))
                continue;
            const file = runtimeSessionFileForPath(path);
            if (file)
                out.push(file);
        }
    };
    for (const dir of dirs) {
        const root = resolve(dir.path);
        assertRuntimeSessionDirBoundary(root);
        let st;
        try {
            st = lstatSync(root);
        }
        catch {
            if (dir.required)
                throw new Error(`runtime session directory is not readable: ${root}`);
            continue;
        }
        if (st.isSymbolicLink() || !st.isDirectory()) {
            if (dir.required)
                throw new Error(`runtime session directory is not readable: ${root}`);
            continue;
        }
        walk(root);
    }
    return out;
}
function dedupeInputFiles(files) {
    const seen = new Set();
    return files.filter((file) => {
        const key = resolve(file.path);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function inputFiles(input, runtimeDirs) {
    const target = input ? resolve(input) : events.tracesDir();
    let files;
    if (!existsSync(target)) {
        if (input !== undefined)
            throw new Error(`trace input is not readable: ${target}`);
        files = [];
    }
    else {
        const st = statSync(target);
        if (st.isFile()) {
            const file = inputFileForPath(target, true, true);
            files = file ? [file] : [];
        }
        else if (st.isDirectory()) {
            if (input === undefined) {
                files = readdirSync(target)
                    .filter((name) => TRACE_FILE_RE.test(name))
                    .sort()
                    .flatMap((name) => {
                    const path = join(target, name);
                    try {
                        const item = lstatSync(path);
                        return item.isFile() ? [{ path, kind: 'trace' }] : [];
                    }
                    catch {
                        return [];
                    }
                });
            }
            else {
                files = collectInputFiles(target, true);
                if (files.length === 0)
                    throw new Error(`trajectory input format is not recognized: ${target}`);
            }
        }
        else {
            if (input !== undefined)
                throw new Error(`trace input is not readable: ${target}`);
            files = [];
        }
    }
    return dedupeInputFiles([...files, ...collectRuntimeSessionInputFiles(runtimeDirs)]);
}
// ── marker / gateway gates ───────────────────────────────────────────────────
/** Set of runtime session_ids evolver has marked, read from `value.inject` root_events (the SessionStart hook
 *  stamps the runtime session_id onto each). Mirrors recall.ts: a runtime session is "marked" iff its session_id
 *  appears here. Best-effort: a missing/unreadable root_events log yields an empty set (strict mode then collects
 *  nothing — the caller can still pass --include-unmarked to bypass the gate). */
function markedSessionIds() {
    const out = new Set();
    try {
        for (const e of events.readEvents()) {
            if (e.type !== ops.VALUE_INJECT_EVENT)
                continue;
            const sid = e.payload?.['sessionId'];
            addSessionIdAliases(out, sid);
        }
    }
    catch {
        /* no root_events / unreadable → empty set */
    }
    return out;
}
const CLAUDE_USER_SESSION_MARKER = '__session_';
function sessionIdAliases(value) {
    if (typeof value !== 'string')
        return [];
    const raw = value.trim();
    if (!raw)
        return [];
    const aliases = [raw];
    const marker = raw.indexOf(CLAUDE_USER_SESSION_MARKER);
    if (marker >= 0) {
        const sessionId = raw.slice(marker + CLAUDE_USER_SESSION_MARKER.length).trim();
        if (sessionId)
            aliases.push(sessionId);
    }
    return Array.from(new Set(aliases));
}
function addSessionIdAliases(out, value) {
    for (const alias of sessionIdAliases(value))
        out.add(alias);
}
/** Set of session_ids the gateway already captured, read from the proxy's llm-trace-*.jsonl day files. The proxy
 *  extracts the SAME session_id the tool names its transcript with (Claude metadata.user_id / cursor headers), so
 *  these align with runtime-session session_ids and can de-dupe the two rails. Decryption uses the same node-secret
 *  material the trace链路 already resolves; rows that stay encrypted simply contribute no session_id (they cannot
 *  collide with a plaintext runtime session_id anyway). */
function gatewayCapturedSessionIds(tracesDir, readOpts) {
    const out = new Set();
    try {
        if (!existsSync(tracesDir))
            return out;
        const st = statSync(tracesDir);
        if (!st.isDirectory())
            return out;
        for (const name of readdirSync(tracesDir).sort()) {
            if (!TRACE_FILE_RE.test(name))
                continue;
            const path = join(tracesDir, name);
            try {
                if (lstatSync(path).isSymbolicLink())
                    continue;
                const chunk = readFileSync(path, 'utf8');
                const result = trace.readTraceRowsFromJsonl(chunk, readOpts);
                for (const row of result.rows) {
                    const sid = row['session_id'] ?? row['sessionId'];
                    addSessionIdAliases(out, sid);
                }
            }
            catch {
                /* skip an unreadable / malformed trace file */
            }
        }
    }
    catch {
        /* traces dir vanished mid-scan → whatever we collected */
    }
    return out;
}
/** Resolve the session_id a discovered runtime session file will be keyed on, WITHOUT a full parse — mirrors
 *  recall.ts/sessionMetadata: codex names the id inside session_meta.payload.id, every other transcript is named
 *  `<session_id>.<ext>` so the basename (minus extension) is the id. cursor-vscdb is special-cased by the caller
 *  (its session_id is per-composer, resolved at parse time), so it never reaches here. */
function runtimeSessionIdForFile(file) {
    if (file.adapter?.agent === 'codex') {
        try {
            const head = readFileHead(file.path, TRANSCRIPT_CWD_HEAD_BYTES);
            for (const line of head.split('\n').slice(0, TRANSCRIPT_CWD_MAX_LINES)) {
                if (!line.trim())
                    continue;
                let row;
                try {
                    row = JSON.parse(line);
                }
                catch {
                    continue;
                }
                if (!row || typeof row !== 'object' || Array.isArray(row))
                    continue;
                const record = row;
                if (record['type'] === 'session_meta' && record['payload'] && typeof record['payload'] === 'object' && !Array.isArray(record['payload'])) {
                    const id = record['payload']['id'];
                    if (typeof id === 'string' && id.length > 0)
                        return id;
                }
            }
        }
        catch {
            /* fall through to basename */
        }
    }
    const base = basename(file.path).replace(/\.jsonl?$/i, '').replace(/\.json$/i, '');
    return base.length > 0 ? base : undefined;
}
/** Decide whether a discovered runtime session (by its session_id) passes the marker + gateway gates. Files that
 *  did NOT come from runtime discovery (explicit --input) always pass — the gates are scoped to discovery only. */
function passesRuntimeGates(sessionId, marked, gatewayCaptured, flags) {
    if (!flags.includeUnmarked) {
        if (sessionId === undefined || !marked.has(sessionId))
            return { collect: false, reason: 'unmarked' };
    }
    if (!flags.includeGatewayCaptured && sessionId !== undefined && gatewayCaptured.has(sessionId)) {
        return { collect: false, reason: 'gateway_captured' };
    }
    return { collect: true };
}
function sessionMetadata(file, chunk, sourceAgent) {
    const rows = parseJsonlLines(chunk);
    const started = rows.find((row) => typeof row['timestamp'] === 'string')?.['timestamp'];
    if (sourceAgent === 'codex') {
        const meta = rows.find((row) => row['type'] === 'session_meta' && row['payload'] && typeof row['payload'] === 'object');
        const payload = meta?.['payload'];
        const id = payload && typeof payload['id'] === 'string' ? payload['id'] : undefined;
        return { ...(id ? { sessionId: id } : {}), ...(typeof started === 'string' ? { startedAt: started } : {}) };
    }
    const fallback = basename(file).replace(/\.jsonl?$/i, '').replace(/\.json$/i, '');
    return { ...(fallback ? { sessionId: fallback } : {}), ...(typeof started === 'string' ? { startedAt: started } : {}) };
}
function parseRuntimeSessions(adapter, chunk) {
    if (adapter.parseSessions)
        return adapter.parseSessions(chunk);
    if (adapter.parseSession)
        return [adapter.parseSession(chunk)];
    return [{ turns: adapter.parse(chunk) }];
}
function usage() {
    return [
        '用法: evolver trajectory-export [--input <trace-or-session-file-or-dir>] [--output <jsonl>] [--allow-partial]',
        '  --input <path>               支持 llm-trace JSONL，以及 Claude/Codex/Cursor session JSONL',
        '  --runtime-sessions           同时扫描本机 ~/.codex/sessions、~/.claude/projects、~/.gemini/tmp、~/.kimi 与 Cursor state.vscdb（仅本地导出，不上传 Hub）',
        '  --runtime-session-dir <dir>  额外扫描一个明确的本机 runtime session 目录；可重复',
        '  --include-unmarked           关闭“标记闸门”：默认严格模式只采 evolver 主动标记过的会话（root_events.jsonl 的 value.inject 事件里有该 sessionId）；',
        '                               加此开关恢复旧的“采全”行为。等价 env EVOLVER_TRAJECTORY_INCLUDE_UNMARKED=1。仅作用于 runtime-session 发现链路。',
        '  --include-gateway-captured   关闭“去重闸门”：默认跳过网关（llm-trace-*.jsonl）已采集的同 session_id 会话，只补网关漏的；',
        '                               加此开关一并采集网关已采的会话。等价 env EVOLVER_TRAJECTORY_INCLUDE_GATEWAY_CAPTURED=1。仅作用于 runtime-session 发现链路。',
        '  --node-secret <hex|file>      解密 node-secret trace envelope；默认读 env 或 ~/.evomap/node_secret',
        '  --node-secret-file <file>     从文件读取 node secret（v1 兼容）',
        '  --node-secret-env <name>      从环境变量读取 node secret（v1 兼容）',
        '  --node-secret-keyring <json>  按 envelope.secret_version 选择 node secret；支持对象或数组格式',
        '  --hub-private-key <file>      解密带 hub_key_envelope 的 trace envelope',
    ].join('\n') + '\n';
}
function writeOutputAtomically(output, trajectories) {
    try {
        const st = lstatSync(output);
        if (st.isDirectory())
            throw new Error(`trajectory output path is a directory: ${output}`);
    }
    catch (err) {
        const code = err.code;
        if (code !== 'ENOENT')
            throw err;
    }
    const tmp = `${output}.tmp-${process.pid}-${Date.now()}`;
    const fd = openSync(tmp, 'wx', 0o600);
    let closed = false;
    try {
        for (const trajectory of trajectories) {
            writeSync(fd, `${JSON.stringify(trajectory)}\n`);
        }
    }
    catch (err) {
        closeSync(fd);
        closed = true;
        try {
            unlinkSync(tmp);
        }
        catch { /* ignore cleanup failure */ }
        throw err;
    }
    finally {
        if (!closed)
            closeSync(fd);
    }
    try {
        renameSync(tmp, output);
    }
    catch (err) {
        try {
            unlinkSync(tmp);
        }
        catch { /* ignore cleanup failure */ }
        throw err;
    }
}
export async function runTrajectoryExport(argv) {
    let flags;
    try {
        flags = parseExportFlags(argv);
    }
    catch (err) {
        process.stderr.write(`trajectory-export failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    }
    if (flags.help) {
        process.stdout.write(usage());
        return 0;
    }
    const output = resolve(flags.output ?? 'coding-trajectories.jsonl');
    const allRows = [];
    const sessionTrajectories = [];
    const stats = {
        rowsScanned: 0,
        rowsRead: 0,
        invalidJson: 0,
        encryptedRows: 0,
        skippedMissingSecret: 0,
        decryptFailures: 0,
        nonTraceSkipped: 0,
    };
    let files = [];
    let sessionFileCount = 0;
    let sessionTurnCount = 0;
    let excludedUnmarked = 0;
    let excludedGatewayCaptured = 0;
    const discoveredRuntimeDirs = runtimeSessionDirs(flags);
    try {
        files = inputFiles(flags.input, discoveredRuntimeDirs);
        const readOpts = {
            allowPartial: flags.allowPartial,
            nodeSecret: resolveNodeSecret(flags),
            nodeSecretKeyring: readNodeSecretKeyring(flags.nodeSecretKeyring),
            hubPrivateKey: readSecretFile(flags.hubPrivateKey),
        };
        // Strict by default: the marker + gateway gates apply to the runtime-session discovery链路 only. Build the
        // gate sets once. Both sets stay empty (and the gates are skipped) when nothing is discovered, so an explicit
        // single-file --input export never pays for reading root_events / the trace dir.
        const hasRuntimeDiscovery = files.some((file) => file.fromRuntimeDiscovery);
        const gateFlags = {
            includeUnmarked: flags.includeUnmarked === true || truthyEnv(process.env[INCLUDE_UNMARKED_ENV]),
            includeGatewayCaptured: flags.includeGatewayCaptured === true || truthyEnv(process.env[INCLUDE_GATEWAY_CAPTURED_ENV]),
        };
        const marked = hasRuntimeDiscovery && !gateFlags.includeUnmarked ? markedSessionIds() : new Set();
        const gatewayCaptured = hasRuntimeDiscovery && !gateFlags.includeGatewayCaptured
            ? gatewayCapturedSessionIds(events.tracesDir(), { ...readOpts, allowPartial: true })
            : new Set();
        for (const file of files) {
            if (file.kind === 'cursor-vscdb') {
                // Read Cursor chat out of the sqlite db (read-only) and convert each composer to a trajectory. The
                // marker/gateway gates run PER COMPOSER here (each composerId is its own session_id), so a state.vscdb
                // holding many composers contributes only the ones evolver marked (and not already gateway-captured).
                for (const parsedSession of parseCursorStateVscdb(file.path)) {
                    const { turns, ...adapterMetadata } = parsedSession;
                    if (file.fromRuntimeDiscovery) {
                        const composerSessionId = typeof adapterMetadata.sessionId === 'string' ? adapterMetadata.sessionId : undefined;
                        const gate = passesRuntimeGates(composerSessionId, marked, gatewayCaptured, gateFlags);
                        if (!gate.collect) {
                            if (gate.reason === 'unmarked')
                                excludedUnmarked += 1;
                            else
                                excludedGatewayCaptured += 1;
                            continue;
                        }
                    }
                    sessionTurnCount += turns.length;
                    const trajectory = trace.buildCodingTrajectoryFromSessionLog({
                        sourceAgent: 'cursor',
                        sourcePath: file.path,
                        turns,
                        ...adapterMetadata,
                    });
                    if (trajectory) {
                        sessionFileCount += 1;
                        sessionTrajectories.push(trajectory);
                    }
                }
                continue;
            }
            // Marker/gateway gates for file-per-session runtime discovery (claude/codex/cursor-jsonl/gemini/kimi).
            // Resolved from the session_id without a full parse (basename / codex session_meta.payload.id).
            if (file.fromRuntimeDiscovery) {
                const gate = passesRuntimeGates(runtimeSessionIdForFile(file), marked, gatewayCaptured, gateFlags);
                if (!gate.collect) {
                    if (gate.reason === 'unmarked')
                        excludedUnmarked += 1;
                    else
                        excludedGatewayCaptured += 1;
                    continue;
                }
            }
            const chunk = readFileSync(file.path, 'utf8');
            if (file.kind === 'trace') {
                const result = trace.readTraceRowsFromJsonl(chunk, readOpts);
                allRows.push(...result.rows);
                for (const key of Object.keys(stats))
                    stats[key] += result.stats[key];
                continue;
            }
            const adapter = file.adapter ?? adapterForPath(file.path);
            if (!adapter)
                continue;
            const parseStats = parseJsonlLinesWithStats(chunk).stats;
            stats.rowsScanned += parseStats.rowsScanned;
            stats.rowsRead += parseStats.rowsRead;
            stats.invalidJson += parseStats.invalidJson;
            const metadata = sessionMetadata(file.path, chunk, adapter.agent);
            for (const parsedSession of parseRuntimeSessions(adapter, chunk)) {
                const { turns, ...adapterMetadata } = parsedSession;
                sessionTurnCount += turns.length;
                const trajectory = trace.buildCodingTrajectoryFromSessionLog({
                    sourceAgent: adapter.agent,
                    sourcePath: file.path,
                    turns,
                    ...(parseStats.invalidJson > 0 ? { incompleteReasons: ['runtime_session_invalid_json'] } : {}),
                    ...metadata,
                    ...adapterMetadata,
                });
                if (trajectory) {
                    sessionFileCount += 1;
                    sessionTrajectories.push(trajectory);
                }
            }
        }
    }
    catch (err) {
        process.stderr.write(`trajectory-export failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    }
    const trajectories = sessionTrajectories.concat(trace.buildCodingTrajectories(allRows));
    try {
        writeOutputAtomically(output, trajectories);
    }
    catch (err) {
        process.stderr.write(`trajectory-export failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    }
    process.stdout.write(`[trajectory-export] Wrote ${trajectories.length} trajector${trajectories.length === 1 ? 'y' : 'ies'} to ${output}\n`);
    if (discoveredRuntimeDirs.length > 0)
        process.stdout.write('[trajectory-export] Runtime session discovery is local-only; no Hub upload is performed.\n');
    process.stdout.write(`[trajectory-export] Read ${allRows.length} trace row(s) and ${sessionTurnCount} session turn(s) from ${files.length} file(s).\n`);
    if (sessionFileCount > 0)
        process.stdout.write(`[trajectory-export] Converted ${sessionFileCount} runtime session file(s).\n`);
    if (excludedUnmarked > 0 || excludedGatewayCaptured > 0) {
        process.stdout.write(`[trajectory-export] Runtime session gate: excluded ${excludedUnmarked} unmarked (no evolver value.inject) and ${excludedGatewayCaptured} already-gateway-captured session(s). Pass --include-unmarked / --include-gateway-captured to collect them.\n`);
    }
    process.stdout.write(`[trajectory-export] Scanned ${stats.rowsScanned} row(s); encrypted=${stats.encryptedRows}, skipped_missing_secret=${stats.skippedMissingSecret}, decrypt_failures=${stats.decryptFailures}, invalid_json=${stats.invalidJson}, non_trace=${stats.nonTraceSkipped}.\n`);
    return 0;
}