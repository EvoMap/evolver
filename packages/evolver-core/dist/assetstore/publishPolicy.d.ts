export declare const PUBLISH_POLICY_SCHEMA = "evolver.publish-policy.v1";
export declare const PUBLISH_POLICY_FILE = "publish-policy.json";
export declare const PUBLISH_MODES: readonly ["auto", "manual"];
export type PublishMode = (typeof PUBLISH_MODES)[number];
export interface PublishPolicy {
    mode: PublishMode;
    backgroundAutoPublish: boolean;
}
/**
 * The node's publish policy. No file keeps today's behaviour (`auto`); a file that cannot be read or parsed is read as
 * `manual`, because someone asked for a policy there and silently publishing would break that promise.
 */
export declare function readPublishPolicy(baseDir: string): PublishPolicy;
export declare function writePublishPolicy(baseDir: string, mode: PublishMode, now?: () => number): PublishPolicy;