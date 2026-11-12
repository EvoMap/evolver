import { evaluateGate, normalizeConversationInput } from '../hub/conversationDistiller.js';
import { portabilityFindings } from '../hub/projectTerms.js';
import { sanitizeBundle } from '../hub/sanitize.js';
import { sanitizeExecutionCommand } from '../verify/executionRedaction.js';
import { validationCommandRejection } from '../verify/validationCommandPolicy.js';
import { geneSchemaErrors, generationMetaErrors } from './geneBuild.js';
import { DO_NOT_USE_WHEN, USE_WHEN } from './geneMarkdown.js';
import { say } from './locale.js';
export const GENE_LINT_RULES_VERSION = 'gene-lint.v1';
const MIN_SUMMARY_CHARS = 40;
const MAX_STEPS = 10;
const MIN_SIGNALS = 2;
const MAX_SIGNALS = 8;
const GENERIC_SIGNALS = new Set(['bug', 'bugs', 'fix', 'fixes', 'error', 'errors', 'issue', 'issues', 'problem', 'problems', 'code', 'debug',
    'failure', 'broken', '代码', '问题', '错误', '修复', '报错', '故障', '调试', 'bug修复']);
const NOT_ACTIONABLE = /^(?:注意|尽量|记得|小心|最好|建议|务必小心|be careful|try to|remember|keep in mind|ideally|note[:：]|note that|make sure to be)/i;
const UNSAFE_REJECTIONS = new Set(['credential', 'command_substitution', 'shell_metacharacters']);
const SHELL = String.raw `(?:[\w.~-]*\/)*(?:ba|z|da|k)?sh\b`;
const DOWNLOAD = String.raw `(?:[\w.~-]*\/)*(?:curl|wget)\b`;
const INTERPRETER = String.raw `(?:[\w.~-]*\/)*(?:python[\d.]*|node(?:js)?|ruby|perl|php)\b`;
const OPTIONS = String.raw `(?:\s+--?\w[\w-]*(?:=\S+)?)*`;
const GIT_OPTIONS = String.raw `(?:\s+--?\w[\w-]*(?:[= ][^\s-]\S*)?)*`;
const DANGEROUS_COMMANDS = [
    new RegExp(String.raw `(?:\b(?:${SHELL}|${INTERPRETER})(?:\s+-\w+)*|\beval|\bsource|(?:^|[\s;&|(` + '`' + String.raw `])\.)\s+["']?(?:\$\(|<\()\s*${DOWNLOAD}`, 'i'),
    new RegExp(String.raw `(?:^|[;&|` + '`' + String.raw `]|\b(?:then|do)\b)\s*["']?\$\(\s*${DOWNLOAD}`, 'i'),
    new RegExp(String.raw `\bchmod${OPTIONS}\s+(?:0?777|a\+rwx|ugo\+rwx)\b`, 'i'),
    new RegExp(String.raw `\bgit${GIT_OPTIONS}\s+push\b[^\n]*(?:--force\b|\s-f\b|--force-with-lease\b|\s\+\S)`, 'i'),
    /(?:^|[\s;&|(`$])["']?(?:[\w.~-]*\/)*sudo["']?\s/i,
    new RegExp(String.raw `\bgit${GIT_OPTIONS}\s+config\b[^\n]*--(?:global|system)\b`, 'i'),
    new RegExp(String.raw `\bp?npm${OPTIONS}\s+(?:config${OPTIONS}\s+)?set(?![\w-])`, 'i'),
    />>?\s*~?\/?(?:\$HOME\/)?\.(?:bashrc|zshrc|profile|bash_profile|gitconfig|npmrc)\b/i,
    />>?\s*\/etc\//i,
];
const DOWNLOAD_PIPE = /\b(?:curl|wget)\b[^|\n]*\|(?!\|)([^|;&\n]*)/gi;
const SHELL_WORD = /^(?:(?:[\w.~-]*\/)*(?:ba|z|da|k)?sh|\$\{?SHELL\}?)$/i;
const INTERPRETER_WORD = /^(?:[\w.~-]*\/)*(?:python[\d.]*|node(?:js)?|ruby|perl|php)$/i;
const COMMAND_WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'time']);
const WRAPPER_VALUE_OPTIONS = new Set(['-u', '-g', '-C', '-D', '-h', '--user', '--group']);
const INTERPRETER_VALUE_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-W', '-X', '-I', '-M']);
const STDIN_PATH = /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;
const INLINE_PROGRAM = /^(?:-[a-zA-Z]*[cemEnp][a-zA-Z]*|--(?:eval|print|module|command)(?:=.*)?)$/;
/** The command the receiving side of a pipe runs, past `sudo -u root`, `env X=1` and similar prefixes. */
function receivingCommand(words) {
    for (let index = 0; index < words.length; index += 1) {
        const word = words[index];
        if (COMMAND_WRAPPERS.has(word.replace(/^.*\//, '')) || /^[A-Za-z_]\w*=/.test(word))
            continue;
        if (word.startsWith('-')) {
            if (WRAPPER_VALUE_OPTIONS.has(word))
                index += 1;
            continue;
        }
        return { command: word, args: words.slice(index + 1) };
    }
    return null;
}
/** `python3`, `node -`, `perl /dev/stdin`: no script file and no inline program, so the program itself comes from stdin. */
function readsProgramFromStdin(args) {
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (STDIN_PATH.test(arg))
            return true;
        if (!arg.startsWith('-') || INLINE_PROGRAM.test(arg))
            return false;
        if (INTERPRETER_VALUE_OPTIONS.has(arg))
            index += 1;
    }
    return true;
}
/** A download piped into a shell anywhere in the receiving command, or into an interpreter that runs it as its program. */
function pipesDownloadToShell(text) {
    return [...text.matchAll(DOWNLOAD_PIPE)].some((match) => {
        const words = (match[1] ?? '').split(/\s+/).map((word) => word.replace(/^["'`(]+|["'`)]+$/g, '')).filter(Boolean);
        if (words.some((word) => SHELL_WORD.test(word)))
            return true;
        const receiving = receivingCommand(words);
        return receiving !== null && INTERPRETER_WORD.test(receiving.command) && readsProgramFromStdin(receiving.args);
    });
}
const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
function finding(locale, rule, level, field, message, fix) {
    return { rule, level, field, message: say(locale, ...message), fix: say(locale, ...fix) };
}
function summaryRules(gene, locale) {
    const summary = typeof gene['summary'] === 'string' ? gene['summary'].trim() : '';
    return summary.length < MIN_SUMMARY_CHARS ? [finding(locale, 'summary.short', 'warn', 'summary', [`简介只有 ${summary.length} 个字，别人难以判断什么时候用它`, `The summary has ${summary.length} characters; others cannot tell when to use it`], [`写清楚解决什么问题、在什么条件下有效，至少 ${MIN_SUMMARY_CHARS} 个字`, `Say what it solves and when it works, at least ${MIN_SUMMARY_CHARS} characters`])] : [];
}
function preconditionRules(gene, locale) {
    const preconditions = strings(gene['preconditions']).map((item) => item.toLowerCase());
    const has = (prefix) => preconditions.some((item) => item.startsWith(prefix.trim().toLowerCase().replace(/:$/, '')));
    return [
        ...(has(USE_WHEN) ? [] : [finding(locale, 'precondition.use_missing', 'warn', 'preconditions', ['没有写“什么时候用”', 'No "when to use" condition'], ['补一条适用的任务或报错', 'Add the task or error it fits'])]),
        ...(has(DO_NOT_USE_WHEN) ? [] : [finding(locale, 'precondition.do_not_use_missing', 'warn', 'preconditions', ['没有写“什么时候不用”，容易被用错地方', 'No "when not to use" condition; it may be applied where it does not fit'], ['补一条不该使用的情况', 'Add one situation where it must not be used'])]),
    ];
}
function strategyRules(gene, locale) {
    const steps = strings(gene['strategy']);
    const findings = [];
    if (steps.length === 1)
        findings.push(finding(locale, 'strategy.too_few', 'warn', 'strategy', ['只有 1 步，Hub 要求至少 2 步', 'Only one step; the Hub requires at least two'], ['把方法拆成可执行的几步', 'Split the method into concrete steps']));
    if (steps.length > MAX_STEPS)
        findings.push(finding(locale, 'strategy.too_many', 'warn', 'strategy', [`有 ${steps.length} 步，召回时可能被截断`, `${steps.length} steps; recall may cut it short`], [`合并到 ${MAX_STEPS} 步以内`, `Merge it into ${MAX_STEPS} steps or fewer`]));
    steps.forEach((step, index) => {
        if (NOT_ACTIONABLE.test(step.trim()))
            findings.push(finding(locale, 'strategy.not_actionable', 'warn', `strategy[${index}]`, [`第 ${index + 1} 步是提醒，不是动作`, `Step ${index + 1} is a note, not an action`], ['改成具体要做的事，或移到“什么时候不用”', 'Rewrite it as a concrete action, or move it to "when not to use"']));
    });
    return findings;
}
function commandVerdict(command) {
    const redacted = sanitizeExecutionCommand(command);
    const rejection = validationCommandRejection(command);
    return { unsafe: redacted.changed || redacted.blocked || (rejection !== null && UNSAFE_REJECTIONS.has(rejection)), rejection };
}
const isReplayable = (command) => {
    const verdict = commandVerdict(command);
    return !verdict.unsafe && verdict.rejection === null;
};
function validationRules(gene, locale) {
    const commands = strings(gene['validation']);
    if (commands.length === 0) {
        return [finding(locale, 'validation.missing', 'warn', 'validation', ['没有检查命令：可以本机使用，但不能发布', 'No validation command: usable locally, but not publishable'], ['写一条能在本机重放的检查命令，例如 npm test', 'Add a check that can be replayed locally, e.g. npm test'])];
    }
    return commands.flatMap((command, index) => {
        const field = `validation[${index}]`;
        const { unsafe, rejection } = commandVerdict(command);
        if (unsafe) {
            return [finding(locale, 'validation.unsafe', 'block', field, [`第 ${index + 1} 条检查命令带有凭据、命令替换或 shell 拼接`, `Validation command ${index + 1} carries credentials, command substitution or shell chaining`], ['改成单条不带密钥的命令', 'Use one plain command without secrets'])];
        }
        return rejection ? [finding(locale, 'validation.not_replayable', 'warn', field, [`第 ${index + 1} 条检查命令不在可重放的白名单里（${rejection}）`, `Validation command ${index + 1} is not on the replay allowlist (${rejection})`], ['改用 npm test、pnpm test、pytest、go test、cargo test 或 node 脚本', 'Use npm test, pnpm test, pytest, go test, cargo test or a node script'])] : [];
    });
}
const RM_INVOCATION = /(?:^|[\s;&|(`$])["']?(?:[\w.~-]*\/)*rm["']?\s+([^;&|\n]*)/g;
/** `rm` with both a recursive and a force flag, in any spelling or order (`-rf`, `-r --force`, `--recursive --force`). */
function isForcedRecursiveDelete(text) {
    return [...text.matchAll(RM_INVOCATION)].some((match) => {
        const flags = (match[1] ?? '').split(/\s+/).map((arg) => arg.replace(/^["']+|["']+$/g, '')).filter((arg) => arg.startsWith('-'));
        const short = flags.filter((arg) => !arg.startsWith('--')).join('');
        return (flags.includes('--recursive') || /[rR]/.test(short)) && (flags.includes('--force') || /f/.test(short));
    });
}
function dangerRules(gene, locale) {
    const surfaces = [...strings(gene['strategy']).map((text, index) => [`strategy[${index}]`, text]),
        ...strings(gene['validation']).map((text, index) => [`validation[${index}]`, text])];
    const dangerous = (text) => isForcedRecursiveDelete(text) || pipesDownloadToShell(text)
        || DANGEROUS_COMMANDS.some((pattern) => pattern.test(text));
    return surfaces.filter(([, text]) => dangerous(text)).map(([field]) => finding(locale, 'danger.command', 'block', field, ['包含危险命令（强制删除、管道执行远程脚本、sudo、改全局配置等）', 'Contains a dangerous command (forced delete, piping a remote script to a shell, sudo, global config writes…)'], ['删掉这条命令，或改成只影响当前项目的安全做法', 'Remove it, or use a safe command scoped to the project']));
}
function signalRules(gene, locale) {
    const signals = strings(gene['signals_match']);
    const findings = [];
    if (signals.length > 0 && signals.length < MIN_SIGNALS)
        findings.push(finding(locale, 'signals.too_few', 'warn', 'signals_match', ['触发信号太少，很难被召回', 'Too few signals; it will rarely be recalled'], ['再补 1–3 个任务里会出现的词或报错', 'Add 1–3 words or errors the task would show']));
    if (signals.length > MAX_SIGNALS)
        findings.push(finding(locale, 'signals.too_many', 'warn', 'signals_match', [`有 ${signals.length} 个触发信号，容易被误召回`, `${signals.length} signals; it may be recalled for unrelated tasks`], [`保留最有区分度的 ${MAX_SIGNALS} 个以内`, `Keep the ${MAX_SIGNALS} most specific ones`]));
    const generic = (signal) => signal.split('|').every((branch) => GENERIC_SIGNALS.has(branch.trim().toLowerCase()));
    if (signals.length > 0 && signals.every(generic))
        findings.push(finding(locale, 'signals.generic', 'warn', 'signals_match', ['触发信号都太笼统（如 bug、问题、error）', 'All signals are generic (bug, error, issue…)'], ['换成具体的报错文字或任务短语', 'Use concrete error text or task phrases']));
    return findings;
}
function portabilityRules(gene, locale) {
    const meta = gene['generation_meta'] && typeof gene['generation_meta'] === 'object' ? gene['generation_meta'] : {};
    const surfaces = [['generation_meta.title', [String(meta['title'] ?? '')]], ['summary', [String(gene['summary'] ?? '')]],
        ['preconditions', strings(gene['preconditions'])], ['strategy', strings(gene['strategy'])], ['signals_match', strings(gene['signals_match'])],
        ['validation', strings(gene['validation'])]];
    return surfaces.flatMap(([field, texts]) => {
        const local = portabilityFindings(texts, { paths: [], identifiers: new Set() }).local;
        return local.length > 0 ? [finding(locale, 'portability.path', 'warn', field, [`包含本机路径：${local.join('、')}`, `Contains machine-specific paths: ${local.join(', ')}`], ['改成“项目的测试入口”这类角色描述', 'Describe the role ("the project\'s test entry point") instead of the path'])] : [];
    });
}
function leakRules(gene, locale, env) {
    const leaks = sanitizeBundle([gene], { env, mode: 'strict' }).leaks.filter((leak) => leak.type !== 'local_path');
    return leaks.length > 0 ? [finding(locale, 'leak.secret', 'block', 'gene', [`发现疑似凭据：${[...new Set(leaks.map((leak) => leak.type))].join('、')}`, `Possible credentials found: ${[...new Set(leaks.map((leak) => leak.type))].join(', ')}`], ['删掉密钥、令牌和密码，改成环境变量名', 'Remove keys, tokens and passwords; name the environment variable instead'])] : [];
}
function gateOf(gene) {
    const input = { summary: gene['summary'], strategy: strings(gene['strategy']), validation: strings(gene['validation']),
        signals: strings(gene['signals_match']), preconditions: strings(gene['preconditions']) };
    const gate = evaluateGate(input, normalizeConversationInput(input), { surface: [], provenance: { paths: [], identifiers: new Set() }, structural: false });
    return { score: gate.score, threshold: gate.threshold };
}
/** Quality findings for a hand-written Gene: the deep schema plus the rules the distiller and publish path apply. */
export function lintGene(gene, locale, env) {
    const schemaErrors = [...geneSchemaErrors(gene, locale).filter((error) => error.path !== '/asset_id'), ...generationMetaErrors(gene['generation_meta'], locale)];
    const schema = schemaErrors.map((error) => ({
        rule: `schema.${error.code}`, level: 'block', field: error.path.split('/')[1] || 'gene', message: error.message,
        fix: say(locale, '按提示补全或修正这个字段', 'Fill in or correct this field'),
    }));
    const findings = [...schema, ...summaryRules(gene, locale), ...preconditionRules(gene, locale), ...strategyRules(gene, locale),
        ...validationRules(gene, locale), ...dangerRules(gene, locale), ...signalRules(gene, locale), ...portabilityRules(gene, locale),
        ...leakRules(gene, locale, env)];
    const blocking = findings.filter((item) => item.level === 'block').length;
    const commands = strings(gene['validation']);
    return {
        rulesVersion: GENE_LINT_RULES_VERSION,
        findings,
        blocking,
        warnings: findings.filter((item) => item.level === 'warn').length,
        gate: gateOf(gene),
        publishable: schema.length === 0 && commands.length > 0 && blocking === 0,
        replayable: commands.length > 0 && commands.every(isReplayable),
    };
}