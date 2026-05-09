'use strict';

const path = require('path');
const fs = require('fs');
const { getMemoryDir, getEvolutionDir } = require('../../gep/paths');
const { readJsonSafe, readJsonl } = require('./jsonl');
const { redactValue } = require('./redact');

function getPersonality() {
  const evoDir = getEvolutionDir();
  const memDir = getMemoryDir();
  const candidates = [
    path.join(evoDir, 'personality_state.json'),
    path.join(memDir, 'personality_state.json'),
  ];
  for (const candidate of candidates) {
    const data = readJsonSafe(candidate, null);
    if (data) return { exists: true, ...redactValue(data) };
  }
  return { exists: false, current: null, history: [] };
}

function getMemoryGraph(query = {}) {
  const limit = Math.min(Number(query.limit) || 50, 500);
  const graphPath = path.join(getEvolutionDir(), 'memory_graph.jsonl');
  if (!fs.existsSync(graphPath)) return { exists: false, items: [] };
  const rows = readJsonl(graphPath, { last: limit }).map(redactValue);
  return {
    exists: true,
    total: countLines(graphPath),
    items: rows.reverse(),
  };
}

function countLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

module.exports = { getPersonality, getMemoryGraph };
