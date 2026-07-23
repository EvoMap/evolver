import { createHash } from 'node:crypto';
import { redactString } from '../hub/sanitize.js';
// The Chinese branches require compound/intentful phrases on purpose: everyday words (能力/流程/成功/通过)
// occur in nearly every Chinese dev session, and matching them bare made this fallback the DOMINANT distill
// path — 105 of 118 drafts in one bulk ingest (#562). English gets specificity from \b word boundaries;
// Chinese has no \b, so specificity must come from the phrase itself.
const REUSABLE_RE = /\b(reusable|repeatable|workflow|playbook|runbook|capability|procedure|pattern|recipe|documented|future runs?|next time|can reuse|reuse this)\b|复用|可重用|工作流|方法论|沉淀/i;
const PROOF_RE = /\b(validated|verified|passed|green|success(?:ful|fully)?|succeeded|works?|completed|published|uploaded|recorded:true|exit code:?\s*0|all tests passed)\b|(?:验证|校验|测试|检查|构建|编译|运行|执行|部署|发布)(?:都|均|全部)?(?:通过|成功)|全部通过|跑通|已(?:验证|发布|上线)/i;
const FAILURE_RE = /\b(failed|failure|error|exception|traceback|exit code:?\s*[1-9]|not working|unable to)\b|失败|错误|报错/i;
const EXIT_ZERO_RE = /\bexit code:?\s*0\b/i;
const EXIT_NON_ZERO_RE = /\bexit code:?\s*[1-9]\d*\b/i;
const DOMAIN_TOKENS = [
    [/\b(lark|feishu|飞书)\b/i, 'lark'],
    [/\b(github|gh|pull request|bugbot)\b/i, 'github'],
    [/\b(playwright|screenshot|visual)\b/i, 'playwright'],
    [/\b(vitest|jest|test)\b/i, 'test'],
    [/\b(pnpm|npm|yarn)\b/i, 'package-manager'],
    [/\b(hub|publish|marketplace)\b/i, 'hub-publish'],
    [/\b(release|checksum|sha256)\b/i, 'release'],
    [/\b(api|http|endpoint)\b/i, 'api'],
    [/\b(document|docs?|markdown)\b/i, 'docs'],
];
function cleanText(value, max = 220) {
    const text = redactString(String(value ?? '').replace(/\s+/g, ' ').trim());
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
function turnText(turn) {
    return cleanText([turn.text, turn.toolResult, turn.errorMessage].filter(Boolean).join('\n'), 500);
}
function stableId(parts) {
    return `conversation_capability_${createHash('sha1').update(JSON.stringify(parts), 'utf8').digest('hex').slice(0, 12)}`;
}
function normalizeSignal(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}
function collectToolCalls(turns) {
    const seen = new Set();
    for (const turn of turns) {
        const tool = cleanText(turn.toolName ?? '', 80);
        if (tool)
            seen.add(tool);
    }
    return [...seen].slice(0, 8);
}
function domainSignals(text, toolCalls) {
    const out = new Set();
    for (const [re, signal] of DOMAIN_TOKENS) {
        if (re.test(text))
            out.add(signal);
    }
    for (const tool of toolCalls) {
        const normalized = normalizeSignal(tool);
        if (normalized)
            out.add(normalized);
    }
    return [...out].slice(0, 6);
}
function isToolTurn(turn) {
    return turn.role === 'tool' || Boolean(turn.toolName);
}
function classifyToolOutcome(turn) {
    const text = turnText(turn);
    if (EXIT_NON_ZERO_RE.test(text))
        return 'failure';
    if (EXIT_ZERO_RE.test(text))
        return 'success';
    if (PROOF_RE.test(text) && !FAILURE_RE.test(text))
        return 'success';
    if (FAILURE_RE.test(text))
        return 'failure';
    return 'unknown';
}
function hasTerminalSuccessfulToolRun(turns) {
    let lastDecisive = 'unknown';
    for (const turn of turns) {
        if (!isToolTurn(turn))
            continue;
        const outcome = classifyToolOutcome(turn);
        if (outcome !== 'unknown')
            lastDecisive = outcome;
    }
    return lastDecisive === 'success';
}
function pickEvidence(turns, matcher, max = 3) {
    const evidence = [];
    for (const turn of turns) {
        const text = turnText(turn);
        if (!text || !matcher.test(text))
            continue;
        evidence.push(cleanText(text, 180));
        if (evidence.length >= max)
            break;
    }
    return evidence;
}
function pickSummary(turns, reusableEvidence, proofEvidence) {
    const assistant = turns
        .filter((turn) => turn.role === 'assistant' && !turn.isMeta)
        .map(turnText)
        .find((text) => text.length >= 40 && (REUSABLE_RE.test(text) || PROOF_RE.test(text)));
    return cleanText(assistant ?? reusableEvidence[0] ?? proofEvidence[0] ?? 'Verified reusable conversation capability.', 180);
}
export function sniffConversationCapabilities(turns, opts = {}) {
    const usableTurns = turns.filter((turn) => !turn.isMeta);
    if (usableTurns.length === 0)
        return [];
    const allText = usableTurns.map(turnText).filter(Boolean).join('\n');
    if (!allText.trim())
        return [];
    const reusableEvidence = pickEvidence(usableTurns, REUSABLE_RE);
    const proofEvidence = pickEvidence(usableTurns, PROOF_RE);
    if (reusableEvidence.length === 0 || proofEvidence.length === 0)
        return [];
    const failureOnly = FAILURE_RE.test(allText) && !PROOF_RE.test(allText);
    if (failureOnly)
        return [];
    if (!hasTerminalSuccessfulToolRun(usableTurns))
        return [];
    const toolCalls = collectToolCalls(usableTurns);
    const domain = domainSignals(allText, toolCalls);
    const signals = [...new Set(['reusable_capability', 'verified_workflow', ...domain])].slice(0, 8);
    const score = 4 + Math.min(2, reusableEvidence.length) + Math.min(2, proofEvidence.length) + Math.min(2, toolCalls.length);
    const summary = pickSummary(usableTurns, reusableEvidence, proofEvidence);
    const titleSignal = domain[0] ?? 'verified workflow';
    const hit = {
        id: stableId({ summary, signals, evidence: [...reusableEvidence, ...proofEvidence].slice(0, 4) }),
        title: `Verified reusable capability: ${titleSignal}`,
        summary,
        signals,
        evidence: [...reusableEvidence, ...proofEvidence].slice(0, 4),
        score,
        reasons: ['reusable_marker', 'proof_marker', ...(toolCalls.length > 0 ? ['tool_evidence'] : [])],
        toolCalls,
    };
    return [hit].slice(0, opts.maxHits ?? 1);
}