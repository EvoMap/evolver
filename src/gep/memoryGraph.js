const fs = require('fs');
const path = require('path');
const { getMemoryDir } = require('./paths');
const { normalizePersonalityState, isValidPersonalityState, personalityKey } = require('./personality');
const { isValidMutation, normalizeMutation } = require('./mutation');

function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {}
}

function stableHash(input) {
  const s = String(input || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeErrorSignature(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  return (
    s
      .toLowerCase()
      // normalize Windows paths
      .replace(/[a-z]:\\[^ \n\r\t]+/gi, '<path>')
      // normalize Unix paths
      .replace(/\/[^ \n\r\t]+/g, '<path>')
      // normalize hex and numbers
      .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
      .replace(/\b\d+\b/g, '<n>')
      // normalize whitespace
      .replace(/\s+/g, ' ')
      .slice(0, 220)
  );
}

function normalizeSignalsForMatching(signals) {
  const list = Array.isArray(signals) ? signals : [];
  const out = [];
  for (const s of list) {
    const str = String(s || '').trim();
    if (!str) continue;
    if (str.startsWith('errsig:')) {
      const norm = normalizeErrorSignature(str.slice('errsig:'.length));
      if (norm) out.push(`errsig_norm:${stableHash(norm)}`);
      continue;
    }
    out.push(str);
  }
  return out;
}

function computeSignalKey(signals) {
  // Key must be stable across runs; normalize noisy signatures (paths, numbers).
  const list = normalizeSignalsForMatching(signals);
  const uniq = Array.from(new Set(list.filter(Boolean))).sort();
  return uniq.join('|') || '(none)';
}

function extractErrorSignatureFromSignals(signals) {
  // Convention: signals can include "errsig:<raw>" emitted by signals extractor.
  const list = Array.isArray(signals) ? signals : [];
  for (const s of list) {
    const str = String(s || '');
    if (str.startsWith('errsig:')) return normalizeErrorSignature(str.slice('errsig:'.length));
  }
  return null;
}

function memoryGraphPath() {
  const { getEvolutionDir } = require('./paths');
  const evoDir = getEvolutionDir();
  return process.env.MEMORY_GRAPH_PATH || path.join(evoDir, 'memory_graph.jsonl');
}

function memoryGraphStatePath() {
  const memoryDir = getMemoryDir();
  return path.join(evoDir, 'memory_graph_state.json');
}

function appendJsonl(filePath, obj) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function readJsonIfExists(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function tryReadMemoryGraphEvents(limitLines = 2000) {
  try {
    const p = memoryGraphPath();
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    const recent = lines.slice(Math.max(0, lines.length - limitLines));
    return recent
      .map(l => {
        try {
          return JSON.parse(l);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

function jaccard(aList, bList) {
  const aNorm = normalizeSignalsForMatching(aList);
  const bNorm = normalizeSignalsForMatching(bList);
  const a = new Set((Array.isArray(aNorm) ? aNorm : []).map(String));
  const b = new Set((Array.isArray(bNorm) ? bNorm : []).map(String));
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function decayWeight(updatedAtIso, halfLifeDays) {
  const hl = Number(halfLifeDays);
  if (!Number.isFinite(hl) || hl <= 0) return 1;
  const t = Date.parse(updatedAtIso);
  if (!Number.isFinite(t)) return 1;
  const ageDays = (Date.now() - t) / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1;
  // Exponential half-life decay: weight = 0.5^(age/hl)
  return Math.pow(0.5, ageDays / hl);
}

function aggregateEdges(events) {
  // Aggregate by (signal_key, gene_id) from outcome events.
  // Laplace smoothing to avoid 0/1 extremes.
  const map = new Map();
  for (const ev of events) {
    if (!ev || ev.type !== 'MemoryGraphEvent') continue;
    if (ev.kind !== 'outcome') continue;
    const signalKey = ev.signal && ev.signal.key ? String(ev.signal.key) : '(none)';
    const geneId = ev.gene && ev.gene.id ? String(ev.gene.id) : null;
    if (!geneId) continue;

    const k = `${signalKey}::${geneId}`;
    const cur = map.get(k) || { signalKey, geneId, success: 0, fail: 0, last_ts: null, last_score: null };
    const status = ev.outcome && ev.outcome.status ? String(ev.outcome.status) : 'unknown';
    if (status === 'success') cur.success += 1;
    else if (status === 'failed') cur.fail += 1;

    const ts = ev.ts || ev.created_at || ev.at;
    if (ts && (!cur.last_ts || Date.parse(ts) > Date.parse(cur.last_ts))) {
      cur.last_ts = ts;
      cur.last_score =
        ev.outcome && Number.isFinite(Number(ev.outcome.score)) ? Number(ev.outcome.score) : cur.last_score;
    }
    map.set(k, cur);
  }
  return map;
}

function aggregateGeneOutcomes(events) {
  // Aggregate by gene_id from outcome events (gene -> outcome success probability).
  const map = new Map();
  for (const ev of events) {
    if (!ev || ev.type !== 'MemoryGraphEvent') continue;
    if (ev.kind !== 'outcome') continue;
    const geneId = ev.gene && ev.gene.id ? String(ev.gene.id) : null;
    if (!geneId) continue;
    const cur = map.get(geneId) || { geneId, success: 0, fail: 0, last_ts: null, last_score: null };
    const status = ev.outcome && ev.outcome.status ? String(ev.outcome.status) : 'unknown';
    if (status === 'success') cur.success += 1;
    else if (status === 'failed') cur.fail += 1;
    const ts = ev.ts || ev.created_at || ev.at;
    if (ts && (!cur.last_ts || Date.parse(ts) > Date.parse(cur.last_ts))) {
      cur.last_ts = ts;
      cur.last_score =
        ev.outcome && Number.isFinite(Number(ev.outcome.score)) ? Number(ev.outcome.score) : cur.last_score;
    }
    map.set(geneId, cur);
  }
  return map;
}

function edgeExpectedSuccess(edge, opts) {
  const e = edge || { success: 0, fail: 0, last_ts: null };
  const succ = Number(e.success) || 0;
  const fail = Number(e.fail) || 0;
  const total = succ + fail;
  const p = (succ + 1) / (total + 2); // Laplace smoothing
  const halfLifeDays = opts && Number.isFinite(Number(opts.half_life_days)) ? Number(opts.half_life_days) : 30;
  const w = decayWeight(e.last_ts || '', halfLifeDays);
  return { p, w, total, value: p * w };
}

function getMemoryAdvice({ signals, genes, driftEnabled }) {
  const events = tryReadMemoryGraphEvents(2000);
  const edges = aggregateEdges(events);
  const geneOutcomes = aggregateGeneOutcomes(events);
  const curSignals = Array.isArray(signals) ? signals : [];
  const curKey = computeSignalKey(curSignals);

  const bannedGeneIds = new Set();
  const scoredGeneIds = [];

  // Similarity: consider exact key first, then any key with overlap.
  const seenKeys = new Set();
  const candidateKeys = [];
  candidateKeys.push({ key: curKey, sim: 1 });
  seenKeys.add(curKey);

  for (const ev of events) {
    if (!ev || ev.type !== 'MemoryGraphEvent') continue;
    const k = ev.signal && ev.signal.key ? String(ev.signal.key) : '(none)';
    if (seenKeys.has(k)) continue;
    const sigs = ev.signal && Array.isArray(ev.signal.signals) ? ev.signal.signals : [];
    const sim = jaccard(curSignals, sigs);
    if (sim >= 0.34) {
      candidateKeys.push({ key: k, sim });
      seenKeys.add(k);
    }
  }

  const byGene = new Map();
  for (const ck of candidateKeys) {
    for (const g of Array.isArray(genes) ? genes : []) {
      if (!g || g.type !== 'Gene' || !g.id) continue;
      const k = `${ck.key}::${g.id}`;
      const edge = edges.get(k);
      const cur = byGene.get(g.id) || { geneId: g.id, best: 0, attempts: 0, prior: 0, prior_attempts: 0 };

      // Signal->Gene edge score (if available)
      if (edge) {
        const ex = edgeExpectedSuccess(edge, { half_life_days: 30 });
        const weighted = ex.value * ck.sim;
        if (weighted > cur.best) cur.best = weighted;
        cur.attempts = Math.max(cur.attempts, ex.total);
      }

      // Gene->Outcome prior (independent of signal): stabilizer when signal edges are sparse.
      const gEdge = geneOutcomes.get(String(g.id));
      if (gEdge) {
        const gx = edgeExpectedSuccess(gEdge, { half_life_days: 45 });
        cur.prior = Math.max(cur.prior, gx.value);
        cur.prior_attempts = Math.max(cur.prior_attempts, gx.total);
      }

      byGene.set(g.id, cur);
    }
  }

  for (const [geneId, info] of byGene.entries()) {
    const combined = info.best > 0 ? info.best + info.prior * 0.12 : info.prior * 0.4;
    scoredGeneIds.push({ geneId, score: combined, attempts: info.attempts, prior: info.prior });
    // Low-efficiency path suppression (unless drift is explicit).
    if (!driftEnabled && info.attempts >= 2 && info.best < 0.18) {
      bannedGeneIds.add(geneId);
    }
    // Also suppress genes with consistently poor global outcomes when signal edges are sparse.
    if (!driftEnabled && info.attempts < 2 && info.prior_attempts >= 3 && info.prior < 0.12) {
      bannedGeneIds.add(geneId);
    }
  }

  scoredGeneIds.sort((a, b) => b.score - a.score);
  const preferredGeneId = scoredGeneIds.length ? scoredGeneIds[0].geneId : null;

  const explanation = [];
  if (preferredGeneId) explanation.push(`memory_prefer:${preferredGeneId}`);
  if (bannedGeneIds.size) explanation.push(`memory_ban:${Array.from(bannedGeneIds).slice(0, 6).join(',')}`);
  if (preferredGeneId) {
    const top = scoredGeneIds.find(x => x && x.geneId === preferredGeneId);
    if (top && Number.isFinite(Number(top.prior)) && top.prior > 0) explanation.push(`gene_prior:${top.prior.toFixed(3)}`);
  }
  if (driftEnabled) explanation.push('random_drift:enabled');

  return {
    currentSignalKey: curKey,
    preferredGeneId,
    bannedGeneIds,
    explanation,
  };
}

function recordSignalSnapshot({ signals, observations }) {
  const signalKey = computeSignalKey(signals);
  const ts = nowIso();
  const errsig = extractErrorSignatureFromSignals(signals);
  const ev = {
    type: 'MemoryGraphEvent',
    kind: 'signal',
    id: `mge_${Date.now()}_${stableHash(`${signalKey}|signal|${ts}`)}`,
    ts,
    signal: {
      key: signalKey,
      signals: Array.isArray(signals) ? signals : [],
      error_signature: errsig || null,
    },
    observed: observations && typeof observations === 'object' ? observations : null,
  };
  appendJsonl(memoryGraphPath(), ev);
  return ev;
}

function buildHypothesisText({ signalKey, signals, geneId, geneCategory, driftEnabled }) {
  const sigCount = Array.isArray(signals) ? signals.length : 0;
  const drift = driftEnabled ? 'drift' : 'directed';
  const g = geneId ? `${geneId}${geneCategory ? `(${geneCategory})` : ''}` : '(none)';
  return `Given signal_key=${signalKey} with ${sigCount} signals, selecting gene=${g} under mode=${drift} is expected to reduce repeated errors and improve stability.`;
}

function recordHypothesis({
  signals,
  mutation,
  personality_state,
  selectedGene,
  selector,
  driftEnabled,
  selectedBy,
  capsulesUsed,
  observations,
}) {
  const signalKey = computeSignalKey(signals);
  const geneId = selectedGene && selectedGene.id ? String(selectedGene.id) : null;
  const geneCategory = selectedGene && selectedGene.category ? String(selectedGene.category) : null;
  const ts = nowIso();
  const errsig = extractErrorSignatureFromSignals(signals);
  const hypothesisId = `hyp_${Date.now()}_${stableHash(`${signalKey}|${geneId || 'none'}|${ts}`)}`;
  const personalityState = personality_state || null;
  const mutNorm = mutation && isValidMutation(mutation) ? normalizeMutation(mutation) : null;
  const psNorm = personalityState && isValidPersonalityState(personalityState) ? normalizePersonalityState(personalityState) : null;
  const ev = {
    type: 'MemoryGraphEvent',
    kind: 'hypothesis',
    id: `mge_${Date.now()}_${stableHash(`${hypothesisId}|${ts}`)}`,
    ts,
    signal: { key: signalKey, signals: Array.isArray(signals) ? signals : [], error_signature: errsig || null },
    hypothesis: {
      id: hypothesisId,
      text: buildHypothesisText({ signalKey, signals, geneId, geneCategory, driftEnabled }),
      predicted_outcome: { status: null, score: null },
    },
    mutation: mutNorm
      ? {
          id: mutNorm.id,
          category: mutNorm.category,
          trigger_signals: mutNorm.trigger_signals,
          target: mutNorm.target,
          expected_effect: mutNorm.expected_effect,
          risk_level: mutNorm.risk_level,
        }
      : null,
    personality: psNorm
      ? {
          key: personalityKey(psNorm),
          state: psNorm,
        }
      : null,
    gene: { id: geneId, category: geneCategory },
    action: {
      drift: !!driftEnabled,
      selected_by: selectedBy || 'selector',
      selector: selector || null,
    },
    capsules: {
      used: Array.isArray(capsulesUsed) ? capsulesUsed.map(String).filter(Boolean) : [],
    },
    observed: observations && typeof observations === 'object' ? observations : null,
  };
  appendJsonl(memoryGraphPath(), ev);
  return { hypothesisId, signalKey };
}

function hasErrorSignal(signals) {
  const list = Array.isArray(signals) ? signals : [];
  return list.includes('log_error');
}

function recordAttempt({
  signals,
  mutation,
  personality_state,
  selectedGene,
  selector,
  driftEnabled,
  selectedBy,
  hypothesisId,
  capsulesUsed,
  observations,
}) {
  const signalKey = computeSignalKey(signals);
  const geneId = selectedGene && selectedGene.id ? String(selectedGene.id) : null;
  const geneCategory = selectedGene && selectedGene.category ? String(selectedGene.category) : null;
  const ts = nowIso();
  const errsig = extractErrorSignatureFromSignals(signals);
  const actionId = `act_${Date.now()}_${stableHash(`${signalKey}|${geneId || 'none'}|${ts}`)}`;
  const personalityState = personality_state || null;
  const mutNorm = mutation && isValidMutation(mutation) ? normalizeMutation(mutation) : null;
  const psNorm = personalityState && isValidPersonalityState(personalityState) ? normalizePersonalityState(personalityState) : null;
  const ev = {
    type: 'MemoryGraphEvent',
    kind: 'attempt',
    id: `mge_${Date.now()}_${stableHash(actionId)}`,
    ts,
    signal: { key: signalKey, signals: Array.isArray(signals) ? signals : [], error_signature: errsig || null },
    mutation: mutNorm
      ? {
          id: mutNorm.id,
          category: mutNorm.category,
          trigger_signals: mutNorm.trigger_signals,
          target: mutNorm.target,
          expected_effect: mutNorm.expected_effect,
          risk_level: mutNorm.risk_level,
        }
      : null,
    personality: psNorm
      ? {
          key: personalityKey(psNorm),
          state: psNorm,
        }
      : null,
    gene: { id: geneId, category: geneCategory },
    hypothesis: hypothesisId ? { id: String(hypothesisId) } : null,
    action: {
      id: actionId,
      drift: !!driftEnabled,
      selected_by: selectedBy || 'selector',
      selector: selector || null,
    },
    capsules: {
      used: Array.isArray(capsulesUsed) ? capsulesUsed.map(String).filter(Boolean) : [],
    },
    observed: observations && typeof observations === 'object' ? observations : null,
  };

  appendJsonl(memoryGraphPath(), ev);

  // State is mutable; graph is append-only.
  const statePath = memoryGraphStatePath();
  const state = readJsonIfExists(statePath, { last_action: null });
  state.last_action = {
    action_id: actionId,
    signal_key: signalKey,
    signals: Array.isArray(signals) ? signals : [],
    mutation_id: mutNorm ? mutNorm.id : null,
    mutation_category: mutNorm ? mutNorm.category : null,
    mutation_risk_level: mutNorm ? mutNorm.risk_level : null,
    personality_key: psNorm ? personalityKey(psNorm) : null,
    personality_state: psNorm || null,
    gene_id: geneId,
    gene_category: geneCategory,
    hypothesis_id: hypothesisId ? String(hypothesisId) : null,
    capsules_used: Array.isArray(capsulesUsed) ? capsulesUsed.map(String).filter(Boolean) : [],
    had_error: hasErrorSignal(signals),
    created_at: ts,
    outcome_recorded: false,
    baseline_observed: observations && typeof observations === 'object' ? observations : null,
  };
  writeJsonAtomic(statePath, state);

  return { actionId, signalKey };
}

function inferOutcomeFromSignals({ prevHadError, currentHasError }) {
  if (prevHadError && !currentHasError) return { status: 'success', score: 0.85, note: 'error_cleared' };
  if (prevHadError && currentHasError) return { status: 'failed', score: 0.2, note: 'error_persisted' };
  if (!prevHadError && currentHasError) return { status: 'failed', score: 0.15, note: 'new_error_appeared' };
  return { status: 'success', score: 0.6, note: 'stable_no_error' };
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function tryParseLastEvolutionEventOutcome(evidenceText) {
  // Scan tail text for an EvolutionEvent JSON line and extract its outcome.
  const s = String(evidenceText || '');
  if (!s) return null;
  const lines = s.split('\n').slice(-400);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.includes('"type"') || !line.includes('EvolutionEvent')) continue;
    try {
      const obj = JSON.parse(line);
      if (!obj || obj.type !== 'EvolutionEvent') continue;
      const o = obj.outcome && typeof obj.outcome === 'object' ? obj.outcome : null;
      if (!o) continue;
      const status = o.status === 'success' || o.status === 'failed' ? o.status : null;
      const score = Number.isFinite(Number(o.score)) ? clamp01(Number(o.score)) : null;
      if (!status && score == null) continue;
      return {
        status: status || (score != null && score >= 0.5 ? 'success' : 'failed'),
        score: score != null ? score : status === 'success' ? 0.75 : 0.25,
        note: 'evolutionevent_observed',
      };
    } catch (e) {
      continue;
    }
  }
  return null;
}

function inferOutcomeEnhanced({ prevHadError, currentHasError, baselineObserved, currentObserved }) {
  const evidence =
    currentObserved &&
    currentObserved.evidence &&
    (currentObserved.evidence.recent_session_tail || currentObserved.evidence.today_log_tail)
      ? currentObserved.evidence
      : null;
  const combinedEvidence = evidence
    ? `${String(evidence.recent_session_tail || '')}\n${String(evidence.today_log_tail || '')}`
    : '';
  const observed = tryParseLastEvolutionEventOutcome(combinedEvidence);
  if (observed) return observed;

  const base = inferOutcomeFromSignals({ prevHadError, currentHasError });

  const prevErrCount =
    baselineObserved && Number.isFinite(Number(baselineObserved.recent_error_count))
      ? Number(baselineObserved.recent_error_count)
      : null;
  const curErrCount =
    currentObserved && Number.isFinite(Number(currentObserved.recent_error_count))
      ? Number(currentObserved.recent_error_count)
      : null;

  let score = base.score;
  if (prevErrCount != null && curErrCount != null) {
    const delta = prevErrCount - curErrCount;
    score += Math.max(-0.12, Math.min(0.12, delta / 50));
  }

  const prevScan =
    baselineObserved && Number.isFinite(Number(baselineObserved.scan_ms)) ? Number(baselineObserved.scan_ms) : null;
  const curScan =
    currentObserved && Number.isFinite(Number(currentObserved.scan_ms)) ? Number(currentObserved.scan_ms) : null;
  if (prevScan != null && curScan != null && prevScan > 0) {
    const ratio = (prevScan - curScan) / prevScan;
    score += Math.max(-0.06, Math.min(0.06, ratio));
  }

  return { status: base.status, score: clamp01(score), note: `${base.note}|heuristic_delta` };
}

function buildConfidenceEdgeEvent({ signalKey, signals, geneId, geneCategory, outcomeEventId, halfLifeDays }) {
  const events = tryReadMemoryGraphEvents(2000);
  const edges = aggregateEdges(events);
  const k = `${signalKey}::${geneId}`;
  const edge = edges.get(k) || { success: 0, fail: 0, last_ts: null };
  const ex = edgeExpectedSuccess(edge, { half_life_days: halfLifeDays });
  const ts = nowIso();
  return {
    type: 'MemoryGraphEvent',
    kind: 'confidence_edge',
    id: `mge_${Date.now()}_${stableHash(`${signalKey}|${geneId}|confidence|${ts}`)}`,
    ts,
    signal: { key: signalKey, signals: Array.isArray(signals) ? signals : [] },
    gene: { id: geneId, category: geneCategory || null },
    edge: { signal_key: signalKey, gene_id: geneId },
    stats: {
      success: Number(edge.success) || 0,
      fail: Number(edge.fail) || 0,
      attempts: Number(ex.total) || 0,
      p: ex.p,
      decay_weight: ex.w,
      value: ex.value,
      half_life_days: halfLifeDays,
      updated_at: ts,
    },
    derived_from: { outcome_event_id: outcomeEventId || null },
  };
}

function buildGeneOutcomeConfidenceEvent({ geneId, geneCategory, outcomeEventId, halfLifeDays }) {
  const events = tryReadMemoryGraphEvents(2000);
  const geneOutcomes = aggregateGeneOutcomes(events);
  const edge = geneOutcomes.get(String(geneId)) || { success: 0, fail: 0, last_ts: null };
  const ex = edgeExpectedSuccess(edge, { half_life_days: halfLifeDays });
  const ts = nowIso();
  return {
    type: 'MemoryGraphEvent',
    kind: 'confidence_gene_outcome',
    id: `mge_${Date.now()}_${stableHash(`${geneId}|gene_outcome|confidence|${ts}`)}`,
    ts,
    gene: { id: String(geneId), category: geneCategory || null },
    edge: { gene_id: String(geneId) },
    stats: {
      success: Number(edge.success) || 0,
      fail: Number(edge.fail) || 0,
      attempts: Number(ex.total) || 0,
      p: ex.p,
      decay_weight: ex.w,
      value: ex.value,
      half_life_days: halfLifeDays,
      updated_at: ts,
    },
    derived_from: { outcome_event_id: outcomeEventId || null },
  };
}

function recordOutcomeFromState({ signals, observations }) {
  const statePath = memoryGraphStatePath();
  const state = readJsonIfExists(statePath, { last_action: null });
  const last = state && state.last_action ? state.last_action : null;
  if (!last || !last.action_id) return null;
  if (last.outcome_recorded) return null;

  const currentHasError = hasErrorSignal(signals);
  const inferred = inferOutcomeEnhanced({
    prevHadError: !!last.had_error,
    currentHasError,
    baselineObserved: last.baseline_observed || null,
    currentObserved: observations || null,
  });
  const ts = nowIso();
  const errsig = extractErrorSignatureFromSignals(signals);
  const ev = {
    type: 'MemoryGraphEvent',
    kind: 'outcome',
    id: `mge_${Date.now()}_${stableHash(`${last.action_id}|outcome|${ts}`)}`,
    ts,
    signal: {
      key: String(last.signal_key || '(none)'),
      signals: Array.isArray(last.signals) ? last.signals : [],
      error_signature: errsig || null,
    },
    mutation:
      last.mutation_id || last.mutation_category || last.mutation_risk_level
        ? {
            id: last.mutation_id || null,
            category: last.mutation_category || null,
            risk_level: last.mutation_risk_level || null,
          }
        : null,
    personality:
      last.personality_key || last.personality_state
        ? {
            key: last.personality_key || null,
            state: last.personality_state || null,
          }
        : null,
    gene: { id: last.gene_id || null, category: last.gene_category || null },
    action: { id: String(last.action_id) },
    hypothesis: last.hypothesis_id ? { id: String(last.hypothesis_id) } : null,
    outcome: {
      status: inferred.status,
      score: inferred.score,
      note: inferred.note,
      observed: { current_signals: Array.isArray(signals) ? signals : [] },
    },
    confidence: {
      // This is an interpretable, decayed success estimate derived from outcomes; aggregation is computed at read-time.
      half_life_days: 30,
    },
    observed: observations && typeof observations === 'object' ? observations : null,
    baseline: last.baseline_observed || null,
    capsules: {
      used: Array.isArray(last.capsules_used) ? last.capsules_used : [],
    },
  };

  appendJsonl(memoryGraphPath(), ev);

  // Persist explicit confidence snapshots (append-only) for auditability.
  try {
    if (last.gene_id) {
      const edgeEv = buildConfidenceEdgeEvent({
        signalKey: String(last.signal_key || '(none)'),
        signals: Array.isArray(last.signals) ? last.signals : [],
        geneId: String(last.gene_id),
        geneCategory: last.gene_category || null,
        outcomeEventId: ev.id,
        halfLifeDays: 30,
      });
      appendJsonl(memoryGraphPath(), edgeEv);

      const geneEv = buildGeneOutcomeConfidenceEvent({
        geneId: String(last.gene_id),
        geneCategory: last.gene_category || null,
        outcomeEventId: ev.id,
        halfLifeDays: 45,
      });
      appendJsonl(memoryGraphPath(), geneEv);
    }
  } catch (e) {}

  last.outcome_recorded = true;
  last.outcome_recorded_at = ts;
  state.last_action = last;
  writeJsonAtomic(statePath, state);

  return ev;
}

function recordExternalCandidate({ asset, source, signals }) {
  // Append-only annotation: external assets enter as candidates only.
  // This does not affect outcome aggregation (which only uses kind === 'outcome').
  const a = asset && typeof asset === 'object' ? asset : null;
  const type = a && a.type ? String(a.type) : null;
  const id = a && a.id ? String(a.id) : null;
  if (!type || !id) return null;

  const ts = nowIso();
  const signalKey = computeSignalKey(signals);
  const ev = {
    type: 'MemoryGraphEvent',
    kind: 'external_candidate',
    id: `mge_${Date.now()}_${stableHash(`${type}|${id}|external|${ts}`)}`,
    ts,
    signal: { key: signalKey, signals: Array.isArray(signals) ? signals : [] },
    external: {
      source: source || 'external',
      received_at: ts,
    },
    asset: { type, id },
    candidate: {
      // Minimal hints for later local triggering/validation.
      trigger: type === 'Capsule' && Array.isArray(a.trigger) ? a.trigger : [],
      gene: type === 'Capsule' && a.gene ? String(a.gene) : null,
      confidence: type === 'Capsule' && Number.isFinite(Number(a.confidence)) ? Number(a.confidence) : null,
    },
  };

  appendJsonl(memoryGraphPath(), ev);
  return ev;
}

module.exports = {
  memoryGraphPath,
  computeSignalKey,
  tryReadMemoryGraphEvents,
  getMemoryAdvice,
  recordSignalSnapshot,
  recordHypothesis,
  recordAttempt,
  recordOutcomeFromState,
  recordExternalCandidate,
};

