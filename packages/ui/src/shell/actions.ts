import { HarImportError, harToSession, looksLikeHar } from '@durbun/protocol';
import { importSession, type ImportResult } from '../data/api';
import { sendCommand } from '../data/commands';
import { useHub } from '../data/stores/hub';
import { getScope, setScope } from '../data/stores/scope';
import { usePrefs, type ThemePref } from '../data/stores/prefs';
import { ui, useUi } from '../data/stores/ui';
import { sniffFormat, transfer, type DurbunFileKind } from '../features/transfer/store';
import { isMaskedSessionFile } from '../features/transfer/dataExport';
import { pickFiles } from '../lib/download';
import { t } from '../i18n/core';
import { errorText } from '../i18n/codes';
import { toast } from '../components/Toast';
import { confirm } from '../components/Dialog';

/** Human message for a failed command/request (localized for known codes). */
export function errorMessage(err: unknown): string {
  return errorText(err);
}

export { scopeExportParams } from '../features/transfer/dataExport';

/** "Export session…": the dialog says what goes in (scope, counts) and masks secrets unless told otherwise. */
export function exportSession(): void {
  transfer.openDataExport('session');
}

/** "Export network traffic as HAR…": the same dialog; the current scope's requests by default. */
export function exportHar(): void {
  transfer.openDataExport('har');
}

const SESSION_EXT = /\.(json|durbun)$/i;
const TEXT_EXT = /\.(json|durbun|md|txt|har)$/i;
const HAR_EXT = /\.har$/i;

/** What a HAR import brought in (the toasts are the caller's). */
interface HarImported {
  result: ImportResult;
  requests: number;
  notes: string[];
  creator?: string;
}

/**
 * A HAR (browser developer tools, a proxy, Dürbün's own export) opens as an imported recording of its requests.
 * Said plainly: a HAR has no log lines, device or app, so the recording has none either.
 */
async function sendHar(file: File): Promise<HarImported> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new HarImportError('har.notHar', 'Not JSON');
  }
  // The recording is named after the file, without the extension (the server strips only its own ones).
  const name = file.name.replace(/\.har$/i, '').trim() || file.name;
  const har = harToSession(parsed, { name });
  const result = await importSession(har.session, { name });
  const notes = [t('shell.io.harOnlyRequests'), ...(har.skipped ? [t('shell.io.harSkipped', { count: har.skipped })] : []), ...(har.masked ? [t('transfer.data.importedMasked')] : [])];
  return { result, requests: har.requests, notes, ...(har.creator ? { creator: har.creator } : {}) };
}

function harErrorText(err: unknown): string {
  const code = err instanceof HarImportError ? err.code : undefined;
  return code === 'har.empty' ? t('shell.io.harEmpty') : code === 'har.notHar' ? t('shell.io.harInvalid') : errorMessage(err);
}

async function importHar(file: File): Promise<void> {
  const id = toast({ kind: 'info', title: t('shell.io.importing', { name: file.name }), duration: 0 });
  try {
    const { result, requests, notes, creator } = await sendHar(file);
    toast.dismiss(id);
    sayImportLimits(result);
    const first = result.deviceIds[0];
    toast.success(t('shell.io.harImported', { count: requests }), {
      description: `${file.name}${creator ? ` · ${creator}` : ''} · ${notes.join(' ')}`,
      duration: 9000,
      action: first ? { label: t('shell.io.showRequests'), onClick: () => showImported(first) } : undefined,
    });
    if (first) showImported(first);
  } catch (err) {
    toast.dismiss(id);
    toast.error(t('shell.io.importFailed'), { description: harErrorText(err) });
  }
}

/**
 * The import shares the live memory limits: when part of the file did not fit, or live lines made room for it,
 * said in plain words with the setting that moves the limit (nothing is lost silently).
 */
function sayImportLimits(r: ImportResult): void {
  const dropped = (r.dropped?.logs ?? 0) + (r.dropped?.requests ?? 0);
  const evicted = (r.evicted?.logs ?? 0) + (r.evicted?.requests ?? 0);
  if (!dropped && !evicted) return;
  const parts: string[] = [];
  if (r.dropped?.logs) parts.push(t('shell.io.limits.droppedLogs', { count: r.dropped.logs }));
  if (r.dropped?.requests) parts.push(t('shell.io.limits.droppedRequests', { count: r.dropped.requests }));
  if (r.evicted?.logs) parts.push(t('shell.io.limits.evictedLogs', { count: r.evicted.logs }));
  if (r.evicted?.requests) parts.push(t('shell.io.limits.evictedRequests', { count: r.evicted.requests }));
  toast.warn(t('shell.io.limits.title'), {
    description: `${parts.join(' ')} ${t('shell.io.limits.hint')}`,
    duration: 15_000,
    action: { label: t('shell.io.limits.settings'), onClick: () => ui.openSettings('logs') },
  });
}

/** The imported HAR's device, on the Network tab (a HAR has nothing for Logs to show). */
function showImported(deviceId: string): void {
  setScope({ kind: 'device', deviceId });
  ui.setTab('network');
}
const INSTALL_EXT = /\.(apk|apks|xapk|aab|ipa|app|zip)$/i;

