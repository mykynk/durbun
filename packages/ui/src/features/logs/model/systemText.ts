import type { LogEntry } from '@durbun/protocol';
import { systemLineText } from '../../../i18n';

/**
 * Localized text of a Dürbün system line (lifecycle separators, markers — SPEC §9.2). The shared
 * `code.*` dictionary understands the params the server sends (`{device}`, `{app}`, `{process}`,
 * `{label, n}`, `failedRequests`…); unknown codes fall back to the server's English message.
 */
export function systemText(e: Pick<LogEntry, 'code' | 'params' | 'message'>): string {
  return systemLineText({ code: e.code, params: e.params, message: e.message });
}
