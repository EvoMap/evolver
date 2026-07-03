/** 闸2: drain 升级(禁 hot reload). 停接新 cycle, 排空进行中, 安全退出. */
export class DrainController {
    draining = false;
    active = 0;
    acceptCycle() { return !this.draining; }
    beginCycle() { if (this.draining)
        throw new Error('draining: 不接新 cycle'); this.active += 1; }
    endCycle() { this.active = Math.max(0, this.active - 1); }
    async drain(pollMs = 5) {
        this.draining = true;
        while (this.active > 0)
            await new Promise((r) => { setTimeout(r, pollMs); });
    }
    get isDraining() { return this.draining; }
    get activeCount() { return this.active; }
}