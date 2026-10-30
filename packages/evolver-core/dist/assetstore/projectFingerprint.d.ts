/**
 * Stable, path-free identity of the project a host works in: the hash of its git checkout's root and origin. Local
 * project contexts carry it so recall can tell this project's notes from another's; it never names the directory
 * itself. Undefined without an origin (or without git): a plain directory may be reused by an unrelated project, and
 * its notes are then not worth the risk of reaching the wrong one (docs/local-project-context.md). Undefined for
 * anything but an absolute path, so a caller cannot make two projects collide by sending a relative one.
 */
export declare function projectFingerprint(dir: unknown): Promise<string | undefined>;