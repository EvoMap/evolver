// ---------------------------------------------------------------------------
// taskReceiver -- pulls external tasks from Hub, auto-claims, and injects
// them as high-priority signals into the evolution loop.
//
// v2: Smart task selection with difficulty-aware ROI scoring and capability
//     matching via memory graph history.
// ---------------------------------------------------------------------------

const { getNodeId } = require('./a2aProtocol');

const HUB_URL = process.env.A2A_HUB_URL || process.env.EVOMAP_HUB_URL || 'https://evomap.ai';

const TASK_STRATEGY = String(process.env.TASK_STRATEGY || 'balanced').toLowerCase();
const TASK_MIN_CAPABILITY_MATCH = Number(process.env.TASK_MIN_CAPABILITY_MATCH) || 0.1;

// Scoring weights by strategy
const STRATEGY_WEIGHTS = {
  greedy:       { roi: 0.10, capability: 0.05, completion: 0.05, bounty: 0.80 },
  balanced:     { roi: 0.35, capability: 0.30, completion: 0.20, bounty: 0.15 },
  conservative: { roi: 0.25, capability: 0.45, completion: 0.25, bounty: 0.05 },
};

/**
 * Fetch available tasks from Hub via the A2A fetch endpoint.
 * Optionally piggybacks proactive questions in the payload for Hub to create bounties.
 *
 * @param {object} [opts]
 * @param {Array<{ question: string, amount?: number, signals?: string[] }>} [opts.questions]
 * @returns {{ tasks: Array, questions_created?: Array }}
 */
async function fetchTasks(opts) {
  const o = opts || {};
  const nodeId = getNodeId();
  if (!nodeId) return { tasks: [] };

  try {
    const payload = {
      asset_type: null,
      include_tasks: true,
    };

    if (Array.isArray(o.questions) && o.questions.length > 0) {
      payload.questions = o.questions;
    }

    const msg = {
      protocol: 'gep-a2a',
      protocol_version: '1.0.0',
      message_type: 'fetch',
      message_id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sender_id: nodeId,
      timestamp: new Date().toISOString(),
      payload,
    };

    const url = `${HUB_URL.replace(/\/+$/, '')}/a2a/fetch`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return { tasks: [] };

    const data = await res.json();
    const respPayload = data.payload || data;
    const tasks = Array.isArray(respPayload.tasks) ? respPayload.tasks : [];
    const result = { tasks };

    if (respPayload.questions_created) {
      result.questions_created = respPayload.questions_created;
    }

    // LessonL: extract relevant lessons from Hub response
    if (Array.isArray(respPayload.relevant_lessons) && respPayload.relevant_lessons.length > 0) {
      result.relevant_lessons = respPayload.relevant_lessons;
    }

    return result;
  } catch (err) {
    console.warn("[TaskReceiver] fetchTasks failed:", err && err.message ? err.message : err);
    return { tasks: [] };
  }
}

// ---------------------------------------------------------------------------
// Capability matching: how well this agent's history matches a task's signals
// ---------------------------------------------------------------------------

function parseSignals(raw) {
  if (!raw) return [];
  return String(raw).split(',').map(function(s) { return s.trim().toLowerCase(); }).filter(Boolean);
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  var setA = new Set(a);
  var setB = new Set(b);
  var inter = 0;
  for (var v of setB) { if (setA.has(v)) inter++; }
  return inter / (setA.size + setB.size - inter);
}

/**
 * Estimate how well this agent can handle a task based on memory graph history.
 * Returns 0.0 - 1.0 where 1.0 = strong match with high success rate.
 *
 * @param {object} task - task from Hub (has .signals field)
 * @param {Array} memoryEvents - from tryReadMemoryGraphEvents()
 * @returns {number}
 */
