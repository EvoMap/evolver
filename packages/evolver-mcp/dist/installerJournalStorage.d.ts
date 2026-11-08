import { type SharedFileSnapshot } from './sharedFileCommit.js';
export declare const INSTALLER_JOURNAL_STORAGE_SCHEMA = "evolver.installer.journal.v1";
type PrivateCheck = (path: string, directory: boolean) => void;
interface ArtifactSnapshots {
    before: SharedFileSnapshot;
    current: SharedFileSnapshot;
}
interface StepSnapshots {
    before: SharedFileSnapshot;
    nextRaw: string | null;
    prepared?: SharedFileSnapshot;
    displaced?: SharedFileSnapshot;
    published?: SharedFileSnapshot;
}
type EvidencePhase = 'created' | 'written' | 'synced' | 'published';
declare let evidenceHookForTest: ((phase: EvidencePhase, pending: string, path: string) => void) | undefined;
export declare function _setInstallerEvidencePhaseHookForTest(hook?: typeof evidenceHookForTest): void;
/** An owned publication event, not a durable-success receipt. */
export interface InstallerEvidencePublication {
    published?: true;
}
/** Publish private evidence without registering it as a runtime artifact. Unknown partial bytes or a
 * replaced pending inode are retained; cleanup never deletes another writer's replacement. */
export declare function publishInstallerEvidence(path: string, raw: string, existingAllowed?: boolean, publication?: InstallerEvidencePublication): void;
/** Store each exact pre/post image once. Generations reference content hashes rather than duplicating config
 * bytes in every step; otherwise a valid large config could make the rollback journal exceed its own limit. */
export declare function encodeInstallerJournal<T extends {
    artifacts: ArtifactSnapshots[];
    steps: StepSnapshots[];
}>(journal: T, dir: string, check: PrivateCheck): unknown;
export declare function decodeInstallerJournal(value: unknown, dir: string, check: PrivateCheck, cache: Map<string, string>): unknown;
export {};