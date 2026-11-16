/**
 * "App data": the reply shape on both sides (the REAL server's appDataResult and the dev mock), the availability
 * rules in data/explain.ts, and the row's states (iPhone guidance, not-a-debug-build note, copying, failure, file).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DeviceActionResult, DeviceInfo, UiToServer } from '@durbun/protocol';
import { __resetCommandsForTests, handleReply, setCommandTransport } from '../../data/commands';
import { appDataAvailability, showsIphoneReportGuide } from '../../data/explain';
import { setLanguage } from '../../i18n';
import { AppDataRow, appDataResult, useAppDataPulls } from './AppData';
import { IphoneReportCard } from './IphoneReportCard';
// @ts-expect-error — plain .mjs dev tool without types
import { appDataReply } from '../../../dev/mock-app-data.mjs';

const load = <T,>(file: string): Promise<T> => import(/* @vite-ignore */ path.resolve(__dirname, '../../../../server', file)) as Promise<T>;

const PIXEL: DeviceInfo = {
  id: 'android:1',
  platform: 'android',
  kind: 'physical',
  name: 'Pixel 8',
  connection: 'usb',
  state: 'online',
  logs: { status: 'streaming', via: 'logcat' },
  actions: ['list-apps', 'app-data'],
  firstSeen: 0,
  lastSeen: 0,
};
const IPHONE: DeviceInfo = {
  ...PIXEL,
  id: 'ios:1',
  platform: 'ios',
  name: 'iPhone',
  actions: ['list-apps'],
  unavailableActions: [{ action: 'app-data', code: 'action.appData.iphoneUnsupported' }],
};
const SIM: DeviceInfo = { ...PIXEL, id: 'sim:1', platform: 'ios', kind: 'simulator', name: 'iPhone 17' };
const APP = { id: 'com.example.shop', name: 'Shop', debuggable: true, listed: true };

beforeEach(() => {
  setLanguage('en');
  useAppDataPulls.setState({ running: {}, errors: {}, files: [] });
});
afterEach(() => {
  cleanup();
  __resetCommandsForTests();
});

