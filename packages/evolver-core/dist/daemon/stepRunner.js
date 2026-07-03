import { CycleContext } from './cycleContext.js';
/** 单步 (evolver run --once 与 daemon 单轮共用). */
export async function runStep(cycleId, step) {
    const ctx = new CycleContext(cycleId); // 闸1: 每 cycle 新 context
    try {
        await step(ctx);
    }
    finally {
        ctx.dispose();
    }
}
/** daemon 循环: 反复调 runStep (同一 step 路径); drain 时停接. */
export async function runLoop(opts) {
    let n = 0;
    for (;;) {
        if (!opts.drain.acceptCycle())
            break;
        const id = opts.nextCycleId();
        if (id === null)
            break;
        opts.drain.beginCycle();
        try {
            await runStep(id, opts.step);
            n += 1;
        }
        finally {
            opts.drain.endCycle();
        }
    }
    return n;
}