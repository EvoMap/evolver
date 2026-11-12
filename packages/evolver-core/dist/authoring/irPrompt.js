import { SESSION_GENE_IR_VERSION, recordLinesOf } from '../hub/sessionGeneIr.js';
import { redactString } from '../hub/sanitize.js';
export const IR_KINDS = ['fix', 'change', 'investigate', 'configure', 'refactor'];
const MAX_IRS = 2;
const SIGNAL_MAX_CHARS = 64;
const UNCONFIRMED_CAUSE = 'not confirmed by the record';
const FIELDS = [
    '- title: the capability\'s name, at most 80 characters.',
    '- capability_summary: what was solved and under which conditions, 40 to 600 characters.',
    `- kind: one of ${IR_KINDS.join(', ')}. Keep the default below unless the record plainly shows another kind; choose`,
    '  refactor only when behaviour stayed the same, and then name the evidence it did and the boundary of the change.',
    `- scope.signals: 5 to 12 distinct triggers another agent would meet (error text, symptom, task phrase), each at most ${SIGNAL_MAX_CHARS} characters.`,
    '- scope.use_when: 0 to 6 situations it fits. scope.do_not_use_when: 1 to 6 situations where it must not be used.',
    '- preconditions: 1 to 8 things that must hold before the first step.',
    '- procedure: 2 to 12 steps, each {"action": "<one imperative step, at most 400 characters>", "refs": ["R12", "R14-R18"]}.',
    '  The first step is the first thing to do.',
    '- failure_repairs: 0 to 6 items {"signal", "cause", "response", "verification", "refs"}: an observed failure, its',
    `  cause (exactly "${UNCONFIRMED_CAUSE}" when the record does not confirm one), what fixed it and how that was verified.`,
    '- canonical_contracts: 0 to 6 items {"kind": "command" | "api" | "config", "applies_when", "exemplar", "refs"}: exact',
    '  syntax worth keeping as it is.',
    '- project_notes: 0 to 8 facts true only of this project (its directories, script names, variables, fields), at most',
    '  300 characters each. They stay on this machine.',
    '- unknowns: 0 to 8 things the record did not confirm, at most 300 characters each.',
    '- portability: {"class": "portable" | "project_bound", "bound_identifiers": [...]}; project_bound lists the',
    '  identifiers it depends on.',
];
const RULES = [
    '1. Every procedure step, failure repair and contract cites the record lines it rests on in refs, as R<n> or',
    '   R<a>-R<b>. Cite only lines that exist.',
    '2. A contract\'s exemplar is copied from a line it cites, character for character: a part of that line\'s text.',
    '3. When a check failed and the same check later passed (an error episode, with or without edits between), write at',
    '   least one failure_repairs item whose refs include that failed check line and whose signal is the failure the check printed.',
    '4. Write roles, not names: "the project\'s test entry point", not a script path; "the config loader", not its file.',
    '   This project\'s directories, file names, variables, functions and fields go into project_notes, not into the',
    '   summary, scope, preconditions, procedure or failure_repairs: no project path there, at most two of its names.',
    '5. Give at least one do_not_use_when.',
    '6. Declare portability: portable when another project could follow it as written; project_bound, with the',
    '   identifiers it needs, when it only makes sense here.',
    `7. Invent nothing: no cause, test or verification the record does not show. A cause the record does not confirm is`,
    `   written as "${UNCONFIRMED_CAUSE}", and what is in doubt goes into unknowns. Never include secrets, absolute`,
    '   paths or the values of the final answer.',
];
const SUPPLEMENTS = {
    fix: [
        'This record fixes an error: a check failed, files were edited, and the same check passed.',
        '- Keep the symptom apart from the cause. The symptom is what the failed check printed (cite its check and output',
        '  lines); the cause is what the edits show was wrong. Where the record does not confirm it, the cause is',
        `  "${UNCONFIRMED_CAUSE}" and the suspected cause goes into unknowns.`,
        '- Every failure_repairs item answers a failure the record shows: its signal is that failure\'s own text, its refs include',
        '  the failed check line, its verification is the later passing run of that check.',
        '- scope.signals start with the observed error text, shortened to what another project would also print.',
        '- Do not claim a regression test was added unless an edit line shows one.',
    ],
    change: [
        'This record changes behaviour: files were edited and checks ran, with no error fixed on the way.',
        '- Acceptance rests on the observed checks: name what they proved, not what you expect.',
        '- The procedure describes the change as a pattern another project can apply, in the order it was done.',
        '- Commands worth repeating exactly (the check that proved it, a generator, a migration) go into',
        '  canonical_contracts with their record line.',
        '- do_not_use_when names the setups where this change would be wrong or unnecessary.',
    ],
    investigate: [
        'This record investigates: commands and checks ran, but no file was edited.',
        '- Record how the search was narrowed: which command ruled out what, in order.',
        '- List the hypotheses the record ruled out, and keep those it did not settle in unknowns.',
        '- Do not claim anything was fixed: nothing was edited.',
        '- A command that revealed the answer belongs in canonical_contracts, copied from its line.',
    ],
    refactor: [
        'This record refactors: the structure changed while the behaviour stayed the same.',
        '- Name the evidence that behaviour stayed the same: the checks that passed before and after the change.',
        '- State the boundary of the change: what was restructured and what was deliberately left alone.',
        '- Do not describe new behaviour; if the record shows behaviour changed, choose change instead.',
    ],
    configure: [
        'This record configures: only configuration, manifest or CI files were edited.',
        '- The exact configuration syntax that made the check pass goes into canonical_contracts (kind config), copied',
        '  verbatim from its record line.',
        '- Differences between environments (OS, tool versions, CI runner, package manager) go into do_not_use_when.',
        '- preconditions name the tool and version range the configuration assumes, where the record shows them.',
    ],
};
const CONFIG_FILE = new RegExp([
    '(?:^|/)\\.(?:github|gitlab|circleci|husky|devcontainer)/',
    '(?:^|/)(?:package(?:-lock)?\\.json|npm-shrinkwrap\\.json|pnpm-(?:lock|workspace)\\.yaml|yarn\\.lock|bun\\.lockb?)$',
    '(?:^|/)(?:tsconfig|jsconfig)[\\w.-]*\\.json$',
    '(?:^|/)(?:pyproject\\.toml|setup\\.(?:cfg|py)|requirements[\\w.-]*\\.txt|Pipfile(?:\\.lock)?|poetry\\.lock|uv\\.lock|tox\\.ini)$',
    '(?:^|/)(?:Cargo\\.(?:toml|lock)|go\\.(?:mod|sum)|Gemfile(?:\\.lock)?|pom\\.xml|build\\.gradle(?:\\.kts)?|settings\\.gradle(?:\\.kts)?)$',
    '(?:^|/)(?:Makefile|Dockerfile[\\w.-]*|docker-compose[\\w.-]*\\.ya?ml|compose\\.ya?ml|\\.gitlab-ci\\.yml|\\.gitignore|\\.dockerignore)$',
    '(?:^|/)\\.(?:eslintrc|prettierrc|babelrc|editorconfig|npmrc|nvmrc|node-version|python-version|tool-versions)[\\w.-]*$',
    '(?:^|/)[\\w-]+\\.config\\.[cm]?[jt]s$',
    '\\.(?:ya?ml|toml|ini|cfg|conf)$',
].join('|'));
function checkLabel(line) {
    const exit = Number.isInteger(line.exit) ? `exit ${line.exit}` : 'no exit code';
    if (line.failed === true)
        return `check (failed, ${exit})`;
    return Number.isInteger(line.exit) ? `check (${exit})` : 'check (passed, no exit code)';
}
/** One record line as the model reads it: `R<n> <kind>: <text>`. */
function renderRecordLine(line, index) {
    return `R${index + 1} ${line.kind === 'check' ? checkLabel(line) : line.kind}: ${line.text}`;
}
const failedCheck = (line) => line.kind === 'check' && (line.failed === true || (typeof line.exit === 'number' && line.exit !== 0));
const checkKey = (line) => line.text.trim().replace(/\s+2>&1$/, '');
/**
 * The record's default kind, decided from the record alone; `refactor` is left for the model to choose. `fix` needs an
 * edit between the failed check and its passing rerun: a rerun that passes untouched is a flaky check, not a fix.
 */
