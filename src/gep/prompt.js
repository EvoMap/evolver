const { captureEnvFingerprint } = require('./envFingerprint');
const { formatAssetPreview } = require('./assets');
const { generateInnovationIdeas } = require('../ops/innovation'); // [2026-02-14] Innovation Catalyst Integration
const { analyzeRecentHistory, OPPORTUNITY_SIGNALS } = require('./signals'); // [2026-02-14] Signal Analysis Integration

/**
 * Build a minimal prompt for direct-reuse mode.
 */
function buildReusePrompt({ capsule, signals, nowIso }) {
  const payload = capsule.payload || capsule;
  const summary = payload.summary || capsule.summary || '(no summary)';
  const gene = payload.gene || capsule.gene || '(unknown)';
  const confidence = payload.confidence || capsule.confidence || 0;
  const assetId = capsule.asset_id || '(unknown)';
  const sourceNode = capsule.source_node_id || '(unknown)';
  const trigger = Array.isArray(payload.trigger || capsule.trigger_text)
    ? (payload.trigger || String(capsule.trigger_text || '').split(',')).join(', ')
    : '';

  return `
GEP -- REUSE MODE (Search-First) [${nowIso || new Date().toISOString()}]

You are applying a VERIFIED solution from the EvoMap Hub.
Source asset: ${assetId} (Node: ${sourceNode})
Confidence: ${confidence} | Gene: ${gene}
Trigger signals: ${trigger}

Summary: ${summary}

Your signals: ${JSON.stringify(signals || [])}

Instructions:
1. Read the capsule details below.
2. Apply the fix to the local codebase, adapting paths/names.
3. Run validation to confirm it works.
4. If passed, run: node index.js solidify
5. If failed, ROLLBACK and report.

Capsule payload:
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

IMPORTANT: Do NOT reinvent. Apply faithfully.
`.trim();
}

/**
 * Build a Hub Matched Solution block.
 */
