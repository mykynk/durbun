import type { UiNotice } from '@durbun/protocol';
import { getLanguage } from '../i18n/core';
import { noticeText } from '../i18n/codes';

/**
 * Toast parts for a server notice: localized text, split at the first ": " into a short title and a
 * description ("Yerel ağ modu açık: uygulamalar…" → "Yerel ağ modu açık" + "Uygulamalar…").
 */
export function noticeToastParts(n: Pick<UiNotice, 'code' | 'params' | 'message'>): { title: string; description?: string } {
  const text = noticeText(n);
  const at = text.indexOf(': ');
  if (at <= 0 || at > 64) return { title: text };
  const rest = text.slice(at + 2).trim();
  if (!rest) return { title: text.slice(0, at) };
  const locale = getLanguage() === 'tr' ? 'tr-TR' : 'en-US';
  return { title: text.slice(0, at), description: rest.charAt(0).toLocaleUpperCase(locale) + rest.slice(1) };
}
