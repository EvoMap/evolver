'use strict';

const fs = require('fs');

function readJsonSafe(filePath, fallback) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readJsonl(filePath, opts = {}) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    const selected = opts.last ? lines.slice(-toPositiveInt(opts.last, lines.length)) : lines;
    const rows = [];
    for (const line of selected) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        // Corrupt JSONL rows should not break the dashboard.
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function tailText(filePath, maxLines) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n');
    return lines.slice(-toPositiveInt(maxLines, 200)).join('\n');
  } catch {
    return '';
  }
}

function paginate(items, query = {}) {
  const limit = Math.min(toPositiveInt(query.limit, 50), 200);
  const offset = Math.max(0, toPositiveInt(query.offset || query.cursor, 0));
  const data = items.slice(offset, offset + limit);
  const nextOffset = offset + data.length;
  return {
    data,
    pagination: {
      limit,
      offset,
      totalItems: items.length,
      nextCursor: nextOffset < items.length ? String(nextOffset) : null,
    },
  };
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

module.exports = {
  readJsonSafe,
  readJsonl,
  tailText,
  paginate,
  toPositiveInt,
};
