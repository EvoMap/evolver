import type { HubCapability } from '../hub/capability.js';
import type { ShadowSink, ShadowMode } from './sink.js';
/**
 * shadow 包 HubCapability(M8-1-shadow-c). shadow 下三类碰 hub 状态的动作只记录不执行:
 * - publish → WOULD_PUBLISH, 返回**伪正常回执**(status:accepted/terminal:false), 否则 makeHubBindings
 *   抛 PublishRejectedError 改 SyncEngine 异常/DLQ 路由污染对账(gotcha #1/#4)。
 * - task.complete → WOULD_SETTLE(ATP 结算意图, money-safety 高敏)。
 * - mailbox.push → WOULD_PUSH。
 * 其余(fetch/search/mailbox.poll/ack/status/auth/capabilities)直通真 cap(只读不碰状态)。
 * enforce 模式直接返回原 cap(零开销 pass-through, 秒级回滚)。
 */
export declare function shadowHubCapability(cap: HubCapability, sink: ShadowSink, mode: ShadowMode): HubCapability;