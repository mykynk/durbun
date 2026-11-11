import { exportUrl, importSession, downloadHar } from '../data/api';
import { sendCommand } from '../data/commands';
import { useHub } from '../data/stores/hub';
import { getScope, setScope, type Scope } from '../data/stores/scope';
import { usePrefs, type ThemePref } from '../data/stores/prefs';
import { ui, useUi } from '../data/stores/ui';
import { sniffFormat, transfer, type DurbunFileKind } from '../features/transfer/store';
import { downloadUrl, pickFiles } from '../lib/download';
import { t } from '../i18n/core';
import { errorText } from '../i18n/codes';
import { toast } from '../components/Toast';
import { confirm } from '../components/Dialog';

/** Human message for a failed command/request (localized for known codes). */
export function errorMessage(err: unknown): string {
  return errorText(err);
}

export function scopeExportParams(scope: Scope): { deviceId?: string; appId?: string; bundleId?: string } {
  if (scope.kind === 'device') return { deviceId: scope.deviceId };
  if (scope.kind === 'app') {
    const app = useHub.getState().apps[scope.appId];
    return { deviceId: app?.deviceId, appId: scope.appId };
  }
  // An SDK-less app has no session id on the server: the device + bundle id name it ("Export “Kumbara”" holds
  // Kumbara only, never the other apps' lines of that phone).
  if (scope.kind === 'deviceApp') return { deviceId: scope.deviceId, bundleId: scope.bundleId };
  return {};
}

export function exportSession(scope: Scope | 'all' = 'all'): void {
  const params = scope === 'all' ? {} : scopeExportParams(scope);
  downloadUrl(exportUrl(params));
  toast.info(t('shell.io.exportStarted'));
}

export async function exportHar(): Promise<void> {
  try {
    await downloadHar();
  } catch (err) {
    toast.error(t('shell.io.harFailed'), { description: errorMessage(err) });
  }
}

const SESSION_EXT = /\.(json|durbun)$/i;
const TEXT_EXT = /\.(json|durbun|md|txt)$/i;
const INSTALL_EXT = /\.(apk|aab|ipa|app|zip)$/i;

/**
 * Import a Dürbün file, by what it holds: a package (.durbun) or a flow file asks what to bring in, a session
 * recording opens as an imported device (the scope switches to it on success).
 */
export async function importFile(file: File): Promise<void> {
  if (INSTALL_EXT.test(file.name) || !TEXT_EXT.test(file.name)) {
    toast.warn(t('code.import.invalid'), {
      description: INSTALL_EXT.test(file.name) ? t('shell.io.installHint') : t('shell.io.sessionHint'),
    });
    return;
  }
  // Only the head is read to tell them apart: session recordings can be hundreds of megabytes.
  let kind: DurbunFileKind = 'unknown';
  try {
    kind = sniffFormat(await file.slice(0, 64 * 1024).text());
  } catch {
    /* unreadable: the session import below reports it */
  }
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
  // Every Dürbün file names its format first; a session file is still sent when its name says so (the server
  // explains what is wrong with it).
  if (!SESSION_EXT.test(file.name) || (kind === 'unknown' && !/\.durbun\.json$/i.test(file.name))) {
    toast.warn(t('shell.io.notDurbun'), { description: t('shell.io.sessionHint') });
    return;
  }
  const id = toast({ kind: 'info', title: t('shell.io.importing', { name: file.name }), duration: 0 });
  try {
    const { deviceIds } = await importSession(file);
    toast.dismiss(id);
    const first = deviceIds[0];
    toast.success(t('code.import.done', { count: deviceIds.length }), {
      description: file.name,
      action: first ? { label: t('shell.io.show'), onClick: () => setScope({ kind: 'device', deviceId: first }) } : undefined,
    });
    if (first) setScope({ kind: 'device', deviceId: first });
  } catch (err) {
    toast.dismiss(id);
    toast.error(t('shell.io.importFailed'), { description: errorMessage(err) });
  }
}

export async function pickAndImport(): Promise<void> {
  const [file] = await pickFiles({ accept: '.json,.durbun,.md,.txt,application/json' });
  if (file) await importFile(file);
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
