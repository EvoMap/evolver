const fs = require('fs');
const path = require('path');
const { getMemoryDir } = require('./paths');
const { hasOpportunitySignal } = require('./mutation');

function nowIso() {
  return new Date().toISOString();
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {}
}

function readJsonIfExists(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
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

function personalityFilePath() {
  const memoryDir = getMemoryDir();
  const { getEvolutionDir } = require('./paths'); return path.join(getEvolutionDir(), 'personality_state.json');
}

function defaultPersonalityState() {
  // Conservative defaults: protocol-first, safe, low-risk.
  return {
    type: 'PersonalityState',
    rigor: 0.7,
    creativity: 0.35,
    verbosity: 0.25,
    risk_tolerance: 0.4,
    obedience: 0.85,
  };
}

function normalizePersonalityState(state) {
  const s = state && typeof state === 'object' ? state : {};
  return {
    type: 'PersonalityState',
    rigor: clamp01(s.rigor),
    creativity: clamp01(s.creativity),
    verbosity: clamp01(s.verbosity),
    risk_tolerance: clamp01(s.risk_tolerance),
    obedience: clamp01(s.obedience),
  };
}

function isValidPersonalityState(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.type !== 'PersonalityState') return false;
  for (const k of ['rigor', 'creativity', 'verbosity', 'risk_tolerance', 'obedience']) {
    const v = obj[k];
    if (!Number.isFinite(Number(v))) return false;
    const n = Number(v);
    if (n < 0 || n > 1) return false;
  }
  return true;
}

function roundToStep(x, step) {
  const s = Number(step);
  if (!Number.isFinite(s) || s <= 0) return x;
  return Math.round(Number(x) / s) * s;
}

function personalityKey(state) {
  const s = normalizePersonalityState(state);
  const step = 0.1;
  const r = roundToStep(s.rigor, step).toFixed(1);
  const c = roundToStep(s.creativity, step).toFixed(1);
  const v = roundToStep(s.verbosity, step).toFixed(1);
  const rt = roundToStep(s.risk_tolerance, step).toFixed(1);
  const o = roundToStep(s.obedience, step).toFixed(1);
  return `rigor=${r}|creativity=${c}|verbosity=${v}|risk_tolerance=${rt}|obedience=${o}`;
}

function getParamDeltas(fromState, toState) {
  const a = normalizePersonalityState(fromState);
  const b = normalizePersonalityState(toState);
  const deltas = [];
  for (const k of ['rigor', 'creativity', 'verbosity', 'risk_tolerance', 'obedience']) {
    deltas.push({ param: k, delta: Number(b[k]) - Number(a[k]) });
  }
  deltas.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return deltas;
}

function personalityScore(statsEntry) {
  const e = statsEntry && typeof statsEntry === 'object' ? statsEntry : {};
  const succ = Number(e.success) || 0;
  const fail = Number(e.fail) || 0;
  const total = succ + fail;
  // Laplace-smoothed success probability
  const p = (succ + 1) / (total + 2);
  // Penalize tiny-sample overconfidence
  const sampleWeight = Math.min(1, total / 8);
  // Use avg_score (if present) as mild quality proxy
  const avg = Number.isFinite(Number(e.avg_score)) ? Number(e.avg_score) : null;
  const q = avg == null ? 0.5 : clamp01(avg);
  return p * 0.75 + q * 0.25 * sampleWeight;
}

function chooseBestKnownPersonality(statsByKey) {
  const stats = statsByKey && typeof statsByKey === 'object' ? statsByKey : {};
  let best = null;
  for (const [k, entry] of Object.entries(stats)) {
    const e = entry || {};
    const total = (Number(e.success) || 0) + (Number(e.fail) || 0);
    if (total < 3) continue;
    const sc = personalityScore(e);
    if (!best || sc > best.score) best = { key: k, score: sc, entry: e };
  }
  return best;
}

function parseKeyToState(key) {
  // key format: rigor=0.7|creativity=0.3|...
  const out = defaultPersonalityState();
  const parts = String(key || '').split('|').map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    const [k, v] = p.split('=').map(x => String(x || '').trim());
    if (!k) continue;
    if (!['rigor', 'creativity', 'verbosity', 'risk_tolerance', 'obedience'].includes(k)) continue;
    out[k] = clamp01(Number(v));
  }
  return normalizePersonalityState(out);
}