function defaultIrKind(record) {
    const failed = new Set();
    const editedAfterFailure = new Set();
    for (const line of record) {
        if (line.kind === 'edit')
            failed.forEach((key) => editedAfterFailure.add(key));
        if (line.kind !== 'check')
            continue;
        const key = checkKey(line);
        if (failedCheck(line))
            failed.add(key);
        else if (editedAfterFailure.has(key))
            return 'fix';
        else
            failed.delete(key);
    }
    const edited = record.filter((line) => line.kind === 'edit').map((line) => line.text);
    if (edited.length === 0)
        return 'investigate';
    return edited.every((path) => CONFIG_FILE.test(path)) ? 'configure' : 'change';
}
const FAILED_SUPPLEMENT = [
    '',
    '## Outcome: failed',
    'The work in this record did not reach a passing result. The IR is kept as a warning for the next agent, not as a',
    'method to follow: write the approach that was tried as the procedure, a failure_repairs item only for a failure that a',
    'later check shows was overcome, and what stayed unresolved in unknowns. Do not claim anything was fixed.',
];
/**
 * The `session-gene-ir-v1` prompt with the record numbered R1…Rn; the model answers 0 to MAX_IRS IR objects, one per
 * unrelated task, or a skip. A failed outcome asks for the attempt as a warning rather than a method.
 */
