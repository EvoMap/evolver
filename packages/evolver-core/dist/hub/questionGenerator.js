import { REDACTED, redactString } from './sanitize.js';
export const QUESTION_INTERVAL_MS = 30 * 60 * 1000;
export const URGENT_QUESTION_INTERVAL_MS = 5 * 60 * 1000;
export const EXPLORATION_QUESTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MAX_QUESTIONS_PER_CYCLE = 3;
export const MAX_URGENT_QUESTIONS = 2;
export const URGENT_QUESTION_RUNTIME_WIRING_STATUS = {
    status: 'deferred',
    reason: 'urgent_question_runtime_wiring_not_connected',
};
const INFRA_ERROR_RE = /\b(401|403|429|500|502|503|504|529)\b|invalid[\s_-]?api[\s_-]?key|authentication[\s_-]?error|unauthorized|permission[\s_-]?denied|rate[\s_-]?limit|too[\s_-]?many[\s_-]?requests|overloaded[\s_-]?error|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|fetch[\s_-]?failed|network[\s_-]?error|connection[\s_-]?refused|context[\s_-]?length|token[\s_-]?limit|(?:context|input)[\s_-]?window[\s_-]?exceeded|maximum[\s_-]?context[\s_-]?length/i;
const PROBLEM_SIGNALS = [
    'recurring_error', 'high_failure_ratio', 'capability_gap', 'unsupported_input_type',
    'evolution_saturation', 'force_steady_state', 'consecutive_failure_streak',
    'user_feature_request', 'perf_bottleneck', 'hub_search_miss_with_problem',
    'repair_loop_detected', 'force_innovation_after_repair_loop',
    'plateau_pivot_required', 'plateau_pivot_suggested',
];
const EXPLORE_STOPWORDS = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'what', 'your',
    'agent', 'about', 'into', 'then', 'than', 'they', 'them', 'their', 'there',
    'here', 'will', 'would', 'could', 'should', 'been', 'were', 'using', 'used',
    'cycle', 'evolution', 'error', 'errors', 'failed', 'failure', 'null', 'undefined',
    'true', 'false', 'console', 'return', 'function', 'const', 'value', 'result',
]);
const SENSITIVE_TOPIC_RE = /secret|token|api[_-]?key|password|passwd|credential|bearer|authorization|cookie|session[_-]?id|private[_-]?key|oauth|refresh[_-]?token/i;
const LONG_OPAQUE_RE = /^[a-z0-9_-]{32,}$/i;
function isInfraError(text) {
    if (!text)
        return false;
    return INFRA_ERROR_RE.test(text);
}
function normalizeState(state) {
    return {
        lastAskedAt: state?.lastAskedAt ?? null,
        lastUrgentAt: state?.lastUrgentAt ?? null,
        lastExploreAt: state?.lastExploreAt ?? null,
        recentQuestions: [...(state?.recentQuestions ?? [])],
    };
}
function questionState(state) {
    return {
        lastAskedAt: state.lastAskedAt,
        lastUrgentAt: state.lastUrgentAt,
        lastExploreAt: state.lastExploreAt,
        recentQuestions: [...state.recentQuestions],
    };
}
function parseIsoMs(value) {
    if (!value)
        return null;
    const n = Date.parse(value);
    return Number.isFinite(n) ? n : null;
}
function tooSoon(lastAt, intervalMs, now) {
    const ts = parseIsoMs(lastAt);
    return ts !== null && now - ts < intervalMs;
}
function defaultEnv() {
    return typeof process === 'undefined' ? {} : process.env;
}
function isDuplicate(question, recentQuestions) {
    const qLower = question.toLowerCase();
    const qWords = new Set(qLower.split(/\s+/).filter((w) => w.length > 2));
    for (const prevQuestion of recentQuestions) {
        const prev = String(prevQuestion || '').toLowerCase();
        if (prev === qLower)
            return true;
        const pWords = new Set(prev.split(/\s+/).filter((w) => w.length > 2));
        if (qWords.size === 0 || pWords.size === 0)
            continue;
        let overlap = 0;
        for (const w of qWords)
            if (pWords.has(w))
                overlap += 1;
        if (overlap / Math.max(qWords.size, pWords.size) > 0.7)
            return true;
    }
    return false;
}
function extractErrorContext(transcript, maxLen = 150) {
    const line = transcript.split('\n').find((l) => /error|exception|failed|cannot|not supported|unsupported|not implemented/i.test(l));
    return line ? line.replace(/\s+/g, ' ').trim().slice(0, maxLen) : '';
}
function hasPublicContext(text) {
    return /[a-z0-9]/i.test(text.replaceAll(REDACTED, ''));
}
function safeQuestionContext(text, maxLen) {
    const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized)
        return '';
    return redactString(normalized).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}
