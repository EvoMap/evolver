/** 闸2: drain 升级(禁 hot reload). 停接新 cycle, 排空进行中, 安全退出. */
export declare class DrainController {
    private draining;
    private active;
    acceptCycle(): boolean;
    beginCycle(): void;
    endCycle(): void;
    drain(pollMs?: number): Promise<void>;
    get isDraining(): boolean;
    get activeCount(): number;
}