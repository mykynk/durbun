import type { NetworkEntry, ReplayOverrides } from '@durbun/protocol';
import { api, logStore, sendCommand, ui, useHub } from '../../data';
import { copyText, downloadUrl, formatBytes, formatDuration, toast } from '../../components';
import { errorText, t } from '../../i18n';
import { copyAs, type CopyFormat, type CopyNote } from './model/copyAs';
import { safeFileStem } from './model/http';
import { cachedDetail, loadDetail } from './detailCache';
import { draftFromRequest, type DraftNote } from '../mocks/model/draft';
import './i18n';

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
  const toastId = toast({ kind: 'info', title: t('network.replay.sending', { method: overrides?.method ?? e.method, host: e.host }), duration: 0 });
  try {
    const res = await sendCommand({ name: 'net.replay', id: e.id, overrides });
    toast.dismiss(toastId);
    if (res.state === 'failed') {
      toast.error(t('network.replay.failed'), { description: res.error });
    } else {
      toast.success(t('network.replay.done', { status: res.status ?? '—', duration: formatDuration(res.duration) }));
    }
    return res;
  } catch (err) {
    toast.dismiss(toastId);
    toast.error(t('network.replay.error'), { description: errorText(err) });
    return null;
  }
}

/** Jump to the log row of this request (scans the log ring from the newest end). */
export function showInLogs(e: NetworkEntry): void {
  const entries = logStore.entries;
  for (let i = entries.length - 1; i >= 0; i--) {
    const row = entries[i]!;
    if (row.netId === e.id) {
      ui.focusLog(row.id);
      return;
    }
  }
  toast.info(t('network.toast.noLogRow'));
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
  let detail = cachedDetail(e) ?? null;
  if (!detail && (e.hasResponseBody || e.hasRequestBody)) {
    try {
      detail = await loadDetail(e);
    } catch {
      detail = null;
    }
  }
  const { draft, notes } = draftFromRequest(e, detail, bundleIdOf(e.appId));
  ui.newMockFromDraft(draft);
  const texts = notes.map(draftNoteText).filter((s): s is string => !!s);
  if (texts.length > 0) toast.warn(t('network.mockNotes.title'), { description: texts.join(' '), duration: 9000 });
}

export async function downloadHarFor(ids: string[], filename: string): Promise<void> {
  try {
    await api.downloadHar(ids, filename);
  } catch (err) {
    toast.error(t('network.toast.harFailed'), { description: errorText(err) });
  }
}

export function harFileName(e: NetworkEntry): string {
  return `durbun-${safeFileStem(e.host, e.path)}.har`;
}

export function downloadBody(e: NetworkEntry, which: 'request' | 'response'): void {
  downloadUrl(api.bodyUrl(e.id, which, { download: true }));
}
