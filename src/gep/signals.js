// Opportunity signal names (shared with mutation.js and personality.js).
var OPPORTUNITY_SIGNALS = [
  'user_feature_request',
  'user_improvement_suggestion',
  'perf_bottleneck',
  'capability_gap',
  'stable_success_plateau',
  'external_opportunity',
  'recurring_error',
  'unsupported_input_type',
  'evolution_stagnation_detected',
  'repair_loop_detected',
  'force_innovation_after_repair_loop',
];

function hasOpportunitySignal(signals) {
  var list = Array.isArray(signals) ? signals : [];
  for (var i = 0; i < OPPORTUNITY_SIGNALS.length; i++) {
    if (list.includes(OPPORTUNITY_SIGNALS[i])) return true;
  }
  return false;
}

// Build a de-duplication set from recent evolution events.
// Returns an object: { suppressedSignals: Set<string>, recentIntents: string[], consecutiveRepairCount: number }
function analyzeRecentHistory(recentEvents) {
  if (!Array.isArray(recentEvents) || recentEvents.length === 0) {
    return { suppressedSignals: new Set(), recentIntents: [], consecutiveRepairCount: 0 };
  }
  // Take only the last 10 events
  var recent = recentEvents.slice(-10);

  // Count consecutive same-intent runs at the tail
  var consecutiveRepairCount = 0;
  for (var i = recent.length - 1; i >= 0; i--) {
    if (recent[i].intent === 'repair') {
      consecutiveRepairCount++;
    } else {
      break;
    }
  }

  // Count signal frequency in last 8 events: signal -> count
  var signalFreq = {};
  var geneFreq = {};
  var tail = recent.slice(-8);
  for (var j = 0; j < tail.length; j++) {
    var evt = tail[j];
    var sigs = Array.isArray(evt.signals) ? evt.signals : [];
    for (var k = 0; k < sigs.length; k++) {
      var s = String(sigs[k]);
      // Normalize: ignore errsig details for frequency counting
      var key = s.startsWith('errsig:') ? 'errsig' : s.startsWith('recurring_errsig') ? 'recurring_errsig' : s;
      signalFreq[key] = (signalFreq[key] || 0) + 1;
    }
    var genes = Array.isArray(evt.genes_used) ? evt.genes_used : [];
    for (var g = 0; g < genes.length; g++) {
      geneFreq[String(genes[g])] = (geneFreq[String(genes[g])] || 0) + 1;
    }
  }

  // Suppress signals that appeared in 3+ of the last 8 events (they are being over-processed)
  var suppressedSignals = new Set();
  var entries = Object.entries(signalFreq);
  for (var ei = 0; ei < entries.length; ei++) {
    if (entries[ei][1] >= 3) {
      suppressedSignals.add(entries[ei][0]);
    }
  }

  var recentIntents = recent.map(function(e) { return e.intent || 'unknown'; });

  // Count empty cycles (blast_radius.files === 0) in last 8 events.
  // High ratio indicates the evolver is spinning without producing real changes.
  var emptyCycleCount = 0;
  for (var ec = 0; ec < tail.length; ec++) {
    var br = tail[ec].blast_radius;
    var em = tail[ec].meta && tail[ec].meta.empty_cycle;
    if (em || (br && br.files === 0 && br.lines === 0)) {
      emptyCycleCount++;
    }
  }

  // Count consecutive failures at the tail of recent events.
  // This tells the evolver "you have been failing N times in a row -- slow down."
  var consecutiveFailureCount = 0;
  for (var cf = recent.length - 1; cf >= 0; cf--) {
    var outcome = recent[cf].outcome;
    if (outcome && outcome.status === 'failed') {
      consecutiveFailureCount++;
    } else {
      break;
    }
  }

  // Count total failures in last 8 events (failure ratio).
  var recentFailureCount = 0;
  for (var rf = 0; rf < tail.length; rf++) {
    var rfOut = tail[rf].outcome;
    if (rfOut && rfOut.status === 'failed') recentFailureCount++;
  }

  return {
    suppressedSignals: suppressedSignals,
    recentIntents: recentIntents,
    consecutiveRepairCount: consecutiveRepairCount,
    emptyCycleCount: emptyCycleCount,
    consecutiveFailureCount: consecutiveFailureCount,
    recentFailureCount: recentFailureCount,
    recentFailureRatio: tail.length > 0 ? recentFailureCount / tail.length : 0,
    signalFreq: signalFreq,
    geneFreq: geneFreq,
  };
}

