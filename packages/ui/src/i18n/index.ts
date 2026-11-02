import { useMemo, useSyncExternalStore } from 'react';
import { getLanguage, i18nVersion, subscribeI18n, translate, type Lang, type TFunction } from './core';
import './codes';
import './foundation';

export {
  LANGS,
  detectLanguage,
  getLanguage,
  hasMessage,
  interpolate,
  registerMessages,
  setLanguage,
  subscribeI18n,
  t,
  tOr,
  translate,
  translateOr,
} from './core';
export type { Lang, MessageTree, MessageValue, PluralForms, TFunction, TParams } from './core';
export {
  tCode,
  tCodeIn,
  hasCode,
  systemLineText,
  noticeText,
  deviceStateText,
  logStatusText,
  errorText,
  errorDetail,
  deviceDisplayName,
  driverStatusText,
  localizeAdjustedDetails,
  SERVER_CODES,
  LOCAL_CODES,
  allServerCodes,
} from './codes';

/**
 * Translation function bound to the current language. The component re-renders when the language
 * changes or new messages are registered.
 *   const t = useT();  t('logs.pause');  t('logs.lines', { count: 3 })
 */
export function useT(): TFunction {
  const version = useSyncExternalStore(subscribeI18n, i18nVersion, i18nVersion);
  return useMemo<TFunction>(() => {
    const lang = getLanguage();
    return (key, params) => translate(lang, key, params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
}

/** Current UI language ('tr' | 'en'). */
export function useLanguage(): Lang {
  useSyncExternalStore(subscribeI18n, i18nVersion, i18nVersion);
  return getLanguage();
}
