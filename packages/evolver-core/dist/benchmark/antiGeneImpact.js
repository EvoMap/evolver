export function summarizeOverblockedAntiGenes(taskResults) {
    const byId = new Map();
    for (const task of taskResults) {
        if (!task.antiGene.overblocked)
            continue;
        for (const antiGeneId of new Set(task.antiGene.observedAntiWarnings)) {
            const row = byId.get(antiGeneId) ?? { count: 0, taskIds: new Set() };
            row.count += 1;
            row.taskIds.add(task.taskId);
            byId.set(antiGeneId, row);
        }
    }
    return [...byId.entries()]
        .map(([antiGeneId, row]) => ({ antiGeneId, count: row.count, taskIds: [...row.taskIds].sort() }))
        .sort((a, b) => b.count - a.count || a.antiGeneId.localeCompare(b.antiGeneId));
}
export function parseOverblockedAntiGenes(value) {
    if (!Array.isArray(value))
        return null;
    const out = [];
    for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            return null;
        const row = item;
        if (typeof row['antiGeneId'] !== 'string')
            return null;
        if (typeof row['count'] !== 'number' || !Number.isFinite(row['count']))
            return null;
        if (!Array.isArray(row['taskIds']) || !row['taskIds'].every((taskId) => typeof taskId === 'string'))
            return null;
        out.push({ antiGeneId: row['antiGeneId'], count: row['count'], taskIds: [...row['taskIds']] });
    }
    return out;
}