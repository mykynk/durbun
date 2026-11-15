/**
 * Demo mode brings example flows: valid against the catalog, added when the demo starts, removed when it stops
 * unless the user changed them.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowDoc, FlowIssue, FlowRun, FlowSummary } from '@durbun/protocol';
import { DEMO_FLOW_IDS, demoFlows } from '../../src/demo/flows';
import { createDemoDriver } from '../../src/demo/index';
import { createHub } from '../../src/hub/index';
import { createSdkLayer } from '../../src/sdk/index';
import { startServerWith, type ServerFactories } from '../../src/server';
import { silentLogger } from '../../src/util/logger';
import { FakeDriver, FakeVm, makeTempDir, startTestApp, type TestApp } from '../http/fakes';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const get = async <T>(path: string): Promise<T> => (await (await fetch(`${t!.base}${path}`)).json()) as T;

describe('demo flows', () => {
  it('are added when the demo starts, without issues, and removed when it stops unless changed', async () => {
    t = await startTestApp();
    await t.app.setDemo(true);
    const listed = await get<FlowSummary[]>('/api/flows');
    expect(listed.map((f) => f.id).sort()).toEqual([...DEMO_FLOW_IDS].sort());
    for (const id of DEMO_FLOW_IDS) {
      const { flow, issues } = await get<{ flow: FlowDoc; issues: FlowIssue[] }>(`/api/flows/${id}`);
      expect(issues.filter((i) => i.level === 'error'), id).toEqual([]);
      expect(flow.tags).toEqual(['demo']);
    }

    // The user renames one: it is theirs now and stays.
    const { flow } = await get<{ flow: FlowDoc }>('/api/flows/demo-pati-start');
    const put = await fetch(`${t.base}/api/flows/demo-pati-start`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...flow, name: 'My start check' }) });
    expect(put.status).toBe(200);

    await t.app.setDemo(false);
    expect((await get<FlowSummary[]>('/api/flows')).map((f) => f.id)).toEqual(['demo-pati-start']);

    // Again on: the missing one comes back, the user's copy is not overwritten.
    await t.app.setDemo(true);
    const again = await get<FlowSummary[]>('/api/flows');
    expect(again.map((f) => f.id).sort()).toEqual([...DEMO_FLOW_IDS].sort());
    expect(again.find((f) => f.id === 'demo-pati-start')!.name).toBe('My start check');
  });

  it('every demo flow targets the demo Pati app and starts from a manual trigger', () => {
    for (const f of demoFlows()) {
      expect(f.target?.appId).toBe('com.mykynk.pati');
      expect(f.nodes[0]).toMatchObject({ type: 'trigger.manual' });
      expect(f.edges.every((e) => f.nodes.some((n) => n.id === e.from) && f.nodes.some((n) => n.id === e.to))).toBe(true);
    }
  });
});

describe('demo flows against the real demo driver', () => {
  it('both pass on the demo Pixel (the demo story keeps what they check)', async () => {
    const dir = await makeTempDir();
    const factories = {
      createHub,
      createSdkLayer,
      createPlatform: () => ({
        drivers: [new FakeDriver('android', 'android:'), new FakeDriver('ios-sim', 'ios-sim:'), new FakeDriver('ios-device', 'ios:')],
        services: { forwardToDevice: async () => ({ host: '127.0.0.1', port: 1, dispose: async () => {} }) },
      }),
      createFlutterVmModule: () => new FakeVm(),
      createDemoDriver,
    } as ServerFactories;
    const server = await startServerWith(
      { httpPort: 0, sdkPort: 0, demo: true, dataDir: path.join(dir, 'data'), uiDir: undefined, verbose: false },
      factories,
      { logger: silentLogger, moduleDir: dir, driverStartWaitMs: 50 },
    );
    try {
      // Pati connects its SDK session a moment after the demo starts.
      for (let i = 0; i < 40; i++) {
        const apps = (await (await fetch(`${server.url}/api/summary`)).json()) as { apps: number };
        if (apps.apps > 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      for (const id of DEMO_FLOW_IDS) {
        const res = await fetch(`${server.url}/api/flows/${id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: { deviceId: 'demo:1' } }) });
        expect(res.status, id).toBe(202);
        let run = (await res.json()) as FlowRun;
        for (let i = 0; i < 120 && run.status === 'running'; i++) {
          await new Promise((r) => setTimeout(r, 250));
          run = (await (await fetch(`${server.url}/api/flow-runs/${run.id}`)).json()) as FlowRun;
        }
        expect({ id, status: run.status, failed: run.steps.filter((x) => x.status !== 'passed').map((x) => [x.nodeId, x.errorCode, x.error]) }).toEqual({ id, status: 'passed', failed: [] });
      }
    } finally {
      await server.stop();
    }
  }, 60_000);
});
