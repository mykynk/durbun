import type { NetworkEntry, ReplayOverrides } from '@durbun/protocol';
import { api, compileScope, getScope, logStore, onNotice, sendCommand, ui, useHub } from '../../data';
import { copyText, downloadUrl, formatBytes, formatDuration, toast } from '../../components';
import { errorText, t } from '../../i18n';
import { copyAs, type CopyFormat, type CopyNote } from './model/copyAs';
import { safeFileStem } from './model/http';
import { cachedDetail, loadDetail } from './detailCache';
import { draftFromRequest, type DraftNote } from '../mocks/model/draft';
import { transfer } from '../transfer/store';
import { networkActionAvailability, type NetworkEntryAction } from '../../data/explain';
import { streamKindLabel } from './model/streams';
import './i18n';

/** Why an action cannot run on this request (null: it can); the rule itself is `networkActionAvailability`. */
export function actionBlockText(e: Pick<NetworkEntry, 'method' | 'stream'>, action: NetworkEntryAction): string | null {
  const a = networkActionAvailability(e, action);
  if (a.ok) return null;
  if (a.reason === 'noRequest') return t('network.unavailable.noRequest');
  return t(`network.unavailable.stream.${action}`, { kind: streamKindLabel(a.reason === 'sse' ? 'sse' : 'websocket') });
}

/** Short menu hint for an unavailable action ("not for WebSocket"), or undefined. */
export function actionBlockHint(e: Pick<NetworkEntry, 'method' | 'stream'>, action: NetworkEntryAction): string | undefined {
  const a = networkActionAvailability(e, action);
  if (a.ok || a.reason === 'noRequest') return undefined;
  return t('network.unavailable.short', { kind: streamKindLabel(a.reason === 'sse' ? 'sse' : 'websocket') });
}

/** Whether an action can run on this request. */
export function canRun(e: Pick<NetworkEntry, 'method' | 'stream'>, action: NetworkEntryAction): boolean {
  return networkActionAvailability(e, action).ok;
}

/** Actions on a captured request, shared by the table's context menu, the detail panel and the palette. */

export const FORMAT_LABEL: Record<CopyFormat, string> = {
  curl: 'cURL',
  fetch: 'fetch',
  dio: 'Dart (dio)',
  swift: 'Swift (URLSession)',
  kotlin: 'Kotlin (OkHttp)',
};

export function bundleIdOf(appId: string | undefined): string | undefined {
  return appId ? useHub.getState().apps[appId]?.app.id : undefined;
}

/**
 * The app a request belongs to when its session is no longer known: the scoped app, when the request is in that
 * scope (a mock made from it then targets that app, not every app).
 */
function scopeBundleOf(e: NetworkEntry): string | undefined {
  const compiled = compileScope(getScope(), useHub.getState());
  return compiled.bundleId && compiled.network(e) ? compiled.bundleId : undefined;
}

export async function copyUrl(e: NetworkEntry): Promise<void> {
  if (await copyText(e.url)) toast.success(t('network.toast.urlCopied'));
  else toast.error(t('network.toast.copyFailed'));
}

function noteText(n: CopyNote): string {
  switch (n.code) {
    case 'bodyNotCaptured':
      return t('network.copyNotes.bodyNotCaptured');
    case 'bodyTruncated':
      return t('network.copyNotes.bodyTruncated', { captured: formatBytes(n.captured), size: formatBytes(n.size) });
    case 'binaryBody':
      return t('network.copyNotes.binaryBody', { size: formatBytes(n.size) });
    case 'bodyOmitted':
      return t('network.copyNotes.bodyOmitted', { size: formatBytes(n.size) });
  }
}

/** Copy the request as cURL / fetch / dio / Swift / Kotlin (fetches the body first when needed). */
export async function copyEntryAs(e: NetworkEntry, format: CopyFormat): Promise<void> {
  let detail = cachedDetail(e);
  if (!detail && e.hasRequestBody) {
    try {
      detail = await loadDetail(e);
    } catch (err) {
      toast.warn(t('network.toast.bodyUnavailable'), { description: errorText(err) });
    }
  }
  const res = copyAs(format, { method: e.method, url: e.url, headers: e.requestHeaders, body: detail?.requestBody ?? null, hasBody: e.hasRequestBody && !detail });
  const description = res.notes.map(noteText).join(' ') || undefined;
  if (await copyText(res.code)) {
    toast.success(t('network.toast.copiedAs', { format: FORMAT_LABEL[format] }), { description });
  } else {
    // Clipboard writes can need a fresh user gesture after an await: offer a retry button.
    toast.error(t('network.toast.copyFailed'), { action: { label: t('network.toast.copyAgain'), onClick: () => void copyText(res.code) }, duration: 10_000 });
  }
}

