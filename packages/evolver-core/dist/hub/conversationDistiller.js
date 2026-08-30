import { createHash } from 'node:crypto';
import { intakeGene } from '../algo/geneIntake.js';
import { redactDeep, redactString } from './sanitize.js';
import { SCHEMA_VERSION, computeAssetId, stripGeneHints, validateWireDeep } from '../wire/index.js';
const DEFAULT_SIGNALS = [
    'conversation_distillation',
    'reusable_capability',
    'agent_self_evolution',
];
const SIGNAL_RULES = [
    { signal: 'conversation_distillation', re: /\b(distill|distillation|distilled|蒸馏|提炼|萃取)\b/i },
    { signal: 'gene_publish', re: /\b(gene|capsule|evomap|evolver|gep)\b|基因|胶囊/i },
    { signal: 'reusable_capability', re: /\b(reusable|repeatable|workflow|playbook|capability)\b|可复用|复用|能力|流程/i },
    { signal: 'visual_annotation', re: /\b(screenshot|annotat|mock|wireframe|playwright|visual)\b|截图|圈圈|标注|画图|飞书/i },
    { signal: 'frontend_polish', re: /\b(frontend|ui|ux|interaction|polish|mockup)\b|前端|交互|打磨|体验/i },
    { signal: 'proxy_sync', re: /\b(proxy|sync|mailbox|outbound|hub|asset_submit)\b|同步|队列|代理/i },
    { signal: 'plugin_integration', re: /\b(plugin|codex|claude|cursor|antigravity|workbuddy|hook|notify)\b|插件|钩子/i },
    { signal: 'test_verified', re: /\b(test|build|verify|passed|green)\b|测试|验证|通过/i },
];
const BUNDLE_PERSISTENCE_UNSUPPORTED = 'bundle_persistence_unsupported';
function asRecord(v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
function trimText(value, max) {
    const text = redactString(String(value ?? '').replace(/\s+/g, ' ').trim());
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function asArray(value) {
    if (value === undefined || value === null || value === '')
        return [];
    return Array.isArray(value) ? value : [value];
}
function normalizeList(value, maxItems, maxLen) {
    return asArray(value).map((item) => trimText(item, maxLen)).filter(Boolean).slice(0, maxItems);
}
function slugify(value) {
    const raw = String(value || 'conversation-capability').toLowerCase();
    const ascii = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
    if (ascii.length >= 8)
        return ascii.slice(0, 56).replace(/-+$/g, '');
    const hash = createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 8);
    return `conversation-capability-${hash}`;
}
function hashInput(input) {
    return createHash('sha1').update(JSON.stringify(input ?? {}), 'utf8').digest('hex').slice(0, 10);
}
export function inferSignals(text, providedSignals) {
    const found = new Set(normalizeList(providedSignals, 12, 64));
    for (const rule of SIGNAL_RULES)
        if (rule.re.test(text))
            found.add(rule.signal);
    if (found.size === 0)
        for (const signal of DEFAULT_SIGNALS)
            found.add(signal);
    return [...found].slice(0, 12);
}
function inferCategory(signals, text) {
    const hay = `${signals.join(' ')} ${text}`.toLowerCase();
    if (/proxy|sync|auth|error|failure|bug|repair|修复|故障/.test(hay))
        return 'repair';
    if (/new|plugin|integration|feature|capability|能力|新增/.test(hay))
        return 'innovate';
    return 'optimize';
}
function normalizeBlastRadius(value) {
    const r = asRecord(value);
    return {
        files: Number.isFinite(Number(r['files'])) ? Number(r['files']) : 0,
        lines: Number.isFinite(Number(r['lines'])) ? Number(r['lines']) : 0,
    };
}
function normalizePublishBlastRadius(value, artifactCount) {
    return {
        files: Math.max(1, Math.trunc(value.files || artifactCount || 1)),
        lines: Math.max(1, Math.trunc(value.lines || 1)),
    };
}
function capsuleContent(normalized) {
    return redactDeep({
        platform: normalized.platform,
        source_thread: normalized.source_thread || null,
        artifacts: normalized.artifacts,
        excerpt: normalized.text.slice(0, 1200),
    });
}
function normalizeExecution(input) {
    const execution = asRecord(input.execution);
    const validation = normalizeList(input.validation ?? input.verification ?? execution['validation'], 8, 180);
    const untrustedStatusClaim = execution['status'] !== undefined || execution['ok'] !== undefined;
    let malformedTrace = false;
    const trace = asArray(execution['trace']).map((item) => {
        if (typeof item === 'string') {
            malformedTrace = true;
            return null;
        }
        const row = asRecord(item);
        if (Object.keys(row).length === 0) {
            malformedTrace = true;
            return null;
        }
        const command = trimText(row['command'] ?? row['cmd'] ?? row['name'] ?? '', 180);
        if (!command) {
            malformedTrace = true;
            return null;
        }
        const rawExit = row['exit'];
        const exit = Number.isInteger(rawExit)
            ? Number(rawExit)
            : (typeof row['ok'] === 'boolean' ? (row['ok'] ? 0 : 1) : undefined);
        if (exit === undefined) {
            malformedTrace = true;
            return null;
        }
        return {
            command,
            exit,
            summary: trimText(row['summary'] ?? row['output'] ?? '', 240),
        };
    }).filter((row) => row !== null);
    // 声明的验证命令只是计划，并不能证明命令已经执行。
    // 保留它作为质量信号，但不能为未执行的声明伪造 exit-0 轨迹或成功结果。
    // 只有显式结构化的退出码才可作为证据。调用方声明的 status/ok 字段只是元数据，
    // 不能据此把资产晋级到发布流程。
    const normalizedValidation = new Set(validation);
    const covered = [...normalizedValidation].every((command) => trace.some((row) => row.command === command));
    const ok = trace.length > 0
        && !malformedTrace
        && trace.every((t) => t.exit === 0)
        && covered;
    return {
        status: ok ? 'success' : 'failed',
        trace,
        validation,
        blast_radius: normalizeBlastRadius(execution['blast_radius'] ?? input.blast_radius),
        untrustedStatusClaim,
    };
}
function buildStrategy(input) {
    const explicit = normalizeList(input.strategy ?? input.steps, 10, 220);
    if (explicit.length >= 3)
        return explicit;
    const artifacts = normalizeList(input.artifacts ?? input.outputs ?? input.files, 6, 160);
    const strategy = explicit.slice();
    strategy.push('Capture the user-visible trigger and the concrete workflow that solved it.');
    strategy.push('Preserve evidence: commands, screenshots, documents, changed files, and validation results.');
    if (artifacts.length > 0)
        strategy.push('Link generated artifacts back to the reusable procedure before publishing.');
    strategy.push('Sanitize secrets and local-only paths before persisting or submitting the asset.');
    strategy.push('Queue the resulting Gene/Capsule through the local Proxy so Hub outages do not drop the learning.');
    return strategy.slice(0, 10);
}
export function evaluateGate(input, normalized) {
    let score = 0;
    const reasons = [];
    if (normalized.summary.length >= 40) {
        score += 2;
        reasons.push('summary');
    }
    if (normalized.strategy.length >= 3) {
        score += 2;
        reasons.push('strategy');
    }
    if (normalized.artifacts.length > 0) {
        score += 1;
        reasons.push('artifacts');
    }
    if (normalized.execution.validation.length > 0 || normalized.execution.trace.length > 0) {
        score += 1;
        reasons.push('validation');
    }
    if (/\b(gene|capsule|distill|reusable|evomap|evolver)\b|蒸馏|提炼|可复用|基因/i.test(normalized.text)) {
        score += 2;
        reasons.push('explicit_distill_signal');
    }
    const rawThreshold = Number(input.min_score ?? input.minScore ?? 5);
    // 调用方可以要求更严格的阈值，但不能把准入策略降为零，
    // 也不能把未经确认的草稿变成可发布资产。
    const threshold = Number.isFinite(rawThreshold) ? Math.max(5, rawThreshold) : 5;
    if (score < threshold)
        return { ok: false, score, threshold, reasons, reason: 'insufficient_reusable_signal' };
    return { ok: true, score, threshold, reasons };
}
export function normalizeConversationInput(input) {
    const sourceText = [
        input.summary,
        input.title,
        input.user_prompt,
        input.userPrompt,
        input.assistant_summary,
        input.assistantSummary,
        input.transcript,
        input.conversation,
    ].filter(Boolean).join('\n');
    const text = trimText(sourceText, 8000);
    const summary = trimText(input.summary ?? input.assistant_summary ?? input.assistantSummary ?? text, 300);
    return {
        text,
        summary,
        signals: inferSignals(text, input.signals),
        strategy: buildStrategy(input),
        artifacts: normalizeList(input.artifacts ?? input.outputs ?? input.files, 12, 240),
        execution: normalizeExecution(input),
        platform: trimText(input.platform ?? input.host ?? 'generic', 64),
        model: trimText(input.model ?? '', 100) || 'unknown',
        source_thread: trimText(input.thread_id ?? input.threadId ?? input.session_id ?? input.sessionId ?? '', 128),
    };
}
export async function distillConversation(input, opts = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return { ok: false, status: 'skipped', reason: 'input_object_required' };
    const effectiveInput = opts.verifiedExecution
        ? {
            ...input,
            execution: opts.verifiedExecution,
            ...(opts.verifiedExecution.validation ? { validation: opts.verifiedExecution.validation } : {}),
        }
        : input;
    const normalized = normalizeConversationInput(effectiveInput);
    if (!normalized.summary || normalized.summary.length < 20)
        return { ok: false, status: 'skipped', reason: 'summary_required' };
    const gate = evaluateGate(input, normalized);
    const slug = slugify(input.name ?? input.title ?? normalized.summary);
    const fingerprint = hashInput({
        summary: normalized.summary,
        signals: normalized.signals,
        strategy: normalized.strategy,
        artifacts: normalized.artifacts,
    });
    const category = inferCategory(normalized.signals, normalized.text);
    // 只有质量门禁与受信任宿主证据同时通过时，Capsule 才允许广播。
    const publishable = gate.ok && normalized.execution.status === 'success' && opts.verifiedExecution !== undefined;
    const declaredValidation = normalized.execution.validation;
    // GEP Gene schema 要求非空 validation。调用方没有计划时保留旧版 Node 身份检查，
    // 但它只用于形成可审阅草稿，绝不能产生 verifier 坐标或发布资格。
    const validation = declaredValidation.length > 0 ? declaredValidation : ['node --version'];
    const intake = intakeGene({
        id: `gene_conversation_${slug}_${fingerprint}`,
        summary: normalized.summary,
        category,
        signals_match: normalized.signals,
        preconditions: [
            'A live agent conversation produced a repeatable workflow or capability.',
            'The conversation includes enough evidence to reconstruct when and how to use it.',
        ],
        strategy: normalized.strategy,
        validation,
        constraints: { max_files: 20, forbidden_paths: ['.git', 'node_modules', '.env'] },
        generation_meta: { source: 'distilled' },
        model_name: normalized.model,
    });
    if (!intake.ok || !intake.gene) {
        return {
            ok: false,
            status: 'skipped',
            reason: 'gene_intake_failed',
            quality: gate,
            signals: normalized.signals,
        };
    }
    const gene = { ...intake.gene };
    // intakeGene 会从任何非空 validation 计划推导 verifier_profile。旧版身份检查并非
    // 行为验证证据，因此必须移除该坐标并重新绑定内容寻址 ID，保持严格 K_auto fail-closed。
    if (declaredValidation.length === 0) {
        delete gene.verifier_profile;
        gene.asset_id = '';
        gene.asset_id = computeAssetId(gene) ?? '';
    }
    const capsule = {
        type: 'Capsule',
        schema_version: SCHEMA_VERSION,
        id: `capsule_conversation_${slug}_${fingerprint}`,
        trigger: normalized.signals,
        gene: String(gene.id),
        summary: normalized.summary,
        confidence: Math.min(0.95, 0.5 + gate.score / 20),
        blast_radius: normalizePublishBlastRadius(normalized.execution.blast_radius, normalized.artifacts.length),
        outcome: { status: normalized.execution.status, score: normalized.execution.status === 'success' ? 0.82 : 0.35 },
        source_type: 'generated',
        strategy: normalized.strategy,
        execution_trace: normalized.execution.trace,
        a2a: { eligible_to_broadcast: publishable },
        content: capsuleContent(normalized),
        diff: null,
        reused_asset_id: null,
        env_fingerprint: {
            platform: normalized.platform,
            source_thread: normalized.source_thread || null,
            // Underlying LLM model, threaded from the originating client via input.model (resolved by
            // detectModelName() in the node's OWN process). We deliberately do NOT sniff the local process.env
            // here: distillConversation also runs inside the proxy daemon (proxyDaemon relays the wire body),
            // whose env lacks the per-session model vars — sniffing there would mis-attribute the model (#219
            // review). Falls back to 'unknown' when the caller supplied none. Lets the Hub attribute distilled
            // capsules by model (by-model leaderboard / anti-sybil), like the skill2gep capsule's env_fingerprint.
            model: normalized.model,
        },
        asset_id: '',
    };
    capsule.asset_id = computeAssetId(capsule) ?? '';
    // 质量准入可以保持宽松，但草稿仍必须是有效的 wire 记录。
    // 在持久化或排队前捕获生产者与 schema 的漂移。
    if (!validateWireDeep(stripGeneHints(gene)).ok || !validateWireDeep(capsule).ok) {
        return {
            ok: false,
            status: 'skipped',
            reason: 'wire_schema_invalid',
            quality: gate,
            signals: normalized.signals,
        };
    }
    // 只有受信任宿主验证器提供的成功 execution 才能解锁发布。
    // 本地调用方显式要求 persist 时，可以保留没有成功证据的失败草稿供人工复核，
    // 但请求体伪造的 exit-0 轨迹不能借此写入看似成功的资产。
    const persistRequested = (opts.persist ?? input.persist) === true;
    const failedDraftPersistence = !opts.verifiedExecution
        && normalized.execution.status === 'failed'
        && !normalized.execution.untrustedStatusClaim;
    const persist = persistRequested && (publishable || (gate.ok && failedDraftPersistence));
    if (persist && opts.store) {
        // Gene/Capsule 是一个可发布单元。只提供单条写入的 provider 无法恢复
        // 两次写入之间的崩溃窗口；不要用兼容回退制造孤儿 Gene。
        if (typeof opts.store.putBundle !== 'function') {
            return {
                ok: false,
                status: 'skipped',
                reason: BUNDLE_PERSISTENCE_UNSUPPORTED,
                quality: gate,
                signals: normalized.signals,
            };
        }
        await opts.store.putBundle([gene, capsule]);
    }
    return {
        ok: true,
        status: persist && opts.store ? 'stored' : 'draft',
        publishable,
        distill_id: fingerprint,
        quality: gate,
        signals: normalized.signals,
        gene,
        capsule,
    };
}