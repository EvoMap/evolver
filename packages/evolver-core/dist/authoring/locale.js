/** A request's own `locale` wins over `EVOLVER_LOCALE`; anything that is not English reads as the zh-CN default. */
export function authoringLocale(requested, env) {
    const value = typeof requested === 'string' && requested ? requested : env['EVOLVER_LOCALE'];
    return typeof value === 'string' && value.toLowerCase().startsWith('en') ? 'en' : 'zh-CN';
}
export function say(locale, zh, en) {
    return locale === 'en' ? en : zh;
}