/** `net.replay` (optionally edited). Resolves with the new entry (state may be 'failed'), or null on error. */
export async function replayRequest(e: NetworkEntry, overrides?: ReplayOverrides): Promise<NetworkEntry | null> {
  const blocked = actionBlockText(e, overrides ? 'editReplay' : 'replay');
  if (blocked) {
    toast.info(blocked);
    return null;
  }
  const toastId = toast({ kind: 'info', title: t('network.replay.sending', { method: overrides?.method ?? e.method, host: e.host }), duration: 0 });
  // The server says before its reply when the certificate was refused (a test server with its own CA).
  let tlsRejected = false;
  const off = onNotice((n) => {
    if (n.code === 'replay.tlsRejected') tlsRejected = true;
  });
  try {
    const res = await sendCommand({ name: 'net.replay', id: e.id, overrides });
    toast.dismiss(toastId);
    if (res.state === 'failed' && tlsRejected && !overrides?.skipTlsVerify) {
      toast.error(t('network.replay.failed'), {
        description: `${res.error ?? ''} ${t('network.replay.tlsOffer')}`.trim(),
        duration: 15_000,
        action: { label: t('network.replay.resendUnverified'), onClick: () => void replayRequest(e, { ...overrides, skipTlsVerify: true }) },
      });
    } else if (res.state === 'failed') {
      toast.error(t('network.replay.failed'), { description: res.error });
    } else {
      toast.success(t('network.replay.done', { status: res.status ?? '—', duration: formatDuration(res.duration) }), overrides?.skipTlsVerify ? { description: t('network.replay.sentUnverified') } : undefined);
    }
    return res;
  } catch (err) {
    toast.dismiss(toastId);
    toast.error(t('network.replay.error'), { description: errorText(err) });
    return null;
  } finally {
    off();
  }
}

/**
 * Jump to the log row of this request (scans the log ring from the newest end). The log memory fills at its own
 * pace: when the request's own line is gone, Logs opens the moments around the request's start instead.
 */
export function showInLogs(e: NetworkEntry): void {
  const entries = logStore.entries;
  for (let i = entries.length - 1; i >= 0; i--) {
    const row = entries[i]!;
    if (row.netId === e.id) {
      ui.focusLog(row.id);
      return;
    }
  }
  ui.focusLogTime(e.startTs, { deviceId: e.deviceId, appId: e.appId, reason: 'requestLineGone' });
}

function draftNoteText(n: DraftNote): string | null {
  switch (n) {
    case 'bodyNotCaptured':
      return t('network.mockNotes.bodyNotCaptured');
    case 'bodyTruncated':
      return t('network.mockNotes.bodyTruncated');
    case 'bodyEvicted':
      return t('network.mockNotes.bodyEvicted');
    case 'graphqlSharedUrl':
      return t('network.mockNotes.graphqlSharedUrl');
    case 'noResponse':
      return t('network.mockNotes.noResponse');
    case 'detailUnavailable':
      return t('network.mockNotes.detailUnavailable');
  }
}

/** Open the Mocks editor with a rule prefilled from this request/response (not saved yet). */
export async function createMockFrom(e: NetworkEntry): Promise<void> {
  const blocked = actionBlockText(e, 'mock');
  if (blocked) {
    toast.info(blocked);
    return;
  }
  let detail = cachedDetail(e) ?? null;
  if (!detail && (e.hasResponseBody || e.hasRequestBody)) {
    try {
      detail = await loadDetail(e);
    } catch {
      detail = null;
    }
  }
  const { draft, notes } = draftFromRequest(e, detail, bundleIdOf(e.appId) ?? scopeBundleOf(e));
  ui.newMockFromDraft(draft);
  const texts = notes.map(draftNoteText).filter((s): s is string => !!s);
  if (texts.length > 0) toast.warn(t('network.mockNotes.title'), { description: texts.join(' '), duration: 9000 });
}

/**
 * HAR of exactly these requests, through the export dialog (secrets masked unless the user turns it off there).
 * `label` names them in the dialog ("GET /api/cart", "The 23 requests visible in the Network tab").
 */
export function exportHarFor(ids: string[], label: string, fileName: string): void {
  transfer.openDataExport('har', { ids, label, fileName });
}

/** "GET /api/cart" — one request as the export dialog names it. */
export function harLabel(e: NetworkEntry): string {
  return `${e.method} ${e.url}`;
}

export function harFileName(e: NetworkEntry): string {
  return `durbun-${safeFileStem(e.host, e.path)}.har`;
}

export function downloadBody(e: NetworkEntry, which: 'request' | 'response'): void {
  downloadUrl(api.bodyUrl(e.id, which, { download: true }));
}
