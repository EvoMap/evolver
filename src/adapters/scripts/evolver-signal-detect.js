#!/usr/bin/env node
// evolver-signal-detect.js
// Lightweight signal detection on file edit events.
// Input: stdin JSON (edit event). Output: stdout JSON with additional_context.

const SIGNAL_KEYWORDS = {
  perf_bottleneck: ['timeout', 'slow', 'latency', 'bottleneck', 'oom', 'out of memory', 'performance'],
  capability_gap: ['not supported', 'unsupported', 'not implemented', 'missing feature', 'not available'],
  log_error: ['error:', 'exception:', 'typeerror', 'referenceerror', 'syntaxerror', 'failed'],
  user_feature_request: ['add feature', 'implement', 'new function', 'new module', 'please add'],
  recurring_error: ['same error', 'still failing', 'not fixed', 'keeps failing', 'repeatedly'],
  deployment_issue: ['deploy failed', 'build failed', 'ci failed', 'pipeline', 'rollback'],
  test_failure: ['test failed', 'test failure', 'assertion', 'expect(', 'assert.'],
};

function stratifyContent(text) {
  // Separate code/comments/documents to avoid false positives
  const lines = text.split('\n');
  const documentText = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip lines that are comments or code structure (not document text)
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') ||
        trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('}') ||
        trimmed.startsWith(']') || trimmed.startsWith('/*')) {
      continue;
    }
    documentText.push(line);
  }

  return documentText.join('\n');
}

function detectSignals(text) {
  if (!text || typeof text !== 'string') return [];

  // Apply stratification to reduce false positives from code/comments
  const stratified = stratifyContent(text);
  const lower = stratified.toLowerCase();

  const found = [];
  for (const [signal, keywords] of Object.entries(SIGNAL_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        found.push(signal);
        break;
      }
    }
  }
  return [...new Set(found)];
}

function getToolName(input) {
  const raw = input.tool_name || input.toolName || input.name || input.tool;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw.name === 'string') return raw.name;
  return '';
}

function isWriteLikeTool(input) {
  const name = getToolName(input).toLowerCase();
  // Older hook payloads did not include a tool name. Keep those compatible
  // and let the content/path checks below decide whether there is work to do.
  if (!name) return true;
  return (
    name === 'write' ||
    name === 'edit' ||
    name === 'multiedit' ||
    name === 'notebookedit' ||
    name === 'apply_patch' ||
    name.includes('write') ||
    name.includes('edit') ||
    name.includes('patch')
  );
}

function main() {
  let inputData = '';
  let handled = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { inputData += chunk; });
  process.stdin.on('end', () => {
    if (handled) return;
    handled = true;
    try {
      const input = inputData.trim() ? JSON.parse(inputData) : {};
      if (!isWriteLikeTool(input)) {
        process.stdout.write(JSON.stringify({}));
        return;
      }
      // Claude Code's PostToolUse payload nests tool args under tool_input.
      // Older/raw shapes put them at the top level; support both.
      const ti = input.tool_input || {};
      const tr = input.tool_response || {};
      const content = ti.content || ti.new_string || ti.file_content
        || input.content || input.file_content || input.diff || '';
      const filePath = ti.file_path || tr.filePath
        || input.path || input.file_path || '';

      const signals = detectSignals(content);

      if (signals.length === 0) {
        process.stdout.write(JSON.stringify({}));
        return;
      }

      const ctx = `[Evolution Signal] Detected: [${signals.join(', ')}] in ${filePath || 'edited file'}. Consider recording this outcome.`;
      process.stdout.write(JSON.stringify({
        additional_context: ctx,
        additionalContext: ctx,
      }));
    } catch {
      process.stdout.write(JSON.stringify({}));
    }
  });

  setTimeout(() => {
    if (handled) return;
    handled = true;
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }, 1500);
}

main();
