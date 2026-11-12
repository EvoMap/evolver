import { DEFAULT_FORBIDDEN_PATHS, HEADINGS, yamlScalar } from './geneMarkdown.js';
const TEMPLATE_HINTS = {
    'zh-CN': {
        title: '一句话标题，例如：统一日期格式后再排序',
        summary: '用一两句话说清楚：解决什么问题，在什么条件下有效（至少 40 个字）。',
        use: '遇到什么任务或报错时用，例如：CSV 日期列格式不一致导致排序错乱',
        notUse: '什么时候不该用，例如：日期列本来就是统一的 ISO 格式',
        preconditions: '开始前必须满足的条件（可选）',
        steps: '每一步写一个具体动作，第一步就是要先做的事',
        validation: '能在本机重放的检查命令，例如：npm test',
        success: '怎样算成功，例如：输出按日期升序且没有丢行',
    },
    en: {
        title: 'A one-line title, e.g. Normalize date formats before sorting',
        summary: 'One or two sentences: what it solves and when it works (at least 40 characters).',
        use: 'The task or error it fits, e.g. a CSV date column mixes formats and sorts wrongly',
        notUse: 'When it must not be used, e.g. the column is already ISO dates',
        preconditions: 'What must hold before the first step (optional)',
        steps: 'One concrete action per step; the first step is what to do first',
        validation: 'A check you can replay locally, e.g. npm test',
        success: 'What success looks like, e.g. rows sorted by date ascending, none dropped',
    },
};
/** A fill-in GENE.md for `category`: hints live in HTML comments, so building the untouched template yields no content. */
export function geneTemplateMarkdown(category, locale) {
    const hint = TEMPLATE_HINTS[locale];
    const section = (name, ordered = false) => ['', `## ${HEADINGS[name][locale]}`, '', `<!-- ${hint[name]} -->`, ordered ? '1. ' : '- '];
    return [
        '---',
        `category: ${yamlScalar(category)}`,
        'signals:',
        '  - ',
        'max_files: 1',
        'forbidden_paths:',
        ...DEFAULT_FORBIDDEN_PATHS.map((path) => `  - ${path}`),
        '---',
        '',
        `# <!-- ${hint.title} -->`,
        '',
        `<!-- ${hint.summary} -->`,
        ...section('use'),
        ...section('notUse'),
        ...section('steps', true),
        ...section('validation'),
        ...section('success'),
        '',
    ].join('\n');
}