function safeProblemContext(text, maxLen) {
    const context = safeQuestionContext(text, maxLen);
    if (!context || !hasPublicContext(context) || isInfraError(context))
        return '';
    return context;
}
function safeTopicToken(token) {
    if (EXPLORE_STOPWORDS.has(token))
        return false;
    if (SENSITIVE_TOPIC_RE.test(token))
        return false;
    if (LONG_OPAQUE_RE.test(token))
        return false;
    return true;
}
export function extractTopicKeywords(transcript, memory, max = 5) {
    const text = `${String(transcript ?? '')} ${String(memory ?? '')}`.toLowerCase();
    const words = text.match(/[a-z][a-z0-9_-]{4,}/g) ?? [];
    const freq = new Map();
    for (const word of words) {
        if (!safeTopicToken(word))
            continue;
        freq.set(word, (freq.get(word) ?? 0) + 1);
    }
    return [...freq.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([word]) => word)
        .slice(0, max);
}
function safeGeneId(id) {
    if (!/^[a-z0-9_.:-]{3,80}$/i.test(id))
        return false;
    return !SENSITIVE_TOPIC_RE.test(id);
}
function extractRecentGeneIds(recentEvents, count = 5) {
    const ids = [];
    for (const event of (recentEvents ?? []).slice(-count)) {
        const genes = event.genes_used ?? event.genesUsed ?? [];
        const first = genes[0];
        if (typeof first === 'string' && safeGeneId(first))
            ids.push(first);
    }
    return [...new Set(ids)].slice(0, count);
}
function safeSignal(signal) {
    if (!/^[a-z][a-z0-9_]{3,40}$/i.test(signal))
        return false;
    if (SENSITIVE_TOPIC_RE.test(signal))
        return false;
    if (signal.startsWith('errsig') || signal.startsWith('ban_gene') || signal.startsWith('recurring_'))
        return false;
    return !PROBLEM_SIGNALS.some((p) => signal === p || signal.startsWith(p));
}
function buildExplorationCandidate(signals, recentEvents, transcript, memory) {
    const topicSignals = signals.map(String).filter(safeSignal).slice(0, 4);
    const keywords = extractTopicKeywords(transcript, memory, 5);
    const genes = extractRecentGeneIds(recentEvents, 5);
    if (keywords.length === 0 && genes.length === 0)
        return null;
    const focus = keywords.length > 0 ? keywords.slice(0, 5).join(', ') : genes.join(', ');
    return {
        question: `A productively-running agent working on ${focus} wants to extend its capabilities. What reusable patterns, automation genes, or complementary tools in this area would be most valuable to build next, and what adjacent high-value problems is the ecosystem not yet solving well here?`,
        amount: 0,
        signals: ['capability_frontier', 'exploration', 'proactive_curiosity', ...keywords.slice(0, 2), ...topicSignals.slice(0, 2)],
        priority: 0,
    };
}
function buildStandardCandidates(signals, recentEvents, transcript) {
    const candidates = [];
    const signalSet = new Set(signals);
    if (signalSet.has('recurring_error') || signalSet.has('high_failure_ratio')) {
        const errSig = signals.find((s) => String(s).startsWith('recurring_errsig'));
        if (errSig) {
            const errDetail = safeProblemContext(String(errSig).replace(/^recurring_errsig\(\d+x\):/, ''), 120);
            if (errDetail) {
                candidates.push({
                    question: `Recurring error in evolution cycle that auto-repair cannot resolve: ${errDetail} -- What approaches or patches have worked for similar issues?`,
                    amount: 0,
                    signals: ['recurring_error', 'auto_repair_failed'],
                    priority: 3,
                });
            }
        }
    }
    if (signalSet.has('capability_gap') || signalSet.has('unsupported_input_type')) {
        const gapContext = safeProblemContext(extractErrorContext(transcript, 150), 150);
        if (gapContext) {
            candidates.push({
                question: `Capability gap detected in agent environment: ${gapContext} -- How can this be addressed or what alternative approaches exist?`,
                amount: 0,
                signals: ['capability_gap'],
                priority: 2,
            });
        }
    }
    if (signalSet.has('evolution_saturation') || signalSet.has('force_steady_state')) {
        const uniqueGenes = extractRecentGeneIds(recentEvents, 5);
        candidates.push({
            question: `Agent evolution has reached saturation after exhausting genes: [${uniqueGenes.join(', ')}]. What new evolution directions, automation patterns, or capability genes would be most valuable?`,
            amount: 0,
            signals: ['evolution_saturation', 'innovation_needed'],
            priority: 1,
        });
    }
    const failStreak = signals.find((s) => String(s).startsWith('consecutive_failure_streak_'));
    if (failStreak) {
        const streakCount = Number.parseInt(String(failStreak).replace('consecutive_failure_streak_', ''), 10) || 0;
        if (streakCount >= 3) {
            const failGene = signals.find((s) => String(s).startsWith('ban_gene:'));
            const failGeneId = failGene ? safeQuestionContext(String(failGene).replace('ban_gene:', ''), 80) || 'unknown' : 'unknown';
            candidates.push({
                question: `Agent has failed ${streakCount} consecutive evolution cycles (last gene: ${failGeneId}). The current approach is exhausted. What alternative strategies or environmental fixes should be tried?`,
                amount: 0,
                signals: ['failure_streak', 'external_help_needed'],
                priority: 3,
            });
        }
    }
    if (signalSet.has('user_feature_request') || signals.some((s) => String(s).startsWith('user_feature_request:'))) {
        const featureLine = transcript.split('\n').find((l) => /\b(add|implement|create|build|i want|i need|please add)\b/i.test(l));
        if (featureLine) {
            const featureContext = safeQuestionContext(featureLine, 150);
            candidates.push({
                question: `User requested a feature that may benefit from community solutions: ${featureContext} -- Are there existing implementations or best practices for this?`,
                amount: 0,
                signals: ['user_feature_request', 'community_solution_sought'],
                priority: 1,
            });
        }
    }
    if (signalSet.has('perf_bottleneck')) {
        const perfLine = transcript.split('\n').find((l) => /\b(slow|timeout|latency|bottleneck|high cpu|high memory)\b/i.test(l));
        if (perfLine) {
            const perfContext = safeQuestionContext(perfLine, 150);
            candidates.push({
                question: `Performance bottleneck detected: ${perfContext} -- What optimization strategies or architectural patterns address this?`,
                amount: 0,
                signals: ['perf_bottleneck', 'optimization_sought'],
                priority: 2,
            });
        }
    }
    if (signalSet.has('hub_search_miss_with_problem')) {
        const problemCtx = safeProblemContext(extractErrorContext(transcript, 120), 120);
        const problemSignalList = signals
            .filter((s) => s === 'log_error' || s === 'test_failure' || s === 'deployment_issue' || String(s).startsWith('errsig:'))
            .map((s) => safeQuestionContext(String(s), 80))
            .filter((s) => s && hasPublicContext(s) && !isInfraError(s))
            .slice(0, 3);
        if (problemCtx || problemSignalList.length > 0) {
            candidates.push({
                question: `No matching solution found in ecosystem for active problem (signals: ${problemSignalList.join(', ')}). Context: ${problemCtx || 'complex multi-signal issue'} -- What strategies, patterns, or tools address this class of problem?`,
                amount: 0,
                signals: ['hub_search_miss', 'ecosystem_gap', 'solution_sought'],
                priority: 2,
            });
        }
    }
    if (signalSet.has('repair_loop_detected') || signalSet.has('force_innovation_after_repair_loop')) {
        const recentGenes = extractRecentGeneIds(recentEvents, 6);
        candidates.push({
            question: `Agent is stuck in a repair loop (repair->fail->repair cycle) with genes: [${recentGenes.join(', ')}]. The underlying issue persists despite multiple attempts. What fundamentally different approach could break this cycle?`,
            amount: 0,
            signals: ['repair_loop', 'architectural_help_needed'],
            priority: 3,
        });
    }
    if (signalSet.has('plateau_pivot_required') || signalSet.has('plateau_pivot_suggested')) {
        const severity = signalSet.has('plateau_pivot_required') ? 'severe' : 'moderate';
        candidates.push({
            question: `Agent evolution has plateaued (${severity} -- no improvement in recent cycles). Current gene pool and mutation strategies are exhausted. What novel approaches, architectural patterns, or paradigm shifts could restart progress?`,
            amount: 0,
            signals: ['evolution_plateau', 'pivot_needed'],
            priority: severity === 'severe' ? 3 : 2,
        });
    }
    return candidates;
}
function publicQuestion(q) {
    return { question: q.question, amount: q.amount, signals: [...(q.signals ?? [])] };
}
function completeStandardGeneration(candidates, state, now) {
    if (candidates.length === 0)
        return { questions: [], state: questionState(state), changed: false };
    candidates.sort((a, b) => b.priority - a.priority);
    const filtered = [];
    for (const candidate of candidates) {
        if (filtered.length >= MAX_QUESTIONS_PER_CYCLE)
            break;
        if (!isDuplicate(candidate.question, state.recentQuestions))
            filtered.push(candidate);
    }
    if (filtered.length === 0)
        return { questions: [], state: questionState(state), changed: false };
    const recentQuestions = [...state.recentQuestions, ...filtered.map((q) => q.question)].slice(-30);
    const explorationSent = filtered.some((q) => q.signals?.includes('exploration'));
    const nextState = {
        lastAskedAt: new Date(now).toISOString(),
        lastUrgentAt: state.lastUrgentAt,
        lastExploreAt: explorationSent ? new Date(now).toISOString() : state.lastExploreAt,
        recentQuestions,
    };
    return { questions: filtered.map(publicQuestion), state: nextState, changed: true };
}
export function generateQuestions(input = {}) {
    const now = input.now ?? Date.now();
    const state = normalizeState(input.state);
    if (tooSoon(state.lastAskedAt, QUESTION_INTERVAL_MS, now))
        return { questions: [], state: questionState(state), changed: false };
    const signals = (input.signals ?? []).map(String);
    const recentEvents = input.recentEvents ?? [];
    const transcript = String(input.sessionTranscript ?? '');
    const memory = String(input.memorySnippet ?? '');
    const candidates = buildStandardCandidates(signals, recentEvents, transcript);
    const env = input.env ?? defaultEnv();
    let explorationEligible = input.explorationEnabled ?? (env['EVOLVER_EXPLORATION_QUESTIONS'] !== '0');
    if (explorationEligible && tooSoon(state.lastExploreAt, EXPLORATION_QUESTION_INTERVAL_MS, now))
        explorationEligible = false;
    if (explorationEligible) {
        const exploration = buildExplorationCandidate(signals, recentEvents, transcript, memory);
        if (exploration)
            candidates.push(exploration);
    }
    return completeStandardGeneration(candidates, state, now);
}
function buildUrgentCandidates(input) {
    const candidates = [];
    if (input.validationFailed) {
        const valErrors = safeProblemContext(String(input.validationErrors ?? ''), 200);
        const geneId = input.geneId ? safeQuestionContext(input.geneId, 80) || 'unknown' : 'unknown';
        if (valErrors) {
            candidates.push({
                question: `Evolution cycle produced a patch that failed validation (gene: ${geneId}). Errors: ${valErrors} -- What is the correct approach to fix this validation failure?`,
                amount: 0,
                signals: ['validation_failure', 'solidify_rejected'],
                priority: 3,
            });
        }
    }
    if (input.lowConfidence && Number.isFinite(input.confidenceScore)) {
        const score = Math.round(Number(input.confidenceScore) * 100) / 100;
        candidates.push({
            question: `Evolution cycle completed with low confidence (score: ${score}, intent: ${input.intent || 'unknown'}). The change is uncertain and may not be beneficial. What higher-confidence approaches exist for this type of problem?`,
            amount: 0,
            signals: ['low_confidence', 'uncertain_outcome'],
            priority: 2,
        });
    }
    if (input.llmReviewRejected) {
        const reason = safeProblemContext(String(input.llmReviewReason ?? ''), 200);
        if (reason) {
            candidates.push({
                question: `Proposed code change was rejected by LLM review: ${reason} -- What alternative implementation approach would pass quality review?`,
                amount: 0,
                signals: ['llm_review_rejected', 'quality_concern'],
                priority: 3,
            });
        }
    }
    if (input.zeroBlastRadius && input.hadSignals) {
        const attemptedSignals = (input.signals ?? [])
            .map((s) => safeQuestionContext(String(s), 80))
            .filter((s) => s && hasPublicContext(s))
            .slice(0, 5)
            .join(', ');
        candidates.push({
            question: `Evolution cycle targeting signals [${attemptedSignals}] produced zero blast radius (no effective changes). The approach was insufficient. What concrete implementation steps would address these signals?`,
            amount: 0,
            signals: ['zero_blast_radius', 'ineffective_approach'],
            priority: 2,
        });
    }
    if (input.taskCompletionFailed) {
        const taskTitle = safeProblemContext(String(input.taskTitle ?? ''), 120);
        const taskSignals = safeProblemContext(String(input.taskSignals ?? ''), 100);
        if (taskTitle || taskSignals) {
            candidates.push({
                question: `Failed to complete claimed task: "${taskTitle || 'unknown'}" (signals: ${taskSignals || 'unknown'}). The problem exceeds current capabilities. What approaches, tools, or patterns would solve this?`,
                amount: 0,
                signals: ['task_completion_failed', 'help_needed'],
                priority: 3,
            });
        }
    }
    return candidates;
}
export function generateUrgentQuestions(input = {}) {
    const now = input.now ?? Date.now();
    const state = normalizeState(input.state);
    if (tooSoon(state.lastUrgentAt, URGENT_QUESTION_INTERVAL_MS, now))
        return { questions: [], state: questionState(state), changed: false };
    const candidates = buildUrgentCandidates(input);
    if (candidates.length === 0)
        return { questions: [], state: questionState(state), changed: false };
    candidates.sort((a, b) => b.priority - a.priority);
    const filtered = [];
    for (const candidate of candidates) {
        if (filtered.length >= MAX_URGENT_QUESTIONS)
            break;
        if (!isDuplicate(candidate.question, state.recentQuestions))
            filtered.push(candidate);
    }
    if (filtered.length === 0)
        return { questions: [], state: questionState(state), changed: false };
    const nextState = {
        lastAskedAt: state.lastAskedAt,
        lastUrgentAt: new Date(now).toISOString(),
        lastExploreAt: state.lastExploreAt,
        recentQuestions: [...state.recentQuestions, ...filtered.map((q) => q.question)].slice(-30),
    };
    return { questions: filtered.map(publicQuestion), state: nextState, changed: true };
}