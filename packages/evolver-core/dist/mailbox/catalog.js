export class UnknownMessageTypeError extends Error {
    type;
    constructor(type) {
        super(`未知 mailbox 消息类型: ${type}`);
        this.type = type;
        this.name = 'UnknownMessageTypeError';
    }
}
/** 三态消息目录单一来源 (mailbox 草案 §4). handler: core 确定性 / proxy non-agentic hub往返 / agent 需智能. */
export const MESSAGE_CATALOG = {
    // agent→hub (outbound)
    asset_submit: { direction: 'outbound', handler: 'proxy', feedsMaterial: false, ttlClass: 'default' },
    task_claim: { direction: 'outbound', handler: 'proxy', feedsMaterial: false, ttlClass: 'default' },
    task_complete: { direction: 'outbound', handler: 'proxy', feedsMaterial: false, ttlClass: 'default' },
    task_subscribe: { direction: 'outbound', handler: 'proxy', feedsMaterial: false, ttlClass: 'control' },
    task_unsubscribe: { direction: 'outbound', handler: 'proxy', feedsMaterial: false, ttlClass: 'control' },
    atp_order: { direction: 'outbound', handler: 'proxy', feedsMaterial: false, ttlClass: 'default' },
    atp_deliver: { direction: 'outbound', handler: 'proxy', feedsMaterial: false, ttlClass: 'default' },
    atp_settle: { direction: 'outbound', handler: 'proxy', feedsMaterial: false, ttlClass: 'default' },
    proxy_trace: { direction: 'outbound', handler: 'proxy', feedsMaterial: false, ttlClass: 'default' },
    // hub→agent / local (inbound)
    pending_materials: { direction: 'local', handler: 'agent', feedsMaterial: false, ttlClass: 'default' },
    asset_publish_result: { direction: 'inbound', handler: 'core', feedsMaterial: false, ttlClass: 'default' }, // 拒绝进 Material 在 dispatch 决定
    pending_evomap_task: { direction: 'inbound', handler: 'agent', feedsMaterial: false, ttlClass: 'default' },
    task_available: { direction: 'inbound', handler: 'agent', feedsMaterial: false, ttlClass: 'default' },
    work_assigned: { direction: 'inbound', handler: 'agent', feedsMaterial: false, ttlClass: 'default' },
    dialog_message: { direction: 'inbound', handler: 'agent', feedsMaterial: true, ttlClass: 'default' },
    peer_review_request: { direction: 'inbound', handler: 'agent', feedsMaterial: true, ttlClass: 'default' },
    bounty_review_requested: { direction: 'inbound', handler: 'agent', feedsMaterial: true, ttlClass: 'default' },
    dm: { direction: 'inbound', handler: 'agent', feedsMaterial: true, ttlClass: 'default' },
    feature_flag_update: { direction: 'inbound', handler: 'core', feedsMaterial: false, ttlClass: 'control' },
    force_update: { direction: 'inbound', handler: 'core', feedsMaterial: false, ttlClass: 'control' },
    overdue_tasks: { direction: 'inbound', handler: 'proxy', feedsMaterial: false, ttlClass: 'control' },
    heartbeat: { direction: 'outbound', handler: 'proxy', feedsMaterial: false, ttlClass: 'control' },
    credential_rotation: { direction: 'inbound', handler: 'proxy', feedsMaterial: false, ttlClass: 'control' },
    trace_collection_config: { direction: 'inbound', handler: 'proxy', feedsMaterial: false, ttlClass: 'control' },
    proxy_trace_config: { direction: 'inbound', handler: 'proxy', feedsMaterial: false, ttlClass: 'control' },
    skill_md_update: { direction: 'inbound', handler: 'proxy', feedsMaterial: false, ttlClass: 'default' },
};
const PREFIX_SPECS = [
    ['council.', { direction: 'inbound', handler: 'agent', feedsMaterial: true, ttlClass: 'default' }],
    ['deliberation.', { direction: 'inbound', handler: 'agent', feedsMaterial: true, ttlClass: 'default' }],
    ['swarm.', { direction: 'inbound', handler: 'agent', feedsMaterial: false, ttlClass: 'default' }], // 仅结论进, dispatch 决定
];
export function specForType(type) {
    return MESSAGE_CATALOG[type] ?? PREFIX_SPECS.find(([pre]) => type.startsWith(pre))?.[1];
}
export function assertKnownType(type) {
    const s = specForType(type);
    if (!s)
        throw new UnknownMessageTypeError(type);
    return s;
}