/** What a dropped or picked file is, read from its name and its first 64 KB. */
export type ImportKind = 'install' | 'notDurbun' | 'har' | 'package' | 'flow' | 'session';

export async function classifyImport(file: File): Promise<ImportKind> {
  if (INSTALL_EXT.test(file.name)) return 'install';
  if (!TEXT_EXT.test(file.name)) return 'notDurbun';
  if (HAR_EXT.test(file.name)) return 'har';
  // Only the head is read to tell them apart: session recordings can be hundreds of megabytes.
  let kind: DurbunFileKind = 'unknown';
  try {
    kind = sniffFormat(await file.slice(0, 64 * 1024).text());
  } catch {
    /* unreadable: the session import reports it */
  }
  // A HAR saved as .json: its head says so.
  if (kind === 'unknown' && /\.json$/i.test(file.name)) {
    try {
      if (looksLikeHar(await file.slice(0, 4096).text())) return 'har';
    } catch {
      /* unreadable: the session import reports it */
    }
  }
  if (kind === 'package' || kind === 'flow') return kind;
  // Every Dürbün file names its format first; a session file is still sent when its name says so (the server
  // explains what is wrong with it).
  if (!SESSION_EXT.test(file.name) || (kind === 'unknown' && !/\.durbun\.json$/i.test(file.name))) return 'notDurbun';
  return 'session';
}

/**
 * Import a Dürbün file, by what it holds: a package (.durbun) or a flow file asks what to bring in, a session
 * recording opens as an imported device (the scope switches to it on success).
 */
export async function importFile(file: File): Promise<void> {
  const kind = await classifyImport(file);
  if (kind === 'install' || kind === 'notDurbun') {
    if (kind === 'install') toast.warn(t('code.import.invalid'), { description: t('shell.io.installHint') });
    else if (!TEXT_EXT.test(file.name)) toast.warn(t('code.import.invalid'), { description: t('shell.io.sessionHint') });
    else toast.warn(t('shell.io.notDurbun'), { description: t('shell.io.sessionHint') });
    return;
  }
  if (kind === 'har') return importHar(file);
  if (kind === 'package' || kind === 'flow') {
    try {
      const text = await file.text();
      if (kind === 'package') transfer.openImport(text, file.name);
      else ui.importFlows(text);
    } catch (err) {
      toast.error(t('shell.io.importFailed'), { description: errorMessage(err) });
    }
    return;
  }
  const id = toast({ kind: 'info', title: t('shell.io.importing', { name: file.name }), duration: 0 });
  try {
    const masked = await isMaskedSessionFile(file);
    const result = await importSession(file);
    const { deviceIds } = result;
    toast.dismiss(id);
    sayImportLimits(result);
    const first = deviceIds[0];
    toast.success(t('code.import.done', { count: deviceIds.length }), {
      // A masked recording shows •••• where tokens were: said here so nobody hunts for a missing value.
      description: masked ? `${file.name} · ${t('transfer.data.importedMasked')}` : file.name,
      ...(masked ? { duration: 9000 } : {}),
      action: first ? { label: t('shell.io.show'), onClick: () => setScope({ kind: 'device', deviceId: first }) } : undefined,
    });
    if (first) setScope({ kind: 'device', deviceId: first });
  } catch (err) {
    toast.dismiss(id);
    toast.error(t('shell.io.importFailed'), { description: errorMessage(err) });
  }
}

/** One line per file that did not come in, for the summary. */
interface Skipped {
  name: string;
  reason: string;
}

/**
 * Several files at once (a drop, a multi-select): each is brought in by what it is, and one summary says what came
 * in and what did not. Flow files go into one import dialog together; a package opens its own dialog (one at a
 * time, and not together with flow files: two dialogs would stack).
 */
