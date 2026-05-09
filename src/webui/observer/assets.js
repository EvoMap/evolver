'use strict';

const { getObserverPaths } = require('./paths');
const { readJsonSafe, readJsonl, paginate } = require('./jsonl');
const { redactValue } = require('./redact');

function getAssetOverview(query = {}) {
  const paths = getObserverPaths();
  const genes = readGenes(paths);
  const capsules = readCapsules(paths);
  const failedCapsules = readFailedCapsules(paths);
  const events = readJsonl(paths.eventsPath, { last: query.eventsLast || 500 }).map(redactValue);
  const candidates = readJsonl(paths.candidatesPath, { last: query.candidatesLast || 200 }).map(redactValue);
  const externalCandidates = readJsonl(paths.externalCandidatesPath, { last: query.candidatesLast || 200 }).map(redactValue);
  const assetCalls = readJsonl(paths.assetCallLogPath, { last: query.assetCallsLast || 500 }).map(redactValue);

  return {
    counts: {
      genes: genes.length,
      capsules: capsules.length,
      failedCapsules: failedCapsules.length,
      events: events.length,
      candidates: candidates.length,
      externalCandidates: externalCandidates.length,
      assetCalls: assetCalls.length,
    },
    genesByCategory: countBy(genes, 'category'),
    capsulesByOutcome: countBy(capsules, (c) => c.outcome && c.outcome.status || 'unknown'),
    assetCallsByAction: countBy(assetCalls, 'action'),
    recentEvents: events.slice(-20).reverse(),
    recentAssetCalls: assetCalls.slice(-20).reverse(),
  };
}

function listGenes(query = {}) {
  const genes = readGenes(getObserverPaths());
  return {
    ...paginate(filterText(genes, query.q), query),
    categories: countBy(genes, 'category'),
  };
}

function listCapsules(query = {}) {
  const paths = getObserverPaths();
  const all = readCapsules(paths).concat(readFailedCapsules(paths).map((c) => ({ ...c, failed_store: true })));
  return {
    ...paginate(filterText(all, query.q), query),
    outcomes: countBy(all, (c) => c.outcome && c.outcome.status || 'unknown'),
  };
}

function listEvents(query = {}) {
  const events = readJsonl(getObserverPaths().eventsPath).map(redactValue).reverse();
  return paginate(filterText(events, query.q), query);
}

function listCandidates(query = {}) {
  const paths = getObserverPaths();
  const local = readJsonl(paths.candidatesPath).map((entry) => ({ ...entry, source: 'local' }));
  const external = readJsonl(paths.externalCandidatesPath).map((entry) => ({ ...entry, source: 'external' }));
  return paginate(filterText(local.concat(external).map(redactValue).reverse(), query.q), query);
}

function listAssetCalls(query = {}) {
  const calls = readJsonl(getObserverPaths().assetCallLogPath).map(redactValue).reverse();
  return paginate(filterText(calls, query.q), query);
}

function getLineage(id) {
  const paths = getObserverPaths();
  const genes = readGenes(paths);
  const capsules = readCapsules(paths).concat(readFailedCapsules(paths));
  const events = readJsonl(paths.eventsPath).map(redactValue);
  const assetCalls = readJsonl(paths.assetCallLogPath).map(redactValue);
  return {
    id,
    genes: genes.filter((g) => matchesAsset(g, id)),
    capsules: capsules.filter((c) => matchesAsset(c, id) || c.gene === id),
    events: events.filter((e) => eventMentions(e, id)),
    assetCalls: assetCalls.filter((entry) => matchesAsset(entry, id)),
  };
}

function readGenes(paths) {
  const fromJson = readJsonSafe(paths.genesPath, { genes: [] }).genes || [];
  const fromJsonl = readJsonl(paths.genesJsonlPath).filter((g) => g && g.type === 'Gene');
  return dedupeById(fromJson.concat(fromJsonl)).map(redactValue);
}

function readCapsules(paths) {
  const fromJson = readJsonSafe(paths.capsulesPath, { capsules: [] }).capsules || [];
  const fromJsonl = readJsonl(paths.capsulesJsonlPath).filter((c) => c && c.type === 'Capsule');
  return dedupeById(fromJson.concat(fromJsonl)).map(redactValue);
}

function readFailedCapsules(paths) {
  const failed = readJsonSafe(paths.failedCapsulesPath, { failed_capsules: [] }).failed_capsules || [];
  return failed.map(redactValue);
}

function dedupeById(items) {
  const out = new Map();
  for (const item of items) {
    if (item && item.id) out.set(String(item.id), item);
  }
  return Array.from(out.values());
}

function countBy(items, keyOrFn) {
  const counts = {};
  for (const item of items) {
    const key = typeof keyOrFn === 'function' ? keyOrFn(item) : item && item[keyOrFn];
    const safeKey = key || 'unknown';
    counts[safeKey] = (counts[safeKey] || 0) + 1;
  }
  return counts;
}

function filterText(items, q) {
  if (!q) return items;
  const needle = String(q).toLowerCase();
  return items.filter((item) => JSON.stringify(item).toLowerCase().includes(needle));
}

function matchesAsset(item, id) {
  if (!item || !id) return false;
  return item.id === id || item.asset_id === id || item.asset_id === `sha256:${id}`;
}

function eventMentions(event, id) {
  if (matchesAsset(event, id)) return true;
  if (event.capsule_id === id || event.mutation_id === id) return true;
  return Array.isArray(event.genes_used) && event.genes_used.includes(id);
}

module.exports = {
  getAssetOverview,
  listGenes,
  listCapsules,
  listEvents,
  listCandidates,
  listAssetCalls,
  getLineage,
  readGenes,
  readCapsules,
};
