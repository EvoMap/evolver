import { events, observers } from '@evomap/evolver-core';
import { type MemoryGraphEventKind, type MemoryGraphEventReceipt, type MemoryGraphEventReport } from '@evomap/evolver-adapter-public';
export interface MemoryEventHub {
    recordMemoryEvent(report: MemoryGraphEventReport): Promise<MemoryGraphEventReceipt>;
}
export interface MemoryEventMirrorWiring {
    enabled: boolean;
    reason?: 'disabled' | 'no_hub';
    observer: observers.Observer | null;
}
export declare function rootEventMemoryGraphKind(type: string): MemoryGraphEventKind | null;
export declare function buildMemoryGraphMirrorEvent(event: Readonly<events.RootEvent>, opts?: {
    maxChars?: number;
    env?: Record<string, string | undefined>;
}): {
    kind: MemoryGraphEventKind;
    event: Record<string, unknown>;
} | null;
export declare function memoryEventMirrorObserver(hub: MemoryEventHub, opts?: {
    env?: Record<string, string | undefined>;
    maxChars?: number;
}): observers.Observer;
export declare function resolveMemoryEventMirrorObserver(env?: Record<string, string | undefined>, hub?: Partial<MemoryEventHub> | null): MemoryEventMirrorWiring;