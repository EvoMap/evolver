import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
export const DEFAULT_DISCOVERY_WHITELIST = [
    join(homedir(), '.claude', 'projects'),
    join(homedir(), '.codex', 'sessions'),
    join(homedir(), '.cursor'),
];
/** 源注册/发现 (批注#33): 默认只扫显式 register; 自动发现 opt-in + 白名单. */
export class SourceRegistry {
    sources = [];
    autoDiscover;
    whitelist;
    path;
    constructor(opts = {}) {
        this.autoDiscover = opts.autoDiscover ?? false;
        this.whitelist = opts.whitelist ?? DEFAULT_DISCOVERY_WHITELIST;
        this.path = opts.path;
        if (this.path && existsSync(this.path)) {
            this.sources.push(...JSON.parse(readFileSync(this.path, 'utf8')));
        }
    }
    register(s) { this.sources.push(s); this.persist(); }
    list() { return this.sources; }
    /** 自动发现根: 默认 off→空; opt-in→白名单(实际 glob 扫描在集成层). */
    discoveryRoots() { return this.autoDiscover ? [...this.whitelist] : []; }
    persist() {
        if (!this.path)
            return;
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, JSON.stringify(this.sources, null, 2));
    }
}