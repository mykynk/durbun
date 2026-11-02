/**
 * i18n core (framework-free). Features register their own dictionaries:
 *
 *   registerMessages('logs', { tr: { pause: 'Duraklat', lines: '{count} satır' }, en: { … } })
 *   t('logs.pause')                       → 'Duraklat'
 *   t('logs.lines', { count: 3 })         → '3 satır'
 *
 * Message values:
 *   - string with `{name}` placeholders; `{name, number}` formats a number for the current language;
 *   - plural object `{ one, other, zero? }` selected by `params.count` (Intl.PluralRules);
 *   - an array of candidates: the first one whose placeholders are all provided wins
 *     (used for server codes whose params may be missing).
 * Nested objects are flattened with dots. Missing keys fall back to English, then to the key itself.
 */

export type Lang = 'tr' | 'en';
export const LANGS: readonly Lang[] = ['tr', 'en'];

export interface PluralForms {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}
export type MessageValue = string | PluralForms | readonly (string | PluralForms)[];
export interface MessageTree {
  [key: string]: MessageValue | MessageTree;
}
export type TParams = Record<string, string | number | boolean | null | undefined>;
export type TFunction = (key: string, params?: TParams) => string;

const PLURAL_KEYS = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

const dictionaries: Record<Lang, Map<string, MessageValue>> = { tr: new Map(), en: new Map() };
let currentLang: Lang = 'en';
let registryVersion = 0;
const listeners = new Set<() => void>();
const warned = new Set<string>();

function isPluralForms(v: unknown): v is PluralForms {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.includes('other') && keys.every((k) => PLURAL_KEYS.has(k) && typeof (v as Record<string, unknown>)[k] === 'string');
}

function flatten(prefix: string, tree: MessageTree, out: Map<string, MessageValue>): void {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' || Array.isArray(v) || isPluralForms(v)) out.set(key, v as MessageValue);
    else if (v && typeof v === 'object') flatten(key, v as MessageTree, out);
  }
}

function notify(): void {
  for (const l of listeners) l();
}

/** Registers (or replaces) a namespace's messages for both languages. Safe to call at module load. */
export function registerMessages(namespace: string, messages: { tr: MessageTree; en: MessageTree }): void {
  for (const lang of LANGS) {
    const flat = new Map<string, MessageValue>();
    flatten(namespace, messages[lang] ?? {}, flat);
    for (const [k, v] of flat) dictionaries[lang].set(k, v);
  }
  registryVersion++;
  notify();
}

export function getLanguage(): Lang {
  return currentLang;
}

/** Sets the active language (the prefs store persists it; this only switches the dictionaries). */
export function setLanguage(lang: Lang): void {
  if (lang !== 'tr' && lang !== 'en') return;
  if (lang === currentLang) return;
  currentLang = lang;
  registryVersion++;
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  notify();
}

/** Subscribe to language/registry changes. */
export function subscribeI18n(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function i18nVersion(): number {
  return registryVersion;
}

export function hasMessage(key: string, lang: Lang = currentLang): boolean {
  return dictionaries[lang].has(key) || dictionaries.en.has(key);
}

/** Registered keys of one language (no fallback) — for parity checks in tests. */
export function messageKeys(lang: Lang): string[] {
  return [...dictionaries[lang].keys()];
}

/** Default language from the browser: Turkish when navigator.language starts with "tr", else English. */
export function detectLanguage(): Lang {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const candidates = [nav?.language, ...(nav?.languages ?? [])].filter(Boolean) as string[];
    return candidates[0]?.toLowerCase().startsWith('tr') ? 'tr' : 'en';
  } catch {
    return 'en';
  }
}

const numberFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(lang: Lang): Intl.NumberFormat {
  let nf = numberFormats.get(lang);
  if (!nf) {
    nf = new Intl.NumberFormat(lang === 'tr' ? 'tr-TR' : 'en-US', { maximumFractionDigits: 2 });
    numberFormats.set(lang, nf);
  }
  return nf;
}

