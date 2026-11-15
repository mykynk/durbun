// @vitest-environment node
/**
 * The export / HAR / share contracts the UI codes against, checked on the REAL server (real hub, HTTP app on an
 * ephemeral port, temp data dir, fake drivers: no adb / idevicesyslog). The UI's own helpers decide what is sent and
 * what the dialog says; the server's answer must match.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type FlowRun, type LogEntry, type NetworkEntry, type SessionExport } from '@durbun/protocol';

/*
 * The server is loaded at run time from its sources (vite-node compiles them); a static import would make the UI
 * typecheck compile the server with the browser's lib. Only the members used here are typed.
 */
interface Hub {
  dispose(): void;
  upsertDevice(d: unknown): void;
  upsertDeviceApp(a: unknown): unknown;
  registerApp(a: unknown): { id: string };
  pushAppLog(appId: string, log: unknown): unknown;
  pushDeviceLogs(deviceId: string, logs: unknown[]): void;
  netRequest(appId: string, msg: unknown): void;
  netResponse(appId: string, msg: unknown): void;
  getNetwork(): NetworkEntry[];
}
interface TestApp {
  base: string;
  close(): Promise<void>;
}
const SERVER = new URL('../../../server/', import.meta.url).pathname;
const load = <T>(file: string): Promise<T> => import(/* @vite-ignore */ `${SERVER}${file}`) as Promise<T>;
const { createHub } = await load<{ createHub(o: unknown): Hub }>('src/hub/index.ts');
const { silentLogger } = await load<{ silentLogger: unknown }>('src/util/logger.ts');
const { startTestApp } = await load<{ startTestApp(o: unknown): Promise<TestApp> }>('test/http/fakes.ts');
import { hubActions } from './stores/hub';
import { logStore } from './logStore';
import { networkStore } from './networkStore';
import { isMaskedSessionFile, scopeExportCounts, scopeExportParams } from '../features/transfer/dataExport';
import { flowsWithCalls, runsOfFlows } from '../features/transfer/runs';
import { exportUrl } from './api';

let t: TestApp | undefined;
let hub: Hub | undefined;
afterEach(async () => {
  await t?.close();
  hub?.dispose();
  t = hub = undefined;
  logStore.reset();
  networkStore.reset();
  hubActions.replaceAll({ devices: [], apps: [], drivers: [], processes: [], deviceApps: [] });
});

const PHONE = 'android:CONTRACT1';
const SHOP = 'com.example.shop';

async function start(extra: Record<string, unknown> = {}) {
  hub = createHub({ settings: { ...DEFAULT_SETTINGS }, logger: silentLogger });
  t = await startTestApp({ hub, ...extra });
  hub.upsertDevice({ id: PHONE, platform: 'android', kind: 'physical', name: 'Pixel 8', connection: 'usb', state: 'online', logs: { status: 'streaming', via: 'logcat' }, actions: [], firstSeen: 1, lastSeen: 1 });
  const session = (sessionKey: string, id: string, connected: boolean) =>
    hub!.registerApp({ sessionKey, deviceId: PHONE, sdk: { name: 'durbun', version: '0.2.0', platform: 'flutter' }, app: { id, name: id, pid: 4000 + sessionKey.length }, transport: 'adb-reverse', connected, connectedAt: Date.now(), capabilities: ['logs', 'network'], actions: [] });
  const earlier = session('s1', SHOP, false);
  const shop = session('s22', SHOP, true);
  const other = session('s333', 'com.example.other', true);
  for (const a of [earlier, shop, other]) {
    hub.pushAppLog(a.id, { ts: Date.now(), level: 'info', tag: 'app', message: `hello from ${a.id}` });
    hub.netRequest(a.id, { type: 'net.request', id: '1', ts: Date.now(), method: 'GET', url: `https://api.example.com/v1/${a.id.replace(/\W/g, '-')}/me?token=abc123`, headers: [['Authorization', 'Bearer secret-value']], source: 'dart:io' });
    hub.netResponse(a.id, { type: 'net.response', id: '1', ts: Date.now() + 5, status: 200, headers: [['Set-Cookie', 'sid=s3cr3t']] });
  }
  // An SDK-less store build the device reports.
  hub.upsertDeviceApp({ deviceId: PHONE, id: 'com.example.legacy', name: 'Legacy', buildType: 'release', install: { source: 'play' }, pids: [7100], running: true, lastActivity: Date.now() });
  hub.pushDeviceLogs(PHONE, [
    { ts: Date.now(), level: 'warn', tag: 'Legacy', process: 'com.example.legacy', pid: 7100, message: 'cache miss' },
    { ts: Date.now(), level: 'error', tag: 'AndroidRuntime', process: SHOP, message: 'FATAL EXCEPTION: main' },
    { ts: Date.now(), level: 'info', tag: 'ActivityManager', process: 'system_server', message: 'Displayed com.example.other' },
  ] as never);
  return { base: t.base, shop, other, earlier };
}

const raw = async (url: string) => (await fetch(`${t!.base}${url}`)).text();
const json = async <T>(url: string, init?: RequestInit) => (await (await fetch(`${t!.base}${url}`, init)).json()) as T;