function buildHubMatchedBlock({ capsule }) {
  if (!capsule) return '(no hub match)';
  const payload = capsule.payload || capsule;
  const summary = payload.summary || capsule.summary || '(no summary)';
  const gene = payload.gene || capsule.gene || '(unknown)';
  const confidence = payload.confidence || capsule.confidence || 0;
  const assetId = capsule.asset_id || '(unknown)';

  return `
Hub Matched Solution (STRONG REFERENCE):
- Asset: ${assetId} (${confidence})
- Gene: ${gene}
- Summary: ${summary}
- Payload:
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`
Use this as your primary approach if applicable. Adapt to local context.
`.trim();
}

/**
 * Truncate context intelligently to preserve header/footer structure.
 */
function truncateContext(text, maxLength = 20000) {
  if (!text || text.length <= maxLength) return text || '';
  return text.slice(0, maxLength) + '\n...[TRUNCATED_EXECUTION_CONTEXT]...';
}

/**
 * Strict schema definitions for the prompt to reduce drift.
 * UPDATED: 2026-02-14 (Protocol Drift Fix v3.2 - JSON-Only Enforcement)
 */
const SCHEMA_DEFINITIONS = `
━━━━━━━━━━━━━━━━━━━━━━
I. Mandatory Evolution Object Model (Output EXACTLY these 5 objects)
━━━━━━━━━━━━━━━━━━━━━━

Output separate JSON objects. DO NOT wrap in a single array.
DO NOT use markdown code blocks (like \`\`\`json ... \`\`\`).
Output RAW JSON ONLY. No prelude, no postscript.
Missing any object = PROTOCOL FAILURE.
ENSURE VALID JSON SYNTAX (escape quotes in strings).

0. Mutation (The Trigger) - MUST BE FIRST
   {
     "type": "Mutation",
     "id": "mut_<timestamp>",
     "category": "repair|optimize|innovate",
     "trigger_signals": ["<signal_string>"],
     "target": "<module_or_gene_id>",
     "expected_effect": "<outcome_description>",
     "risk_level": "low|medium|high",
     "rationale": "<why_this_change_is_necessary>"
   }

1. PersonalityState (The Mood)
   {
     "type": "PersonalityState",
     "rigor": 0.0-1.0,
     "creativity": 0.0-1.0,
     "verbosity": 0.0-1.0,
     "risk_tolerance": 0.0-1.0,
     "obedience": 0.0-1.0
   }

2. EvolutionEvent (The Record)
   {
     "type": "EvolutionEvent",
     "schema_version": "1.5.0",
     "id": "evt_<timestamp>",
     "parent": <parent_evt_id|null>,
     "intent": "repair|optimize|innovate",
     "signals": ["<signal_string>"],
     "genes_used": ["<gene_id>"],
     "mutation_id": "<mut_id>",
     "personality_state": { ... },
     "blast_radius": { "files": N, "lines": N },
     "outcome": { "status": "success|failed", "score": 0.0-1.0 }
   }

3. Gene (The Knowledge)
   - Reuse/update existing ID if possible. Create new only if novel pattern.
   {
     "type": "Gene",
     "schema_version": "1.5.0",
     "id": "gene_<name>",
     "category": "repair|optimize|innovate",
     "signals_match": ["<pattern>"],
     "preconditions": ["<condition>"],
     "strategy": ["<step_1>", "<step_2>"],
     "constraints": { "max_files": N, "forbidden_paths": [] },
     "validation": ["<node_command>"]
   }

4. Capsule (The Result)
   - Only on success. Reference Gene used.
   {
     "type": "Capsule",
     "schema_version": "1.5.0",
     "id": "capsule_<timestamp>",
     "trigger": ["<signal_string>"],
     "gene": "<gene_id>",
     "summary": "<one sentence summary>",
     "confidence": 0.0-1.0,
     "blast_radius": { "files": N, "lines": N }
   }
`.trim();

function buildGepPrompt({
  nowIso,
  context,
  signals,
  selector,
  parentEventId,
  selectedGene,
  capsuleCandidates,
  genesPreview,
  capsulesPreview,
  capabilityCandidatesPreview,
  externalCandidatesPreview,
  hubMatchedBlock,
  cycleId,
  recentHistory, // [2026-02-14] Pass recent history
}) {
  const parentValue = parentEventId ? `"${parentEventId}"` : 'null';
  const selectedGeneId = selectedGene && selectedGene.id ? selectedGene.id : 'gene_<name>';
  const envFingerprint = captureEnvFingerprint();
  const cycleLabel = cycleId ? ` Cycle #${cycleId}` : '';

  // Extract strategy from selected gene if available
  let strategyBlock = "";
  if (selectedGene && selectedGene.strategy && Array.isArray(selectedGene.strategy)) {
      strategyBlock = `
ACTIVE STRATEGY (${selectedGeneId}):
${selectedGene.strategy.map((s, i) => `${i + 1}. ${s}`).join('\n')}
ADHERE TO THIS STRATEGY STRICTLY.
`.trim();
  } else {
    // Fallback strategy if no gene is selected or strategy is missing
    strategyBlock = `
ACTIVE STRATEGY (Generic):
1. Analyze signals and context.
2. Select or create a Gene that addresses the root cause.
3. Apply minimal, safe changes.
4. Validate changes strictly.
5. Solidify knowledge.
`.trim();
  }
  
  // Use intelligent truncation
  const executionContext = truncateContext(context, 20000);
  
  // Strict Schema Injection
  const schemaSection = SCHEMA_DEFINITIONS.replace('<parent_evt_id|null>', parentValue);

  // Reduce noise by filtering capabilityCandidatesPreview if too large
  // If a gene is selected, we need less noise from capabilities
  let capsPreview = capabilityCandidatesPreview || '(none)';
  const capsLimit = selectedGene ? 500 : 2000;
  if (capsPreview.length > capsLimit) {
      capsPreview = capsPreview.slice(0, capsLimit) + "\n...[TRUNCATED_CAPABILITIES]...";
  }

  // Optimize signals display: truncate long signals and limit count
  const uniqueSignals = Array.from(new Set(signals || []));
  const optimizedSignals = uniqueSignals.slice(0, 50).map(s => {
    if (typeof s === 'string' && s.length > 200) {
      return s.slice(0, 200) + '...[TRUNCATED_SIGNAL]';
    }
    return s;
  });
  if (uniqueSignals.length > 50) {
      optimizedSignals.push(`...[TRUNCATED ${uniqueSignals.length - 50} SIGNALS]...`);
  }

  const formattedGenes = formatAssetPreview(genesPreview);
  const formattedCapsules = formatAssetPreview(capsulesPreview);
  
  // [2026-02-14] Innovation Catalyst Integration
  // If stagnation is detected, inject concrete innovation ideas into the prompt.
  let innovationBlock = '';
  const stagnationSignals = [
      'evolution_stagnation_detected', 
      'stable_success_plateau', 
      'repair_loop_detected',
      'force_innovation_after_repair_loop',
      'empty_cycle_loop_detected',
      'evolution_saturation'
  ];
  if (uniqueSignals.some(s => stagnationSignals.includes(s))) {
      const ideas = generateInnovationIdeas();
      if (ideas && ideas.length > 0) {
          innovationBlock = `
Context [Innovation Catalyst] (Stagnation Detected - Consider These Ideas):
${ideas.join('\n')}
`;
      }
  }

  // [2026-02-14] Strict Stagnation Directive
  // If uniqueSignals contains 'evolution_stagnation_detected' or 'stable_success_plateau',
  // inject a MANDATORY directive to force innovation and forbid repair/optimize if not strictly necessary.
  if (uniqueSignals.includes('evolution_stagnation_detected') || uniqueSignals.includes('stable_success_plateau')) {
      const stagnationDirective = `
*** CRITICAL STAGNATION DIRECTIVE ***
System has detected stagnation (repetitive cycles or lack of progress).
You MUST choose INTENT: INNOVATE.
You MUST NOT choose repair or optimize unless there is a critical blocking error (log_error).
Prefer implementing one of the Innovation Catalyst ideas above.
`;
      innovationBlock += stagnationDirective;
  }

  // [2026-02-14] Recent History Integration
  let historyBlock = '';
  if (recentHistory && recentHistory.length > 0) {
      historyBlock = `
Recent Evolution History (last 8 cycles -- DO NOT repeat the same intent+signal+gene):
${recentHistory.map((h, i) => `  ${i + 1}. [${h.intent}] signals=[${h.signals.slice(0, 2).join(', ')}] gene=${h.gene_id} outcome=${h.outcome.status} @${h.timestamp}`).join('\n')}
IMPORTANT: If you see 3+ consecutive "repair" cycles with the same gene, you MUST switch to "innovate" intent.
`.trim();
  }

  // Refactor prompt assembly to minimize token usage and maximize clarity
  // UPDATED: 2026-02-14 (Optimized Asset Embedding & Strict Schema v2.5 - JSON-Only Hardening)
  const basePrompt = `
GEP — GENOME EVOLUTION PROTOCOL (v1.10.3 STRICT)${cycleLabel} [${nowIso}]

You are a protocol-bound evolution engine. Compliance overrides optimality.

${schemaSection}

━━━━━━━━━━━━━━━━━━━━━━
II. Directives & Logic
━━━━━━━━━━━━━━━━━━━━━━

1. Intent: ${selector && selector.intent ? selector.intent.toUpperCase() : 'UNKNOWN'}
   Reason: ${(selector && selector.reason) ? (Array.isArray(selector.reason) ? selector.reason.join('; ') : selector.reason) : 'No reason provided.'}

2. Selection: Selected Gene "${selectedGeneId}".
${strategyBlock}

3. Execution: Apply changes (tool calls). Repair/Optimize: small/reversible. Innovate: new skills in \`skills/<name>/\`.
4. Validation: Run gene's validation steps. Fail = ROLLBACK.
5. Solidify: Output 5 Mandatory Objects. Update Gene/Capsule files.
6. Report: Use \`feishu-evolver-wrapper/report.js\`. Describe WHAT/WHY.

PHILOSOPHY:
- Automate Patterns: 3+ manual occurrences = tool.
- Innovate > Maintain: 60% innovation.
- Robustness: Fix recurring errors permanently.
- Blast Radius Control (CRITICAL):
  * Check file count BEFORE editing. > 80% of max_files = STOP.
  * System hard cap: 60 files / 20000 lines per cycle.
  * Repair: fix ONLY broken files. Do NOT reinstall/bulk-copy.
  * Prefer targeted edits.
- Strictness: NO CHITCHAT. NO MARKDOWN WRAPPERS around JSON. Output RAW JSON objects separated by newlines.
- NO "Here is the plan" or conversational filler. START IMMEDIATELY WITH JSON.

CONSTRAINTS:
- No \`exec\` for messaging (use feishu-post/card).
- \`exec\` usage: Only for background tasks. LOG IT. Optimize usage to avoid high token burn.
- New skills -> \`skills/<name>/\`.
- NEVER modify \`skills/evolver/\` or \`skills/feishu-evolver-wrapper/\`. These are managed through the human-reviewed release pipeline.
  Self-modification causes instability and is blocked by solidify. To enable (NOT recommended): set EVOLVE_ALLOW_SELF_MODIFY=true.

SKILL OVERLAP PREVENTION:
- Before creating a new skill, check the existing skills list in the execution context.
- If a skill with similar functionality already exists (e.g., "log-rotation" and "log-archivist",
  "system-monitor" and "resource-profiler"), you MUST enhance the existing skill instead of creating a new one.
- Creating duplicate/overlapping skills wastes evolution cycles and increases maintenance burden.
- Violation = mark outcome as FAILED with reason "skill_overlap".

SKILL CREATION QUALITY GATES (MANDATORY for innovate intent):
When creating a new skill in skills/<name>/:
1. STRUCTURE: Follow the standard skill layout:
   skills/<name>/
   |- index.js          (required: main entry with working exports)
   |- SKILL.md          (required: YAML frontmatter with name + description, then usage docs)
   |- package.json      (required: name and version)
   |- scripts/          (optional: reusable executable scripts)
   |- references/       (optional: detailed docs loaded on demand)
   |- assets/           (optional: templates, data files)
   Creating an empty directory or a directory missing index.js = FAILED.
   Do NOT create unnecessary files (README.md, CHANGELOG.md, INSTALLATION_GUIDE.md, etc.).
2. SKILL.MD FRONTMATTER: Every SKILL.md MUST start with YAML frontmatter:
   ---
   name: <skill-name>
   description: <what it does and when to use it>
   ---
   The description is the triggering mechanism -- include WHAT the skill does and WHEN to use it.
3. CONCISENESS: SKILL.md body should be under 500 lines. Keep instructions lean.
   Only include information the agent does not already know. Move detailed reference
   material to references/ files, not into SKILL.md itself.
4. EXPORT VERIFICATION: Every exported function must be importable.
   Run: node -e "const s = require('./skills/<name>'); console.log(Object.keys(s))"
   If this fails, the skill is broken. Fix before solidify.
5. NO HARDCODED SECRETS: Never embed API keys, tokens, or secrets in code.
   Use process.env or .env references. Hardcoded App ID, App Secret, Bearer tokens = FAILED.
6. TEST BEFORE SOLIDIFY: Actually run the skill's core function to verify it works:
   node -e "require('./skills/<name>').main ? require('./skills/<name>').main() : console.log('ok')"
   Scripts in scripts/ must also be tested by executing them.
7. ATOMIC CREATION: Create ALL files for a skill in a single cycle.
   Do not create a directory in one cycle and fill it in the next.
   Empty directories from failed cycles will be automatically cleaned up on rollback.

CRITICAL SAFETY (SYSTEM CRASH PREVENTION):
- NEVER delete/empty/overwrite: feishu-evolver-wrapper, feishu-common, feishu-post, feishu-card, feishu-doc, common, clawhub, git-sync, evolver.
- NEVER delete root files: MEMORY.md, SOUL.md, IDENTITY.md, AGENTS.md, USER.md, HEARTBEAT.md, RECENT_EVENTS.md, TOOLS.md, openclaw.json, .env, package.json.
- Fix broken skills; DO NOT delete and recreate.
- Violation = ROLLBACK + FAILED.

COMMON FAILURE PATTERNS:
- Blast radius exceeded.
- Omitted Mutation object.
- Merged objects into one JSON.
- Hallucinated "type": "Logic".
- "id": "mut_undefined".
- Missing "trigger_signals".
- Unrunnable validation steps.
- Markdown code blocks wrapping JSON (FORBIDDEN).

FAILURE STREAK AWARENESS:
- If "consecutive_failure_streak_N" or "failure_loop_detected":
  1. Change approach (do NOT repeat failed gene).
  2. Pick SIMPLER fix.
  3. Respect "ban_gene:<id>".

Final Directive: Every cycle must leave the system measurably better.
START IMMEDIATELY WITH RAW JSON (Mutation Object first).
DO NOT WRITE ANY INTRODUCTORY TEXT.

Context [Signals]:
${JSON.stringify(optimizedSignals)}

Context [Env Fingerprint]:
${JSON.stringify(envFingerprint, null, 2)}
${innovationBlock}
Context [Injection Hint]:
${process.env.EVOLVE_HINT ? process.env.EVOLVE_HINT : '(none)'}

Context [Gene Preview] (Reference for Strategy):
${formattedGenes}

Context [Capsule Preview] (Reference for Past Success):
${formattedCapsules}

Context [Capability Candidates]:
${capsPreview}

Context [Hub Matched Solution]:
${hubMatchedBlock || '(no hub match)'}

Context [External Candidates]:
${externalCandidatesPreview || '(none)'}

${historyBlock}

Context [Execution]:
${executionContext}

━━━━━━━━━━━━━━━━━━━━━━
MANDATORY POST-SOLIDIFY STEP (Wrapper Authority -- Cannot Be Skipped)
━━━━━━━━━━━━━━━━━━━━━━

After solidify, a status summary file MUST exist for this cycle.
Preferred path: evolver core auto-writes it during solidify.
The wrapper will handle reporting AFTER git push.
If core write is unavailable for any reason, create fallback status JSON manually.

Write a JSON file with your status:
\`\`\`bash
cat > /home/crishaocredits/.openclaw/workspace/logs/status_${cycleId}.json << 'STATUSEOF'
{
  "result": "success|failed",
  "en": "Status: [INTENT] <describe what you did in 1-2 sentences, in English>",
  "zh": "状态: [意图] <用中文描述你做了什么，1-2句>"
}
STATUSEOF
\`\`\`

Rules:
- "en" field: English status. "zh" field: Chinese status. Content must match (different language).
- Add "result" with value success or failed.
- INTENT must be one of: INNOVATION, REPAIR, OPTIMIZE (or Chinese: 创新, 修复, 优化)
- Do NOT use generic text like "Step Complete", "Cycle finished", "周期已完成". Describe the actual work.
- Example:
  {"result":"success","en":"Status: [INNOVATION] Created auto-scheduler that syncs calendar to HEARTBEAT.md","zh":"状态: [创新] 创建了自动调度器，将日历同步到 HEARTBEAT.md"}
`.trim();

  const maxChars = Number.isFinite(Number(process.env.GEP_PROMPT_MAX_CHARS)) ? Number(process.env.GEP_PROMPT_MAX_CHARS) : 50000;

  if (basePrompt.length <= maxChars) return basePrompt;
  
  const executionContextIndex = basePrompt.indexOf("Context [Execution]:");
  if (executionContextIndex > -1) {
      const prefix = basePrompt.slice(0, executionContextIndex + 20);
      const currentExecution = basePrompt.slice(executionContextIndex + 20);
      // Hard cap the execution context length to avoid token limit errors even if MAX_CHARS is high.
      // 20000 chars is roughly 5k tokens, which is safe for most models alongside the rest of the prompt.
      const EXEC_CONTEXT_CAP = 20000;
      const allowedExecutionLength = Math.min(EXEC_CONTEXT_CAP, Math.max(0, maxChars - prefix.length - 100));
      return prefix + "\n" + currentExecution.slice(0, allowedExecutionLength) + "\n...[TRUNCATED]...";
  }

  return basePrompt.slice(0, maxChars) + "\n...[TRUNCATED]...";
}

module.exports = { buildGepPrompt, buildReusePrompt, buildHubMatchedBlock };