const pluralRules = new Map<string, Intl.PluralRules>();
function pluralRule(lang: Lang): Intl.PluralRules {
  let pr = pluralRules.get(lang);
  if (!pr) {
    pr = new Intl.PluralRules(lang === 'tr' ? 'tr-TR' : 'en-US');
    pluralRules.set(lang, pr);
  }
  return pr;
}

const PLACEHOLDER = /\{\s*([A-Za-z0-9_.]+)\s*(?:,\s*(number)\s*)?\}/g;

function placeholdersOf(template: string): string[] {
  const names: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) names.push(m[1]!);
  return names;
}

function isProvided(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

function selectPlural(forms: PluralForms, params: TParams | undefined, lang: Lang): string {
  const count = params?.count;
  if (typeof count !== 'number') return forms.other;
  if (count === 0 && forms.zero !== undefined) return forms.zero;
  const cat = pluralRule(lang).select(count) as keyof PluralForms;
  return forms[cat] ?? forms.other;
}

/** Interpolates `{name}` / `{name, number}` placeholders. Missing params are left visible as `{name}`. */
export function interpolate(template: string, params: TParams | undefined, lang: Lang): string {
  if (!params || template.indexOf('{') < 0) return template;
  return template.replace(PLACEHOLDER, (whole, name: string, fmt?: string) => {
    const v = params[name];
    if (!isProvided(v)) return whole;
    if (fmt === 'number' && typeof v === 'number') return numberFormat(lang).format(v);
    return String(v);
  });
}

function resolveValue(value: MessageValue, params: TParams | undefined, lang: Lang): string | undefined {
  if (typeof value === 'string') return interpolate(value, params, lang);
  if (Array.isArray(value)) {
    for (const candidate of value as readonly (string | PluralForms)[]) {
      const template = typeof candidate === 'string' ? candidate : selectPlural(candidate, params, lang);
      if (placeholdersOf(template).every((p) => isProvided(params?.[p]))) return interpolate(template, params, lang);
    }
    return undefined;
  }
  return interpolate(selectPlural(value as PluralForms, params, lang), params, lang);
}

/** Translate `key` in a given language (fallback: English, then the key). */
export function translate(lang: Lang, key: string, params?: TParams): string {
  const value = dictionaries[lang].get(key) ?? dictionaries.en.get(key);
  if (value === undefined) {
    if (!warned.has(key) && isDev()) {
      warned.add(key);
      console.warn(`[i18n] missing message: ${key}`);
    }
    return key;
  }
  return resolveValue(value, params, lang) ?? key;
}

/** Translate `key` in the current language. */
export const t: TFunction = (key, params) => translate(currentLang, key, params);

/**
 * Like `t` but returns `fallback` when the key is unknown or its placeholders cannot be satisfied.
 * Used for server-provided i18n codes whose English message is the fallback.
 */
export function tOr(key: string, params: TParams | undefined, fallback: string): string {
  return translateOr(currentLang, key, params, fallback);
}

/** `tOr` for an explicit language. */
export function translateOr(lang: Lang, key: string, params: TParams | undefined, fallback: string): string {
  const value = dictionaries[lang].get(key) ?? dictionaries.en.get(key);
  if (value === undefined) return fallback;
  if (Array.isArray(value)) return resolveValue(value, params, lang) ?? fallback;
  const template = typeof value === 'string' ? value : selectPlural(value as PluralForms, params, lang);
  if (!placeholdersOf(template).every((p) => isProvided(params?.[p]))) return fallback;
  return interpolate(template, params, lang);
}

function isDev(): boolean {
  try {
    return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
}

/** Test helper: drop all registered messages. */
export function __resetI18nForTests(): void {
  dictionaries.tr.clear();
  dictionaries.en.clear();
  currentLang = 'en';
  registryVersion++;
  warned.clear();
}
