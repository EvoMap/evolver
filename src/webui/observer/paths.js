'use strict';

const path = require('path');
const {
  getRepoRoot,
  getWorkspaceRoot,
  getEvolutionDir,
  getGepAssetsDir,
  getSkillsDir,
  getEvolverLogPath,
  getAgentSessionsDir,
  getNarrativePath,
  getReflectionLogPath,
} = require('../../gep/paths');

function getObserverPaths() {
  const evolutionDir = getEvolutionDir();
  const gepAssetsDir = getGepAssetsDir();
  return {
    repoRoot: getRepoRoot(),
    workspaceRoot: getWorkspaceRoot(),
    evolutionDir,
    gepAssetsDir,
    skillsDir: getSkillsDir(),
    agentSessionsDir: getAgentSessionsDir(),
    evolverLogPath: getEvolverLogPath(),
    cycleProgressPath: path.join(evolutionDir, 'cycle_progress.json'),
    solidifyStatePath: path.join(evolutionDir, 'evolution_solidify_state.json'),
    evolutionStatePath: path.join(evolutionDir, 'evolution_state.json'),
    pipelineEventsPath: path.join(evolutionDir, 'pipeline_events.jsonl'),
    assetCallLogPath: path.join(evolutionDir, 'asset_call_log.jsonl'),
    reflectionLogPath: getReflectionLogPath(),
    narrativePath: getNarrativePath(),
    memoryGraphPath: path.join(evolutionDir, 'memory_graph.jsonl'),
    genesPath: path.join(gepAssetsDir, 'genes.json'),
    genesJsonlPath: path.join(gepAssetsDir, 'genes.jsonl'),
    capsulesPath: path.join(gepAssetsDir, 'capsules.json'),
    capsulesJsonlPath: path.join(gepAssetsDir, 'capsules.jsonl'),
    eventsPath: path.join(gepAssetsDir, 'events.jsonl'),
    candidatesPath: path.join(gepAssetsDir, 'candidates.jsonl'),
    externalCandidatesPath: path.join(gepAssetsDir, 'external_candidates.jsonl'),
    failedCapsulesPath: path.join(gepAssetsDir, 'failed_capsules.json'),
  };
}

module.exports = { getObserverPaths };