function applyPersonalityMutations(state, mutations) {
  let cur = normalizePersonalityState(state);
  const muts = Array.isArray(mutations) ? mutations : [];
  const applied = [];
  let count = 0;
  for (const m of muts) {
    if (!m || typeof m !== 'object') continue;
    const param = String(m.param || '').trim();
    if (!['rigor', 'creativity', 'verbosity', 'risk_tolerance', 'obedience'].includes(param)) continue;
    const delta = Number(m.delta);
    if (!Number.isFinite(delta)) continue;
    const clipped = Math.max(-0.2, Math.min(0.2, delta));
    cur[param] = clamp01(Number(cur[param]) + clipped);
    applied.push({ type: 'PersonalityMutation', param, delta: clipped, reason: String(m.reason || '').slice(0, 140) });
    count += 1;
    if (count >= 2) break;
  }
  return { state: cur, applied };
}

function proposeMutations({ baseState, reason, driftEnabled, signals }) {
  const s = normalizePersonalityState(baseState);
  const sig = Array.isArray(signals) ? signals.map(x => String(x || '')) : [];
  const muts = [];

  const r = String(reason || '');
  if (driftEnabled) {
    muts.push({ type: 'PersonalityMutation', param: 'creativity', delta: +0.1, reason: r || 'drift enabled' });
    // Keep risk bounded under drift by default.
    muts.push({ type: 'PersonalityMutation', param: 'risk_tolerance', delta: -0.05, reason: 'drift safety clamp' });
  } else if (sig.includes('protocol_drift')) {
    muts.push({ type: 'PersonalityMutation', param: 'obedience', delta: +0.1, reason: r || 'protocol drift' });
    muts.push({ type: 'PersonalityMutation', param: 'rigor', delta: +0.05, reason: 'tighten protocol compliance' });
  } else if (sig.includes('log_error') || sig.some(x => x.startsWith('errsig:') || x.startsWith('errsig_norm:'))) {
    muts.push({ type: 'PersonalityMutation', param: 'rigor', delta: +0.1, reason: r || 'repair instability' });
    muts.push({ type: 'PersonalityMutation', param: 'risk_tolerance', delta: -0.1, reason: 'reduce risky changes under errors' });
  } else if (hasOpportunitySignal(sig)) {
    // Opportunity detected: nudge towards creativity to enable innovation.
    muts.push({ type: 'PersonalityMutation', param: 'creativity', delta: +0.1, reason: r || 'opportunity signal detected' });
    muts.push({ type: 'PersonalityMutation', param: 'risk_tolerance', delta: +0.05, reason: 'allow exploration for innovation' });
  } else {
    // Plateau-like generic: slightly increase rigor, slightly decrease verbosity (more concise execution).
    muts.push({ type: 'PersonalityMutation', param: 'rigor', delta: +0.05, reason: r || 'stability bias' });
    muts.push({ type: 'PersonalityMutation', param: 'verbosity', delta: -0.05, reason: 'reduce noise' });
  }

  // If already very high obedience, avoid pushing it further; swap second mutation to creativity.
  if (s.obedience >= 0.95) {
    const idx = muts.findIndex(x => x.param === 'obedience');
    if (idx >= 0) muts[idx] = { type: 'PersonalityMutation', param: 'creativity', delta: +0.05, reason: 'obedience saturated' };
  }
  return muts;
}

function shouldTriggerPersonalityMutation({ driftEnabled, recentEvents }) {
  if (driftEnabled) return { ok: true, reason: 'drift enabled' };
  const list = Array.isArray(recentEvents) ? recentEvents : [];
  const tail = list.slice(-6);
  const outcomes = tail
    .map(e => (e && e.outcome && e.outcome.status ? String(e.outcome.status) : null))
    .filter(Boolean);
  if (outcomes.length >= 4) {
    const recentFailed = outcomes.slice(-4).filter(x => x === 'failed').length;
    if (recentFailed >= 3) return { ok: true, reason: 'long failure streak' };
  }
  // Mutation consecutive failure proxy: last 3 events that have mutation_id.
  const withMut = tail.filter(e => e && typeof e.mutation_id === 'string' && e.mutation_id);
  if (withMut.length >= 3) {
    const last3 = withMut.slice(-3);
    const fail3 = last3.filter(e => e && e.outcome && e.outcome.status === 'failed').length;
    if (fail3 >= 3) return { ok: true, reason: 'mutation consecutive failures' };
  }
  return { ok: false, reason: '' };
}

function loadPersonalityModel() {
  const p = personalityFilePath();
  const fallback = {
    version: 1,
    current: defaultPersonalityState(),
    stats: {},
    history: [],
    updated_at: nowIso(),
  };
  const raw = readJsonIfExists(p, fallback);
  const cur = normalizePersonalityState(raw && raw.current ? raw.current : defaultPersonalityState());
  const stats = raw && typeof raw.stats === 'object' ? raw.stats : {};
  const history = Array.isArray(raw && raw.history) ? raw.history : [];
  return { version: 1, current: cur, stats, history, updated_at: raw && raw.updated_at ? raw.updated_at : nowIso() };
}