export function irPrompt(request = {}) {
    const records = recordLinesOf(request.records);
    const kind = request.kind ?? (records.length > 0 ? defaultIrKind(records) : 'change');
    const focus = redactString(String(request.focus ?? '')).trim();
    return [
        `Evolver distillation, prompt ${SESSION_GENE_IR_VERSION}. Do not continue the task and do not address the person.`,
        'Below is the record of work an agent did in one session, proved by checks the host saw run. Turn it into reusable',
        'method knowledge: what another agent should do on a similar task in a different project.',
        ...(focus ? [`Focus on: ${focus}`] : []),
        `Answer with JSON only: an array of 0 to ${MAX_IRS} objects in the fields below, one per unrelated task (most`,
        'sessions hold one), or {"skip": "<why, in one sentence>"} when the record holds no method another agent would',
        'gain from (routine edits, a lookup, small talk).',
        '',
        `## Fields (${SESSION_GENE_IR_VERSION})`,
        ...FIELDS,
        '',
        '## Rules',
        ...RULES,
        '',
        `## Kind: ${kind} (the default for this record)`,
        ...SUPPLEMENTS[kind],
        ...(request.outcome === 'failed' ? FAILED_SUPPLEMENT : []),
        '',
        '## Record',
        ...records.map(renderRecordLine),
    ].join('\n');
}
const text = (minLength, maxLength) => ({ type: 'string', minLength, maxLength });
const list = (items, minItems, maxItems) => ({ type: 'array', items, minItems, maxItems });
const REFS = list({ type: 'string', pattern: '^R\\d+(?:-R\\d+)?$' }, 1, 12);
/** JSON Schema (draft-07) of one IR object, mirroring the bounds `checkSessionGeneIr` enforces. */
export const IR_OUTPUT_SCHEMA = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `https://evomap.ai/schemas/${SESSION_GENE_IR_VERSION}.json`,
    title: SESSION_GENE_IR_VERSION,
    type: 'object',
    required: ['title', 'capability_summary', 'kind', 'scope', 'preconditions', 'procedure', 'portability'],
    properties: {
        title: text(1, 80),
        capability_summary: text(40, 600),
        kind: { type: 'string', enum: [...IR_KINDS] },
        scope: {
            type: 'object',
            required: ['signals', 'do_not_use_when'],
            properties: {
                signals: { ...list(text(1, SIGNAL_MAX_CHARS), 5, 12), uniqueItems: true },
                use_when: list(text(1, 300), 0, 6),
                do_not_use_when: list(text(1, 300), 1, 6),
            },
        },
        preconditions: list(text(1, 300), 1, 8),
        procedure: list({ type: 'object', required: ['action', 'refs'], properties: { action: text(1, 400), refs: REFS } }, 2, 12),
        failure_repairs: list({ type: 'object', required: ['signal', 'cause', 'response', 'verification', 'refs'], properties: {
                signal: text(1, 400), cause: text(1, 400), response: text(1, 400), verification: text(1, 400), refs: REFS,
            } }, 0, 6),
        canonical_contracts: list({ type: 'object', required: ['kind', 'applies_when', 'exemplar', 'refs'], properties: {
                kind: { type: 'string', enum: ['command', 'api', 'config'] }, applies_when: text(1, 300), exemplar: text(1, 600), refs: REFS,
            } }, 0, 6),
        project_notes: list(text(1, 300), 0, 8),
        unknowns: list(text(1, 300), 0, 8),
        portability: {
            type: 'object',
            required: ['class', 'bound_identifiers'],
            properties: {
                class: { type: 'string', enum: ['portable', 'project_bound'] },
                bound_identifiers: list(text(1, 200), 0, 12),
            },
        },
    },
});
const { $schema: _schema, $id: _id, ...IR_OBJECT } = IR_OUTPUT_SCHEMA;
/** The whole answer the prompt asks for, self-contained: up to MAX_IRS IR objects, or a one-sentence skip. */
export const IR_ANSWER_SCHEMA = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    oneOf: [
        { type: 'array', maxItems: MAX_IRS, items: IR_OBJECT },
        { type: 'object', required: ['skip'], properties: { skip: { type: 'string' } }, additionalProperties: false },
    ],
});