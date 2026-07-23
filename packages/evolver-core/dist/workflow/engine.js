import { isRef, CORE_WHITELIST, } from './dsl.js';
export class WorkflowError extends Error {
    constructor(message) { super(message); this.name = 'WorkflowError'; }
}
/** 解析引用: input.x / steps.id.key / item[.path]. 不支持任意属性链外的求值. */
function resolveRef(ref, ctx) {
    const [head, ...rest] = ref.split('.');
    let base;
    if (head === 'input')
        base = ctx.input;
    else if (head === 'steps') {
        const stepId = rest.shift();
        base = stepId !== undefined ? ctx.steps[stepId] : undefined;
    }
    else if (head === 'item')
        base = ctx.item;
    else
        throw new WorkflowError(`非法引用根: ${head}`);
    for (const k of rest) {
        if (base == null)
            return undefined;
        base = base[k];
    }
    return base;
}
function evalValue(v, ctx) {
    return isRef(v) ? resolveRef(v.ref, ctx) : v;
}
function evalCore(call, ctx, core) {
    const fn = core[call.fn];
    if (!fn)
        throw new WorkflowError(`core 函数不在白名单: ${call.fn}`);
    return fn(...call.args.map((a) => evalValue(a, ctx)));
}
/**
 * Workflow 执行引擎(M4B-2 孵化). 解释 DAG: script(受限 core)/agent(桥)/foreach(可并行)/if.
 * 无 eval/无任意 JS; 编排层声明式, 计算只走白名单 core.
 */
export class WorkflowEngine {
    deps;
    core;
    constructor(deps) {
        this.deps = deps;
        this.core = { ...CORE_WHITELIST, ...(deps.core ?? {}) };
    }
    async run(spec) {
        const ctx = { input: spec.input ?? {}, steps: {} };
        await this.runSteps(spec.steps, ctx);
        const output = spec.output ? resolveRef(spec.output.ref, ctx) : undefined;
        return { output, ctx };
    }
    async runSteps(steps, ctx) {
        for (const step of steps)
            await this.runStep(step, ctx);
    }
    async runStep(step, ctx) {
        switch (step.kind) {
            case 'script': {
                ctx.steps[step.id] = { [step.setOutput]: evalCore(step.call, ctx, this.core) };
                return;
            }
            case 'agent': {
                ctx.steps[step.id] = { [step.outputKey ?? 'output']: await this.deps.agent(step.prompt, ctx) };
                return;
            }
            case 'if': {
                const branch = evalValue(step.cond, ctx) ? step.then : (step.else ?? []);
                await this.runSteps(branch, ctx);
                return;
            }
            case 'approval': {
                throw new WorkflowError('approval steps require DurableWorkflowRuntime');
            }
            case 'foreach': {
                const items = resolveRef(step.over.ref, ctx);
                if (!Array.isArray(items))
                    throw new WorkflowError(`foreach.over 非数组: ${step.over.ref}`);
                const runOne = async (item) => {
                    const sub = { input: ctx.input, steps: { ...ctx.steps }, item };
                    await this.runSteps(step.body, sub);
                    // 子步输出汇总: 取最后一个 body step 的输出(保证每项都处理)
                    const last = step.body[step.body.length - 1];
                    return last ? sub.steps[last.id] : undefined;
                };
                const results = step.parallel
                    ? await Promise.all(items.map(runOne))
                    : await items.reduce(async (accP, it) => { const acc = await accP; acc.push(await runOne(it)); return acc; }, Promise.resolve([]));
                ctx.steps[step.id] = { [step.collect ?? 'results']: results };
                return;
            }
            default: {
                const _exhaustive = step;
                throw new WorkflowError(`未知 step kind: ${JSON.stringify(_exhaustive)}`);
            }
        }
    }
}