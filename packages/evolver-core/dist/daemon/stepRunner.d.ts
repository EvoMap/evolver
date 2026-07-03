import { CycleContext } from './cycleContext.js';
import type { DrainController } from './drain.js';
/** loop 调度与 step 执行解耦 (批注#1): --once 与 daemon 跑同一 step 路径. */
export type StepFn = (ctx: CycleContext) => Promise<void> | void;
/** 单步 (evolver run --once 与 daemon 单轮共用). */
export declare function runStep(cycleId: string, step: StepFn): Promise<void>;
/** daemon 循环: 反复调 runStep (同一 step 路径); drain 时停接. */
export declare function runLoop(opts: {
    nextCycleId: () => string | null;
    step: StepFn;
    drain: DrainController;
}): Promise<number>;