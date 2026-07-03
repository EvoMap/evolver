export class StrategyPoint {
    id;
    impls = new Map();
    activeName;
    constructor(id, primary) {
        this.id = id;
        this.impls.set(primary.name, primary);
        this.activeName = primary.name;
    }
    register(s) { this.impls.set(s.name, s); return this; }
    setActive(name) {
        if (!this.impls.has(name))
            throw new Error(`StrategyPoint(${this.id}) 无实现: ${name}`);
        this.activeName = name;
        return this;
    }
    active() { return this.impls.get(this.activeName); }
    get(name) { return this.impls.get(name); }
    list() { return [...this.impls.values()]; }
    names() { return [...this.impls.keys()]; }
    /** 跑 active, 透传 ctx. */
    run(input, ctx) { return this.active().run(input, ctx); }
}