function savePersonalityModel(model) {
  const m = model && typeof model === 'object' ? model : {};
  const out = {
    version: 1,
    current: normalizePersonalityState(m.current || defaultPersonalityState()),
    stats: m.stats && typeof m.stats === 'object' ? m.stats : {},
    history: Array.isArray(m.history) ? m.history.slice(-120) : [],
    updated_at: nowIso(),
  };
  writeJsonAtomic(personalityFilePath(), out);
  return out;
}

function selectPersonalityForRun({ driftEnabled, signals, recentEvents } = {}) {
  const model = loadPersonalityModel();
  const base = normalizePersonalityState(model.current);
  const stats = model.stats || {};

  const best = chooseBestKnownPersonality(stats);
  let naturalSelectionApplied = [];

  // Natural selection: nudge towards the best-known configuration (small, max 2 params).
  if (best && best.key) {
    const bestState = parseKeyToState(best.key);
    const diffs = getParamDeltas(base, bestState).filter(d => Math.abs(d.delta) >= 0.05);
    const muts = [];
    for (const d of diffs.slice(0, 2)) {
      const clipped = Math.max(-0.1, Math.min(0.1, d.delta));
      muts.push({ type: 'PersonalityMutation', param: d.param, delta: clipped, reason: 'natural_selection' });
    }
    const applied = applyPersonalityMutations(base, muts);
    model.current = applied.state;
    naturalSelectionApplied = applied.applied;
  }

  // Triggered personality mutation (explicit rule-based).
  const trig = shouldTriggerPersonalityMutation({ driftEnabled: !!driftEnabled, recentEvents });
  let triggeredApplied = [];
  if (trig.ok) {
    const props = proposeMutations({
      baseState: model.current,
      reason: trig.reason,
      driftEnabled: !!driftEnabled,
      signals,
    });
    const applied = applyPersonalityMutations(model.current, props);
    model.current = applied.state;
    triggeredApplied = applied.applied;
  }

  // Persist updated current state.
  const saved = savePersonalityModel(model);
  const key = personalityKey(saved.current);
  const known = !!(saved.stats && saved.stats[key]);

  return {
    personality_state: saved.current,
    personality_key: key,
    personality_known: known,
    personality_mutations: [...naturalSelectionApplied, ...triggeredApplied],
    model_meta: {
      best_known_key: best && best.key ? best.key : null,
      best_known_score: best && Number.isFinite(Number(best.score)) ? Number(best.score) : null,
      triggered: trig.ok ? { reason: trig.reason } : null,
    },
  };
}

function updatePersonalityStats({ personalityState, outcome, score, notes } = {}) {
  const model = loadPersonalityModel();
  const st = normalizePersonalityState(personalityState || model.current);
  const key = personalityKey(st);
  if (!model.stats || typeof model.stats !== 'object') model.stats = {};
  const cur = model.stats[key] && typeof model.stats[key] === 'object' ? model.stats[key] : { success: 0, fail: 0, avg_score: 0.5, n: 0 };

  const out = String(outcome || '').toLowerCase();
  if (out === 'success') cur.success = (Number(cur.success) || 0) + 1;
  else if (out === 'failed') cur.fail = (Number(cur.fail) || 0) + 1;

  const sc = Number.isFinite(Number(score)) ? clamp01(Number(score)) : null;
  if (sc != null) {
    const n = (Number(cur.n) || 0) + 1;
    const prev = Number.isFinite(Number(cur.avg_score)) ? Number(cur.avg_score) : 0.5;
    cur.avg_score = prev + (sc - prev) / n;
    cur.n = n;
  }
  cur.updated_at = nowIso();
  model.stats[key] = cur;

  model.history = Array.isArray(model.history) ? model.history : [];
  model.history.push({
    at: nowIso(),
    key,
    outcome: out === 'success' || out === 'failed' ? out : 'unknown',
    score: sc,
    notes: notes ? String(notes).slice(0, 220) : null,
  });

  savePersonalityModel(model);
  return { key, stats: cur };
}

module.exports = {
  clamp01,
  defaultPersonalityState,
  normalizePersonalityState,
  isValidPersonalityState,
  personalityKey,
  loadPersonalityModel,
  savePersonalityModel,
  selectPersonalityForRun,
  updatePersonalityStats,
};