function estimateCapabilityMatch(task, memoryEvents) {
  if (!Array.isArray(memoryEvents) || memoryEvents.length === 0) return 0.5;

  var taskSignals = parseSignals(task.signals || task.title);
  if (taskSignals.length === 0) return 0.5;

  var successBySignalKey = {};
  var totalBySignalKey = {};
  var allSignals = {};

  for (var i = 0; i < memoryEvents.length; i++) {
    var ev = memoryEvents[i];
    if (!ev || ev.type !== 'MemoryGraphEvent' || ev.kind !== 'outcome') continue;

    var sigs = (ev.signal && Array.isArray(ev.signal.signals)) ? ev.signal.signals : [];
    var key = (ev.signal && ev.signal.key) ? String(ev.signal.key) : '';
    var status = (ev.outcome && ev.outcome.status) ? String(ev.outcome.status) : '';

    for (var j = 0; j < sigs.length; j++) {
      allSignals[sigs[j].toLowerCase()] = true;
    }

    if (!key) continue;
    if (!totalBySignalKey[key]) { totalBySignalKey[key] = 0; successBySignalKey[key] = 0; }
    totalBySignalKey[key]++;
    if (status === 'success') successBySignalKey[key]++;
  }

  // Jaccard overlap between task signals and all signals this agent has worked with
  var allSigArr = Object.keys(allSignals);
  var overlapScore = jaccard(taskSignals, allSigArr);

  // Weighted success rate across matching signal keys
  var weightedSuccess = 0;
  var weightSum = 0;
  for (var sk in totalBySignalKey) {
    // Reconstruct signals from the key for comparison
    var skParts = sk.split('|').map(function(s) { return s.trim().toLowerCase(); }).filter(Boolean);
    var sim = jaccard(taskSignals, skParts);
    if (sim < 0.15) continue;

    var total = totalBySignalKey[sk];
    var succ = successBySignalKey[sk] || 0;
    var rate = (succ + 1) / (total + 2); // Laplace smoothing
    weightedSuccess += rate * sim;
    weightSum += sim;
  }

  var successScore = weightSum > 0 ? (weightedSuccess / weightSum) : 0.5;

  // Combine: 60% success rate history + 40% signal overlap
  return Math.min(1, overlapScore * 0.4 + successScore * 0.6);
}

// ---------------------------------------------------------------------------
// Local fallback difficulty estimation when Hub doesn't provide complexity_score
// ---------------------------------------------------------------------------

function localDifficultyEstimate(task) {
  var signals = parseSignals(task.signals);
  var signalFactor = Math.min(signals.length / 8, 1);

  var titleWords = (task.title || '').split(/\s+/).filter(Boolean).length;
  var titleFactor = Math.min(titleWords / 15, 1);

  return Math.min(1, signalFactor * 0.6 + titleFactor * 0.4);
}

// ---------------------------------------------------------------------------
// Score a single task for this agent
// ---------------------------------------------------------------------------

/**
 * @param {object} task - task from Hub
 * @param {number} capabilityMatch - from estimateCapabilityMatch()
 * @returns {{ composite: number, factors: object }}
 */
function scoreTask(task, capabilityMatch) {
  var w = STRATEGY_WEIGHTS[TASK_STRATEGY] || STRATEGY_WEIGHTS.balanced;

  var difficulty = (task.complexity_score != null) ? task.complexity_score : localDifficultyEstimate(task);
  var bountyAmount = task.bounty_amount || 0;
  var completionRate = (task.historical_completion_rate != null) ? task.historical_completion_rate : 0.5;

  // ROI: bounty per unit difficulty (higher = better value)
  var roiRaw = bountyAmount / (difficulty + 0.1);
  var roiNorm = Math.min(roiRaw / 200, 1); // normalize: 200-credit ROI = max

  // Bounty absolute: normalize against a reference max
  var bountyNorm = Math.min(bountyAmount / 100, 1);

  var composite =
    w.roi * roiNorm +
    w.capability * capabilityMatch +
    w.completion * completionRate +
    w.bounty * bountyNorm;

  return {
    composite: Math.round(composite * 1000) / 1000,
    factors: {
      roi: Math.round(roiNorm * 100) / 100,
      capability: Math.round(capabilityMatch * 100) / 100,
      completion: Math.round(completionRate * 100) / 100,
      bounty: Math.round(bountyNorm * 100) / 100,
      difficulty: Math.round(difficulty * 100) / 100,
    },
  };
}

