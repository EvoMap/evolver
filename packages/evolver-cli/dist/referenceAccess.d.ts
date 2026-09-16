import type { AssetTrustDeps } from './assetTrust.js';
/** CLI composition只拼接runtime证据与core策略；不执行冻结轨迹中的命令。 */
export declare function runReferenceAccessCommand(argv: readonly string[], deps: AssetTrustDeps): Promise<number>;