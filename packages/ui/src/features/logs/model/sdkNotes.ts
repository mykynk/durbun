import type { LogEntry } from '@durbun/protocol';
import { networkStore, useMocks } from '../../../data';
import { getLanguage, t } from '../../../i18n';
import { formatDuration } from '../../../lib/format';
import { ruleLabel } from '../../mocks/model/rules';

/**
 * Lines an SDK writes about its own setup, marked with a stable `data.reason` so the desktop can word them in the
 * viewer's language (the `message` stays English, for the app's own console and for copies made elsewhere).
 */
export type SdkNote =
  /** No HTTP client carries the SDK's interceptor some time after start: the Network tab stays empty for this app. */
  | { kind: 'noInterceptor'; afterMs?: number }
  /** A respond mock matched a call the interceptor could not answer (it sits in the network chain). */
  | { kind: 'networkInterceptor'; ruleId: string; netId?: string };

export function sdkNoteOf(e: Pick<LogEntry, 'source' | 'data' | 'appId'>): SdkNote | undefined {
  if (e.source !== 'app') return undefined;
  const d = e.data;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return undefined;
  const r = d as { reason?: unknown; afterMs?: unknown; mockRuleId?: unknown; requestId?: unknown };
  if (r.reason === 'noInterceptor') return { kind: 'noInterceptor', afterMs: typeof r.afterMs === 'number' && r.afterMs > 0 ? r.afterMs : undefined };
  if (r.reason === 'networkInterceptor' && typeof r.mockRuleId === 'string' && r.mockRuleId) {
    // The server keys an SDK request as `<appId>:<request id>`.
    const netId = typeof r.requestId === 'string' && r.requestId && e.appId ? `${e.appId}:${r.requestId}` : undefined;
    return { kind: 'networkInterceptor', ruleId: r.mockRuleId, netId };
  }
  return undefined;
}

/** The line in the interface language, or undefined when it is not such a line (callers fall back to `message`). */
export function sdkNoteText(e: Pick<LogEntry, 'source' | 'data' | 'appId' | 'message'>): string | undefined {
  const note = sdkNoteOf(e);
  if (!note) return undefined;
  if (note.kind === 'noInterceptor') {
    const ms = note.afterMs ?? 30_000;
    // A whole wait the SDK chose ("30 sn", not "30,0 sn").
    const time = ms < 60_000 ? `${Math.round(ms / 1000)} ${getLanguage() === 'tr' ? 'sn' : 's'}` : formatDuration(ms);
    return t('logs.sdkNote.noInterceptor', { time });
  }
  const rule = useMocks.getState().rules.find((r) => r.id === note.ruleId);
  // The English message names the rule as the app saw it; keep that when the rule is gone from the list.
  const name = (rule && ruleLabel(rule)) || /"([^"]+)"/.exec(e.message)?.[1] || note.ruleId;
  const net = note.netId ? networkStore.get(note.netId) : undefined;
  return net
    ? t('logs.sdkNote.networkInterceptor', { rule: name, request: `${net.method} ${net.url}` })
    : t('logs.sdkNote.networkInterceptorAny', { rule: name });
}

/**
 * A Dart stack with addresses only (a `--split-debug-info` / `--obfuscate` build): the Flutter SDK sends the exact
 * `flutter symbolize …` command in `data.symbolize`. Undefined for any other line.
 */
export function symbolizeCommandOf(e: Pick<LogEntry, 'source' | 'data'>): string | undefined {
  if (e.source !== 'app') return undefined;
  const d = e.data;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return undefined;
  const cmd = (d as { symbolize?: unknown }).symbolize;
  return typeof cmd === 'string' && cmd.trim().startsWith('flutter symbolize') ? cmd.trim() : undefined;
}

