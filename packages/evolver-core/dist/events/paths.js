import { homedir } from 'node:os';
import { join } from 'node:path';
/** ~/.evomap, 可 EVOLVER_HOME/EVOMAP_HOME 覆盖. */
export function evomapHome() {
    return process.env['EVOLVER_HOME'] ?? process.env['EVOMAP_HOME'] ?? join(homedir(), '.evomap');
}
export function rootEventsPath() {
    return join(evomapHome(), 'evolution', 'root_events.jsonl');
}
export function mvDir() {
    return join(evomapHome(), 'evolution', 'mv');
}
/** 可进化人格模型持久化文件 (五维向量 + 各键统计 + 变更历史). v1 personality_state.json 的 v2 落点. */
export function personalityStatePath() {
    return join(evomapHome(), 'evolution', 'personality_state.json');
}
export function assetsDir() {
    return join(evomapHome(), 'assets');
}
/** M1 raw-material substrate (append-only jsonl consumed by the cycle). */
export function materialDir() {
    return join(evomapHome(), 'evolution', 'material');
}
/** MaterialStore backing file. */
export function materialStorePath() {
    return join(materialDir(), 'material.jsonl');
}
/** Per-source watermark cursor used to make re-ingest idempotent (file-level dedup). */
export function materialWatermarkPath() {
    return join(materialDir(), 'watermark.json');
}
/** Proxy LLM-trace day-files dir (`llm-trace-YYYYMMDD.jsonl`), the route-savings source for the value ledger.
 *  Mirrors the proxy's EVOLVER_LLM_TRACE_DIR default so the outreach layer reads what the proxy wrote. */
export function tracesDir() {
    return process.env['EVOLVER_LLM_TRACE_DIR'] ?? join(evomapHome(), 'proxy', 'traces');
}
/** Hub-asset audit trail (`asset_call_log.jsonl`): one JSONL line per hub-asset interaction (search hit/miss,
 *  reuse/reference, publish, review). Written best-effort by AssetCallLog; the desktop's RecallHistory / 召回历程
 *  reads it. Defaults to the evomap home root, beside assets/ + evolution/.
 *  NOTE(reuse/#234): confirm this matches where the proxy/RecallHistory reads — best-effort append, so a path
 *  mismatch degrades the audit line, never the reuse write itself. */
export function assetCallLogPath() {
    return join(evomapHome(), 'asset_call_log.jsonl');
}