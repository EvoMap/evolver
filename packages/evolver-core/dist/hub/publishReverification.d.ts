import { type AssetRecord } from '../assetstore/provider.js';
import { type PublishBindingReceipt } from './publishBinding.js';
import type { ConversationDistillVerifiedExecution } from './conversationDistiller.js';
export interface PublishReverificationCandidate {
    sourceAssetIds: string[];
    gene: AssetRecord;
    validation: string[];
    input: Record<string, unknown>;
}
/** 显式迁移入口的 source gate；返回原规范化记录，不把 schema 检查视图写回历史资产。 */
export declare function normalizePublishReverificationSource(asset: AssetRecord): AssetRecord;
/** 明确重新执行旧 wire pair 的 validation；不导入旧 receipt，也不修改历史资产。 */
export declare function preparePublishReverification(assets: readonly AssetRecord[], env?: Record<string, string | undefined>): PublishReverificationCandidate;
export declare function completePublishReverification(candidate: PublishReverificationCandidate, execution: ConversationDistillVerifiedExecution, env?: Record<string, string | undefined>): {
    assets: [AssetRecord, AssetRecord];
    publish_receipt: PublishBindingReceipt;
    source_asset_ids: string[];
};