/** The UI's copy of the server's buffers: what a connected Dürbün window holds. */
async function loadUi() {
  const all = JSON.parse(await raw('/api/export?mask=0')) as SessionExport;
  hubActions.replaceAll({ devices: all.devices, apps: all.apps, drivers: [], processes: [], deviceApps: all.deviceApps ?? [] });
  logStore.append(all.logs as LogEntry[]);
  networkStore.upsert(all.network as NetworkEntry[]);
}

describe('real server: session export', () => {
  it('(a) a masked file says so where the import sniff looks; a raw file does not', async () => {
    await start();
    const masked = await raw('/api/export');
    const unmasked = await raw('/api/export?mask=0');
    expect(masked).toContain('••••');
    expect(masked).not.toContain('secret-value');
    expect(unmasked).toContain('secret-value');
    expect((JSON.parse(masked) as { masked?: boolean }).masked).toBe(true);
    // The last member of the (pretty-printed, streamed) file: the import reads only the tail for it.
    expect(masked).toMatch(/"masked"\s*:\s*true\s*\}\s*$/);
    expect(await isMaskedSessionFile(new Blob([masked]))).toBe(true);
    expect(await isMaskedSessionFile(new Blob([unmasked]))).toBe(false);
  });

  it('(b) an app scope exported by device + bundle id holds what the dialog counts', async () => {
    const s = await start();
    await loadUi();
    for (const scope of [{ kind: 'app' as const, appId: s.shop.id }, { kind: 'app' as const, appId: s.earlier.id, exact: true }, { kind: 'deviceApp' as const, deviceId: PHONE, bundleId: 'com.example.legacy' }, { kind: 'device' as const, deviceId: PHONE }]) {
      const params = scopeExportParams(scope);
      const file = JSON.parse(await raw(exportUrl({ ...params, mask: false }))) as SessionExport;
      const counts = scopeExportCounts(scope);
      expect(counts.logs).toBeGreaterThan(0);
      expect({ scope, logs: file.logs.length, requests: file.network.length }).toEqual({ scope, logs: counts.logs, requests: counts.requests });
    }
  });
});

describe('real server: HAR', () => {
  it('(c) `ids` keeps exactly those requests; no `ids` means all; masking is on unless `mask: false`', async () => {
    await start();
    const list = hub!.getNetwork();
    expect(list.length).toBe(3);
    const har = (body: unknown) => json<{ log: { entries: { request: { url: string; headers: { name: string; value: string }[] } }[]; _durbun?: { masked?: boolean } } }>('/api/har', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const one = await har({ ids: [list[1]!.id] });
    expect(one.log.entries).toHaveLength(1);
    expect(one.log.entries[0]!.request.url).toContain(list[1]!.path.split('/me')[0]!);
    expect(one.log._durbun?.masked).toBe(true);
    expect(JSON.stringify(one)).not.toContain('secret-value');
    expect((await har({})).log.entries).toHaveLength(3);
    const open = await har({ ids: [list[0]!.id], mask: false });
    expect(open.log._durbun?.masked).toBeUndefined();
    expect(JSON.stringify(open)).toContain('secret-value');
  });
});

describe('real server: share package run history', () => {
  it('(d) `include.runs` as an id array packs exactly those runs', async () => {
    await start({ flowsBackground: false });
    const flow = (id: string, calls?: string) => ({
      format: 'durbun-flow',
      version: 1,
      id,
      name: `Flow ${id}`,
      nodes: [{ id: 'start', type: 'trigger.manual' }, ...(calls ? [{ id: 'call', type: 'flow.call', params: { flowId: calls } }] : [{ id: 'note', type: 'output.note', params: { text: 'hi' } }])],
      edges: [{ from: 'start', to: calls ? 'call' : 'note' }],
    });
    for (const f of [flow('child'), flow('parent', 'child'), flow('other')]) {
      await fetch(`${t!.base}/api/flows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flow: f }) });
    }
    const run = async (id: string) => {
      const started = await json<FlowRun>(`/api/flows/${id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      for (let i = 0; i < 100; i++) {
        const r = await json<FlowRun>(`/api/flow-runs/${started.id}`);
        if (r.status !== 'running') return r;
        await new Promise((res) => setTimeout(res, 20));
      }
      throw new Error('run did not finish');
    };
    await run('parent');
    await run('child');
    await run('other');

    // What the share dialog sends for "parent" picked: its runs and its sub-flow's, never "other"'s.
    const headers = (await json<{ runs: FlowRun[] }>('/api/flow-runs?limit=500')).runs;
    const summaries = await json<{ id: string; calls?: string[] }[]>('/api/flows');
    const flows = Array.isArray(summaries) ? summaries : ((summaries as unknown as { flows: { id: string; calls?: string[] }[] }).flows ?? []);
    const ids = runsOfFlows(headers as never, flowsWithCalls(flows.map((f) => ({ id: f.id, calls: f.calls ?? [] })), ['parent'])).map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const pkg = await json<{ contents: { runs?: { run: { id: string; flowId: string } }[] } }>('/api/packages/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'share', include: { flows: ['parent'], runs: ids } }),
    });
    expect((pkg.contents.runs ?? []).map((r) => r.run.id).sort()).toEqual([...ids].sort());
    expect((pkg.contents.runs ?? []).some((r) => r.run.flowId === 'other')).toBe(false);
  });
});
