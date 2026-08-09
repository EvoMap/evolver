import { LocalMemoryGraph } from './localMemoryGraph.js';
export interface MemoryGraphOpsDeps {
    env?: Record<string, string | undefined>;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    createGraph?: (dir: string) => LocalMemoryGraph;
}
export declare function runMemoryGraphCommand(argv: readonly string[], deps?: MemoryGraphOpsDeps): Promise<number>;