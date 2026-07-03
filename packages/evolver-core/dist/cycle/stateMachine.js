export const TERMINAL = new Set(['solidified', 'failed', 'aborted']);
const ALLOWED = {
    none: ['started'],
    started: ['signals_collected', 'gene_selected', 'failed', 'aborted'],
    signals_collected: ['gene_selected', 'failed', 'aborted'],
    gene_selected: ['mutation_built', 'solidified', 'failed', 'aborted'],
    mutation_built: ['solidified', 'failed', 'aborted'],
    solidified: [], failed: [], aborted: [],
};
/** 事件类型 → 它把 cycle 推进到的 stage (非 stage 事件返回 null). */
export function stageForEventType(type) {
    switch (type) {
        case 'cycle.started': return 'started';
        case 'cycle.signals_collected': return 'signals_collected';
        case 'decision.gene_selected': return 'gene_selected';
        case 'mutation.built': return 'mutation_built';
        case 'cycle.solidified': return 'solidified';
        case 'cycle.failed': return 'failed';
        case 'cycle.aborted': return 'aborted';
        default: return null;
    }
}
export function canTransition(from, to) {
    return ALLOWED[from].includes(to);
}