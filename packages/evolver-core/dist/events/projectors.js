import { cycleTimelineProjector } from '../cycle/cycleTimeline.js';
export const eventCountsProjector = {
    name: 'event_counts',
    initial: () => ({ total: 0, byType: {}, lastSeq: 0 }),
    reduce: (s, e) => ({
        total: s.total + 1,
        byType: { ...s.byType, [e.type]: (s.byType[e.type] ?? 0) + 1 },
        lastSeq: Math.max(s.lastSeq, e.seq),
    }),
};
export const DEFAULT_PROJECTORS = [eventCountsProjector, cycleTimelineProjector];