function extractSignals({ recentSessionTranscript, todayLog, memorySnippet, userSnippet, recentEvents }) {
  var signals = [];
  var corpus = [
    String(recentSessionTranscript || ''),
    String(todayLog || ''),
    String(memorySnippet || ''),
    String(userSnippet || ''),
  ].join('\n');
  var lower = corpus.toLowerCase();

  // Analyze recent evolution history for de-duplication
  var history = analyzeRecentHistory(recentEvents || []);

  // --- Defensive signals (errors, missing resources) ---

  var errorHit = /\[error|error:|exception|fail|failed|iserror":true/.test(lower);
  if (errorHit) signals.push('log_error');

  // Error signature (more reproducible than a coarse "log_error" tag).
  try {
    var lines = corpus
      .split('\n')
      .map(function (l) { return String(l || '').trim(); })
      .filter(Boolean);

    var errLine =
      lines.find(function (l) { return /\b(typeerror|referenceerror|syntaxerror)\b\s*:|error\s*:|exception\s*:|\[error/i.test(l); }) ||
      null;

    if (errLine) {
      var clipped = errLine.replace(/\s+/g, ' ').slice(0, 260);
      signals.push('errsig:' + clipped);
    }
  } catch (e) {}

  if (lower.includes('memory.md missing')) signals.push('memory_missing');
  if (lower.includes('user.md missing')) signals.push('user_missing');
  if (lower.includes('key missing')) signals.push('integration_key_missing');
  if (lower.includes('no session logs found') || lower.includes('no jsonl files')) signals.push('session_logs_missing');
  // if (lower.includes('pgrep') || lower.includes('ps aux')) signals.push('windows_shell_incompatible');
  if (lower.includes('path.resolve(__dirname, \'../../../')) signals.push('path_outside_workspace');

  // Protocol-specific drift signals
  if (lower.includes('prompt') && !lower.includes('evolutionevent')) signals.push('protocol_drift');

  // --- Recurring error detection (robustness signals) ---
  // Count repeated identical errors -- these indicate systemic issues that need automated fixes
  try {
    var errorCounts = {};
    var errPatterns = corpus.match(/(?:LLM error|"error"|"status":\s*"error")[^}]{0,200}/gi) || [];
    for (var ep = 0; ep < errPatterns.length; ep++) {
      // Normalize to a short key
      var key = errPatterns[ep].replace(/\s+/g, ' ').slice(0, 100);
      errorCounts[key] = (errorCounts[key] || 0) + 1;
    }
    var recurringErrors = Object.entries(errorCounts).filter(function (e) { return e[1] >= 3; });
    if (recurringErrors.length > 0) {
      signals.push('recurring_error');
      // Include the top recurring error signature for the agent to diagnose
      var topErr = recurringErrors.sort(function (a, b) { return b[1] - a[1]; })[0];
      signals.push('recurring_errsig(' + topErr[1] + 'x):' + topErr[0].slice(0, 150));
    }
  } catch (e) {}

  // --- Unsupported input type (e.g. GIF, video formats the LLM can't handle) ---
  if (/unsupported mime|unsupported.*type|invalid.*mime/i.test(lower)) {
    signals.push('unsupported_input_type');
  }

  // --- Opportunity signals (innovation / feature requests) ---

  // user_feature_request: user explicitly asks for a new capability
  // Look for action verbs + object patterns that indicate a feature request
  if (/\b(add|implement|create|build|make|develop|write|design)\b[^.?!\n]{3,60}\b(feature|function|module|capability|tool|support|endpoint|command|option|mode)\b/i.test(corpus)) {
    signals.push('user_feature_request');
  }
  // Also catch direct "I want/need X" patterns
  if (/\b(i want|i need|we need|please add|can you add|could you add|let'?s add)\b/i.test(lower)) {
    signals.push('user_feature_request');
  }

  // user_improvement_suggestion: user suggests making something better
  if (/\b(should be|could be better|improve|enhance|upgrade|refactor|clean up|simplify|streamline)\b/i.test(lower)) {
    // Only fire if there is no active error (to distinguish from repair requests)
    if (!errorHit) signals.push('user_improvement_suggestion');
  }

  // perf_bottleneck: performance issues detected
  if (/\b(slow|timeout|timed?\s*out|latency|bottleneck|took too long|performance issue|high cpu|high memory|oom|out of memory)\b/i.test(lower)) {
    signals.push('perf_bottleneck');
  }

  // capability_gap: something is explicitly unsupported or missing
  if (/\b(not supported|cannot|doesn'?t support|no way to|missing feature|unsupported|not available|not implemented|no support for)\b/i.test(lower)) {
    // Only fire if it is not just a missing file/config signal
    if (!signals.includes('memory_missing') && !signals.includes('user_missing') && !signals.includes('session_logs_missing')) {
      signals.push('capability_gap');
    }
  }

  // --- Tool Usage Analytics ---
  var toolUsage = {};
  var toolMatches = corpus.match(/\[TOOL:\s*(\w+)\]/g) || [];
  
  // Extract exec commands to identify benign loops (like watchdog checks)
  var execCommands = corpus.match(/exec: (node\s+[\w\/\.-]+\.js\s+ensure)/g) || [];
  var benignExecCount = execCommands.length;

  for (var i = 0; i < toolMatches.length; i++) {
    var toolName = toolMatches[i].match(/\[TOOL:\s*(\w+)\]/)[1];
    toolUsage[toolName] = (toolUsage[toolName] || 0) + 1;
  }
  
  // Adjust exec count by subtracting benign commands
  if (toolUsage['exec']) {
    toolUsage['exec'] = Math.max(0, toolUsage['exec'] - benignExecCount);
  }
  
  Object.keys(toolUsage).forEach(function(tool) {
    if (toolUsage[tool] >= 5) {
      signals.push('high_tool_usage:' + tool);
    }
    // Detect repeated exec usage (often a sign of manual loops or inefficient automation)
    if (tool === 'exec' && toolUsage[tool] >= 3) {
      signals.push('repeated_tool_usage:exec');
    }
  });

  // --- Signal prioritization ---
  // Remove cosmetic signals when actionable signals exist
  var actionable = signals.filter(function (s) {
    return s !== 'user_missing' && s !== 'memory_missing' && s !== 'session_logs_missing' && s !== 'windows_shell_incompatible';
  });
  // If we have actionable signals, drop the cosmetic ones
  if (actionable.length > 0) {
    signals = actionable;
  }

  // --- De-duplication: suppress signals that have been over-processed ---
  if (history.suppressedSignals.size > 0) {
    var beforeDedup = signals.length;
    signals = signals.filter(function (s) {
      // Normalize signal key for comparison
      var key = s.startsWith('errsig:') ? 'errsig' : s.startsWith('recurring_errsig') ? 'recurring_errsig' : s;
      return !history.suppressedSignals.has(key);
    });
    if (beforeDedup > 0 && signals.length === 0) {
      // All signals were suppressed = system is stable but stuck in a loop
      // Force innovation
      signals.push('evolution_stagnation_detected');
      signals.push('stable_success_plateau');
    }
  }

  // --- Force innovation after 3+ consecutive repairs ---
  if (history.consecutiveRepairCount >= 3) {
    // Remove repair-only signals (log_error, errsig) and inject innovation signals
    signals = signals.filter(function (s) {
      return s !== 'log_error' && !s.startsWith('errsig:') && !s.startsWith('recurring_errsig');
    });
    if (signals.length === 0) {
      signals.push('repair_loop_detected');
      signals.push('stable_success_plateau');
    }
    // Append a directive signal that the prompt can pick up
    signals.push('force_innovation_after_repair_loop');
  }

  // --- Force innovation after too many empty cycles (zero blast radius) ---
  // If >= 50% of last 8 cycles produced no code changes, the evolver is spinning idle.
  // Strip repair signals and force innovate to break the empty loop.
  if (history.emptyCycleCount >= 4) {
    signals = signals.filter(function (s) {
      return s !== 'log_error' && !s.startsWith('errsig:') && !s.startsWith('recurring_errsig');
    });
    if (!signals.includes('empty_cycle_loop_detected')) signals.push('empty_cycle_loop_detected');
    if (!signals.includes('stable_success_plateau')) signals.push('stable_success_plateau');
  }

  // --- Failure streak awareness ---
  // When the evolver has failed many consecutive cycles, inject a signal
  // telling the LLM to be more conservative and avoid repeating the same approach.
  if (history.consecutiveFailureCount >= 3) {
    signals.push('consecutive_failure_streak_' + history.consecutiveFailureCount);
    // After 5+ consecutive failures, force a strategy change (don't keep trying the same thing)
    if (history.consecutiveFailureCount >= 5) {
      signals.push('failure_loop_detected');
      // Strip the dominant gene's signals to force a different gene selection
      var topGene = null;
      var topGeneCount = 0;
      var gfEntries = Object.entries(history.geneFreq);
      for (var gfi = 0; gfi < gfEntries.length; gfi++) {
        if (gfEntries[gfi][1] > topGeneCount) {
          topGeneCount = gfEntries[gfi][1];
          topGene = gfEntries[gfi][0];
        }
      }
      if (topGene) {
        signals.push('ban_gene:' + topGene);
      }
    }
  }

  // High failure ratio in recent history (>= 75% failed in last 8 cycles)
  if (history.recentFailureRatio >= 0.75) {
    signals.push('high_failure_ratio');
    signals.push('force_innovation_after_repair_loop');
  }

  // If no signals at all, add a default innovation signal
  if (signals.length === 0) {
    signals.push('stable_success_plateau');
  }

  return Array.from(new Set(signals));
}

module.exports = { extractSignals, hasOpportunitySignal, analyzeRecentHistory, OPPORTUNITY_SIGNALS };