export async function importFiles(files: readonly File[]): Promise<void> {
  if (files.length <= 1) {
    if (files[0]) await importFile(files[0]);
    return;
  }
  const progress = toast({ kind: 'info', title: t('shell.io.many.importing', { count: files.length }), duration: 0 });
  const skipped: Skipped[] = [];
  const flowTexts: string[] = [];
  const packages: { name: string; text: string }[] = [];
  let sessions = 0;
  let hars = 0;
  let firstDevice: { id: string; har: boolean } | undefined;
  for (const file of files) {
    const kind = await classifyImport(file);
    try {
      if (kind === 'install') skipped.push({ name: file.name, reason: t('shell.io.many.reasonInstall') });
      else if (kind === 'notDurbun') skipped.push({ name: file.name, reason: t('shell.io.many.reasonNotDurbun') });
      else if (kind === 'flow') flowTexts.push((await file.text()).trim());
      else if (kind === 'package') packages.push({ name: file.name, text: await file.text() });
      else if (kind === 'har') {
        const r = await sendHar(file);
        sayImportLimits(r.result);
        hars++;
        if (!firstDevice && r.result.deviceIds[0]) firstDevice = { id: r.result.deviceIds[0], har: true };
      } else {
        const r = await importSession(file);
        sayImportLimits(r);
        sessions++;
        if (!firstDevice && r.deviceIds[0]) firstDevice = { id: r.deviceIds[0], har: false };
      }
    } catch (err) {
      skipped.push({ name: file.name, reason: kind === 'har' ? harErrorText(err) : errorMessage(err) });
    }
  }
  toast.dismiss(progress);

  const parts: string[] = [];
  if (sessions) parts.push(t('shell.io.many.sessions', { count: sessions }));
  if (hars) parts.push(t('shell.io.many.hars', { count: hars }));
  let pkg: { name: string; text: string } | undefined;
  if (flowTexts.length) {
    parts.push(t('shell.io.many.flows', { count: flowTexts.length }));
    for (const p of packages) skipped.push({ name: p.name, reason: t('shell.io.many.reasonPackageWithFlows') });
  } else if (packages.length) {
    pkg = packages[0];
    parts.push(t('shell.io.many.package', { name: pkg!.name }));
    for (const p of packages.slice(1)) skipped.push({ name: p.name, reason: t('shell.io.many.reasonOnePackage') });
  }
  const came = files.length - skipped.length;
  const description = [parts.join(' · '), ...skipped.map((x) => t('shell.io.many.skippedLine', { name: x.name, reason: x.reason }))].filter(Boolean).join('\n');
  const show = firstDevice;
  const opts = {
    description,
    duration: skipped.length ? 20_000 : 9000,
    ...(show ? { action: { label: show.har ? t('shell.io.showRequests') : t('shell.io.show'), onClick: () => (show.har ? showImported(show.id) : setScope({ kind: 'device', deviceId: show.id })) } } : {}),
  };
  if (!came) toast.error(t('shell.io.many.none', { count: files.length }), opts);
  else if (skipped.length) toast.warn(t('shell.io.many.partial', { count: came, total: files.length }), opts);
  else toast.success(t('shell.io.many.done', { count: came }), opts);

  // The first recording opens (a HAR on the Network tab); the dialogs come last so the summary stays readable.
  if (show && !flowTexts.length && !pkg) {
    if (show.har) showImported(show.id);
    else setScope({ kind: 'device', deviceId: show.id });
  }
  if (flowTexts.length) ui.importFlows(flowTexts.length === 1 ? flowTexts[0]! : `[${flowTexts.join(',\n')}]`);
  else if (pkg) transfer.openImport(pkg.text, pkg.name);
}

export async function pickAndImport(): Promise<void> {
  const files = await pickFiles({ accept: '.json,.durbun,.md,.txt,.har,application/json', multiple: true });
  await importFiles(files);
}

export async function setDemo(enabled: boolean): Promise<void> {
  try {
    await sendCommand({ name: 'demo.set', enabled });
    if (enabled) toast.success(t('code.demo.enabled'));
    else {
      // The demo devices stay (disconnected) with their data until a clear; offer it right away.
      toast.success(t('code.demo.disabled'), {
        description: t('shell.demo.leftover'),
        action: { label: t('shell.demo.clear'), onClick: () => void clearEverything() },
        duration: 8000,
      });
    }
  } catch (err) {
    toast.error(t('shell.demo.failed'), { description: errorMessage(err) });
  }
}

/** Marker in the log stream (on the scoped device when there is one). */
export async function addMarker(label?: string): Promise<void> {
  const scope = getScope();
  const deviceId =
    scope.kind === 'device' || scope.kind === 'deviceApp' ? scope.deviceId : scope.kind === 'app' ? useHub.getState().apps[scope.appId]?.deviceId : undefined;
  try {
    await sendCommand({ name: 'marker.add', label, deviceId });
  } catch (err) {
    toast.error(t('shell.marker.failed'), { description: errorMessage(err) });
  }
}

export async function clearEverything(): Promise<void> {
  const ok = await confirm({ title: t('shell.clearAll.title'), message: t('shell.clearAll.message'), confirmLabel: t('shell.clearAll.confirm'), danger: true });
  if (!ok) return;
  try {
    await sendCommand({ name: 'clear', target: 'all' });
  } catch (err) {
    toast.error(t('shell.clearAll.failed'), { description: errorMessage(err) });
  }
}

export async function attachVm(input: string, deviceId?: string): Promise<boolean> {
  const value = input.trim();
  if (!value) return false;
  try {
    const res = await sendCommand({ name: 'vm.attach', input: value, deviceId });
    toast.success(t('shell.vm.attached'));
    if (res?.appId) setScope({ kind: 'app', appId: res.appId });
    return true;
  } catch (err) {
    toast.error(t('shell.vm.failed'), { description: errorMessage(err) });
    return false;
  }
}

export function setTheme(theme: ThemePref): void {
  usePrefs.getState().setPref('theme', theme);
}

export function toggleLanguage(): void {
  const p = usePrefs.getState();
  p.setPref('language', p.language === 'tr' ? 'en' : 'tr');
}

export function toggleSidebar(): void {
  const ui = useUi.getState();
  if (ui.narrow) useUi.setState({ sidebarOverlay: !ui.sidebarOverlay });
  else usePrefs.getState().setPref('sidebarCollapsed', !usePrefs.getState().sidebarCollapsed);
}
