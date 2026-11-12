export type AuthoringLocale = 'zh-CN' | 'en';
/** A request's own `locale` wins over `EVOLVER_LOCALE`; anything that is not English reads as the zh-CN default. */
export declare function authoringLocale(requested: unknown, env: Readonly<Record<string, string | undefined>>): AuthoringLocale;
export declare function say(locale: AuthoringLocale, zh: string, en: string): string;