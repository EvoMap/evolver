export class Watchdog {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    check(now) {
        const idle = now - this.opts.lastWriteAt();
        if (idle >= this.opts.stallThresholdMs) {
            this.opts.onStall(idle);
            return true;
        }
        return false;
    }
}