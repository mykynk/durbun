import type { ExplainAction, ExplainContext } from '../data/explain';
import { useHub, type AppGroup } from '../data/stores/hub';
import { ui, type SdkGuideTab } from '../data/stores/ui';
import { requestDeviceSection } from '../features/device/request';
import { showInPerf } from '../features/perf/request';
import { TIP_ACTIONS } from './text';
import type { ExplainedApp } from './model';

/** SDK guide tab that fits the app (native SDKs have their own tab; everything else is Flutter-first). */
export function guideTabFor(ctx: Pick<ExplainContext, 'sdkPlatform'> | undefined): SdkGuideTab {
  switch (ctx?.sdkPlatform) {
    case 'android':
      return 'android';
    case 'ios':
      return 'ios';
    case 'react-native':
    case 'js':
      return 'react-native';
    default:
      return 'flutter';
  }
}

/** Main live pid of an app group: the process named like the bundle id, else the first reported one. */
export function mainPidOf(group: AppGroup): { pid: number; name: string } | undefined {
  const da = group.deviceApp;
  const procs = useHub.getState().processes[group.deviceId] ?? {};
  if (da && da.running && da.pids.length > 0) {
    const main = da.pids.find((p) => procs[p]?.name === group.bundleId) ?? da.pids[0]!;
    return { pid: main, name: procs[main]?.name ?? da.processName ?? group.bundleId };
  }
  const s = group.sessions.find((x) => x.connected && typeof x.app.pid === 'number');
  if (s && typeof s.app.pid === 'number') return { pid: s.app.pid, name: s.app.processName ?? s.app.id };
  return undefined;
}

/** Whether an action can run right now (tips are never buttons; process metrics need a live pid). */
export function actionAvailable(action: ExplainAction, item: ExplainedApp | undefined): boolean {
  if (TIP_ACTIONS.has(action)) return false;
  if (action === 'startProcessMetrics') return Boolean(item && mainPidOf(item.group));
  return true;
}

/**
 * Run an explanation action. `override` lets a view handle one itself (e.g. Performance picks the process
 * target in place) — return true from it to skip the default.
 */
export function runExplainAction(action: ExplainAction, item: ExplainedApp | undefined, override?: (a: ExplainAction) => boolean | void): void {
  if (override && override(action) === true) return;
  const ctx = item?.result.context;
  switch (action) {
    case 'openSdkGuide':
      ui.openSdkGuide(guideTabFor(ctx), 'setup');
      return;
    case 'openDoctor':
      ui.openDoctor();
      return;
    case 'attachVm':
      requestDeviceSection('vm');
      return;
    case 'useDebugBuild':
      ui.openSdkGuide('flutter', 'vm');
      return;
    case 'buildWithDurbunFlag':
      ui.openSdkGuide('flutter', 'release');
      return;
    case 'addInterceptor':
      ui.openSdkGuide(ctx?.sdkPlatform === 'android' ? 'android' : 'flutter', 'native');
      return;
    case 'startProcessMetrics': {
      const main = item ? mainPidOf(item.group) : undefined;
      if (!item || !main) return;
      showInPerf({ kind: 'process', deviceId: item.group.deviceId, pid: main.pid, name: main.name }, { poll: true });
      return;
    }
    default:
      return;
  }
}