describe('reply shape: real server and dev mock', () => {
  it('appDataResult on the server and appDataReply in the mock give the same fields, and the UI reads both', async () => {
    const { appDataResult: serverResult } = await load<{
      appDataResult: (ctx: unknown, target: unknown, appId: string, startedAt: number, out: unknown) => DeviceActionResult;
    }>('src/platform/shared/appData.ts');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'durbun-ui-appdata-'));
    try {
      const file = path.join(dir, 'app-data-x.tar.gz');
      await writeFile(file, 'x');
      const server = serverResult({ fileUrl: (n: string) => `/api/files/${n}` }, { name: 'app-data-x.tar.gz', file }, 'com.example.shop', Date.now(), {
        ok: true,
        bytes: 1,
        rawBytes: 10,
      });
      const fromServer = JSON.parse(JSON.stringify(server.data)) as Record<string, unknown>;
      const fromMock = appDataReply({ name: 'Pixel 8' }, 'com.example.shop', Date.now()) as Record<string, unknown>;
      expect(Object.keys(fromMock).sort()).toEqual(Object.keys(fromServer).sort());
      expect(appDataResult(fromServer)).toEqual(fromServer);
      expect(appDataResult(fromMock)).toEqual(fromMock);
      expect(server.code).toBe('action.appData.saved');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('appDataResult refuses what is not a reply of this action', () => {
    expect(appDataResult(null)).toBeNull();
    expect(appDataResult({ url: 'https://elsewhere/x', appId: 'a' })).toBeNull();
    expect(appDataResult({ url: '/api/files/x.tar.gz' })).toBeNull();
    expect(appDataResult({ url: '/api/files/x.tar.gz', appId: 'a' })).toMatchObject({ fileName: 'x.tar.gz', bytes: 0 });
  });
});

describe('availability (data/explain.ts)', () => {
  it('Android: offered; a listed app not marked debuggable gets the heads-up, an unknown one does not', () => {
    expect(appDataAvailability(PIXEL, APP)).toEqual({ availability: { state: 'yes' }, notDebug: false });
    expect(appDataAvailability(PIXEL, { ...APP, debuggable: false })).toMatchObject({ notDebug: true });
    expect(appDataAvailability(PIXEL, { ...APP, debuggable: false, listed: false })).toMatchObject({ notDebug: false });
  });
  it('simulator: no debuggable rule; iPhone: blocked with the reason; offline: not shown', () => {
    expect(appDataAvailability(SIM, { ...APP, debuggable: false })).toEqual({ availability: { state: 'yes' }, notDebug: false });
    expect(appDataAvailability(IPHONE, APP).availability).toEqual({ state: 'blocked', code: 'action.appData.iphoneUnsupported' });
    expect(appDataAvailability({ ...PIXEL, state: 'offline' }, APP).availability).toEqual({ state: 'no' });
  });
});

describe('AppDataRow', () => {
  it('a physical iPhone says where Xcode does it, without a button', () => {
    render(<AppDataRow device={IPHONE} app={APP} />);
    expect(screen.getByText(/Download Container/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Copy data/ })).toBeNull();
  });

  it('copy → progress → the file with Download; one copy per device', async () => {
    const sent: Extract<UiToServer, { type: 'command' }>[] = [];
    setCommandTransport({ isOpen: () => true, send: (m) => (m.type === 'command' && sent.push(m), true) });
    render(<AppDataRow device={PIXEL} app={APP} userId={10} />);
    fireEvent.click(screen.getByRole('button', { name: /Copy data/ }));
    expect(sent[0]!.command).toMatchObject({ name: 'device.action', deviceId: 'android:1', action: 'app-data', params: { appId: 'com.example.shop', userId: 10 } });
    expect(await screen.findByText(/Copying/)).toBeTruthy();
    const reply = appDataReply({ name: 'Pixel 8' }, 'com.example.shop', Date.now());
    await act(async () => {
      handleReply({ type: 'reply', requestId: sent[0]!.requestId, ok: true, data: reply });
    });
    expect(await screen.findByText(reply.fileName)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Download/ })).toBeTruthy();
    expect(screen.queryByText(/Copying/)).toBeNull();
  });

  it('a refusal stays next to the button in plain words (not a debug build)', async () => {
    const sent: Extract<UiToServer, { type: 'command' }>[] = [];
    setCommandTransport({ isOpen: () => true, send: (m) => (m.type === 'command' && sent.push(m), true) });
    render(<AppDataRow device={PIXEL} app={{ ...APP, debuggable: false }} />);
    expect(screen.getByText(/does not show this as a debug build/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Copy data/ }));
    await act(async () => {
      handleReply({ type: 'reply', requestId: sent[0]!.requestId, ok: false, error: 'not debuggable', code: 'action.appData.notDebuggable', params: { appId: APP.id } });
    });
    expect(await screen.findByText(/Could not copy the data of Shop/)).toBeTruthy();
    expect(screen.getAllByText(/not a debug build/).length).toBeGreaterThan(0);
  });

  it('another app being copied from the same device: the button waits and says which', () => {
    useAppDataPulls.setState({ running: { 'android:1': { appId: 'com.other', name: 'Other', startedAt: Date.now() } } });
    render(<AppDataRow device={PIXEL} app={APP} />);
    expect(screen.getByText(/The data of Other is being copied/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Copy data/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('iPhone full report (sysdiagnose) guide', () => {
  it('only for a connected physical iPhone', () => {
    expect(showsIphoneReportGuide(IPHONE)).toBe(true);
    expect(showsIphoneReportGuide({ ...IPHONE, state: 'offline' })).toBe(false);
    expect(showsIphoneReportGuide(SIM)).toBe(false);
    expect(showsIphoneReportGuide(PIXEL)).toBe(false);
    expect(showsIphoneReportGuide({ ...IPHONE, id: 'import:1' })).toBe(false);
  });
  it('says the steps in both languages, with no button', () => {
    render(<IphoneReportCard device={IPHONE} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText(/Analytics Data/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    setLanguage('tr');
    render(<IphoneReportCard device={IPHONE} />);
    expect(screen.getByText(/Analiz Verileri/)).toBeTruthy();
  });
});
