// 报表函数单一来源已移到 @evomap/evolver-core(events/reports). 此处经顶层 events 命名空间 re-export 供 CLI 用.
import { events } from '@evomap/evolver-core';
export const readEvents = events.readEvents;
export const statusReport = events.statusReport;
export const listCycles = events.listCycles;
export const showCycle = events.showCycle;
export const listTriggers = events.listTriggers;
export const dailySummary = events.dailySummary;
export const buildNarrativeSnapshot = events.buildNarrativeSnapshot;
export const buildRetentionReport = events.buildRetentionReport;