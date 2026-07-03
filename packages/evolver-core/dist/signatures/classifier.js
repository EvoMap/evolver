const KEYWORD_TAGS = [
    [/(auth|401|403|token|credential|认证|鉴权)/i, 'auth'],
    [/\bhttp|api|request|fetch|网络|network/i, 'network'],
    [/\bdb|sql|database|prisma/i, 'db'],
    [/\btest|测试|vitest|jest/i, 'test'],
];
const FAILURE_MODES = [
    [/\btimeout|timed out|ETIMEDOUT|超时/i, 'timeout'],
    [/\bECONNRESET|reset|断开|disconnect/i, 'connection_reset'],
    [/\b401|403|unauthorized|forbidden/i, 'unauthorized'],
    [/\bENOENT|not found|404|缺失/i, 'not_found'],
];
/** MVP 规则分类器 (LLM/agent 分类器是 M4). */
export class RuleProblemClassifier {
    name = 'rules';
    classify(input) {
        const hay = `${input.text} ${input.errorClass ?? ''}`;
        const domainTags = KEYWORD_TAGS.filter(([re]) => re.test(hay)).map(([, t]) => t);
        const fm = FAILURE_MODES.find(([re]) => re.test(hay));
        if (domainTags.length === 0 && !fm)
            return null;
        return {
            problemKind: domainTags[0] ?? 'general',
            domainTags,
            affectedSurface: input.affectedSurface ?? domainTags[0] ?? 'unknown',
            failureMode: fm?.[1] ?? 'unknown',
        };
    }
}