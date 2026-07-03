/** 加权公平队列骨架 (军杰§7): 防单一高频霸占, age_boost 防饿死. */
export class WeightedFairQueue {
    items = [];
    enqueue(item) { if (!this.items.some((i) => i.id === item.id))
        this.items.push(item); }
    size() { return this.items.length; }
    /** pick = argmax(weight + age_boost); age_boost = min(log2(1+waitMin), 4). */
    pick(now) {
        let best;
        let bestScore = -Infinity;
        for (const it of this.items) {
            const waitMin = (now - it.enqueuedAt) / 60000;
            const score = it.weight + Math.min(Math.log2(1 + Math.max(0, waitMin)), 4);
            if (score > bestScore) {
                bestScore = score;
                best = it;
            }
        }
        if (best) {
            const id = best.id;
            this.items = this.items.filter((i) => i.id !== id);
        }
        return best;
    }
}