// ---------------------------------------------------------------------------
// Enhanced task selection with scoring
// ---------------------------------------------------------------------------

/**
 * Pick the best task from a list using composite scoring.
 * @param {Array} tasks
 * @param {Array} [memoryEvents] - from tryReadMemoryGraphEvents()
 * @returns {object|null}
 */
function selectBestTask(tasks, memoryEvents) {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;

  var nodeId = getNodeId();

  // Already-claimed tasks for this node always take top priority (resume work)
  var myClaimedTask = tasks.find(function(t) {
    return t.status === 'claimed' && t.claimed_by === nodeId;
  });
  if (myClaimedTask) return myClaimedTask;

  // Filter to open tasks only
  var open = tasks.filter(function(t) { return t.status === 'open'; });
  if (open.length === 0) return null;

  // Legacy greedy mode: preserve old behavior exactly
  if (TASK_STRATEGY === 'greedy' && (!memoryEvents || memoryEvents.length === 0)) {
    var bountyTasks = open.filter(function(t) { return t.bounty_id; });
    if (bountyTasks.length > 0) {
      bountyTasks.sort(function(a, b) { return (b.bounty_amount || 0) - (a.bounty_amount || 0); });
      return bountyTasks[0];
    }
    return open[0];
  }

  // Score all open tasks
  var scored = open.map(function(t) {
    var cap = estimateCapabilityMatch(t, memoryEvents || []);
    var result = scoreTask(t, cap);
    return { task: t, composite: result.composite, factors: result.factors, capability: cap };
  });

  // Filter by minimum capability match (unless conservative skipping is off)
  if (TASK_MIN_CAPABILITY_MATCH > 0) {
    var filtered = scored.filter(function(s) { return s.capability >= TASK_MIN_CAPABILITY_MATCH; });
    if (filtered.length > 0) scored = filtered;
  }

  scored.sort(function(a, b) { return b.composite - a.composite; });

  // Log top 3 candidates for debugging
  var top3 = scored.slice(0, 3);
  for (var i = 0; i < top3.length; i++) {
    var s = top3[i];
    console.log('[TaskStrategy] #' + (i + 1) + ' "' + (s.task.title || s.task.task_id || '').slice(0, 50) + '" score=' + s.composite + ' ' + JSON.stringify(s.factors));
  }

  return scored[0] ? scored[0].task : null;
}

/**
 * Claim a task on the Hub.
 * @param {string} taskId
 * @returns {boolean} true if claim succeeded
 */
async function claimTask(taskId) {
  const nodeId = getNodeId();
  if (!nodeId || !taskId) return false;

  try {
    const url = `${HUB_URL.replace(/\/+$/, '')}/a2a/task/claim`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, node_id: nodeId }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Complete a task on the Hub with the result asset ID.
 * @param {string} taskId
 * @param {string} assetId
 * @returns {boolean}
 */
async function completeTask(taskId, assetId) {
  const nodeId = getNodeId();
  if (!nodeId || !taskId || !assetId) return false;

  try {
    const url = `${HUB_URL.replace(/\/+$/, '')}/a2a/task/complete`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, asset_id: assetId, node_id: nodeId }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Extract signals from a task to inject into evolution cycle.
 * @param {object} task
 * @returns {string[]} signals array
 */
function taskToSignals(task) {
  if (!task) return [];
  const signals = [];
  if (task.signals) {
    const parts = String(task.signals).split(',').map(s => s.trim()).filter(Boolean);
    signals.push(...parts);
  }
  if (task.title) {
    const words = String(task.title).toLowerCase().split(/\s+/).filter(w => w.length >= 3);
    for (const w of words.slice(0, 5)) {
      if (!signals.includes(w)) signals.push(w);
    }
  }
  signals.push('external_task');
  if (task.bounty_id) signals.push('bounty_task');
  return signals;
}

module.exports = {
  fetchTasks,
  selectBestTask,
  estimateCapabilityMatch,
  scoreTask,
  claimTask,
  completeTask,
  taskToSignals,
};
