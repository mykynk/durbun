/** "Pair over Wi-Fi" dialog: the phone steps, discovered phones, input checks, every result state. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AdbWirelessResult, AdbWirelessState } from '@durbun/protocol';
import { setLanguage } from '../../../i18n';
import { wirelessPairingAvailable } from '../../../data/explain';
import { cleanCode, openPairDialog, PairDialogHost, parseAddress, usePairDialog } from './PairDialog';

const STATE: AdbWirelessState = {
  adb: true,
  discovery: 'ok',
  services: [
    { name: 'adb-R58N91XYZ-Qw3rTy', kind: 'pairing', host: '192.168.1.42', port: 37115, serial: 'R58N91XYZ' },
    { name: 'adb-RF8N30ABCD-x7Kp2a', kind: 'connect', host: '192.168.1.31', port: 39573, serial: 'RF8N30ABCD', connected: true },
  ],
};

let calls: { url: string; body?: unknown }[] = [];
function stub(state: AdbWirelessState | { status: number; body: unknown }, replies: Record<string, AdbWirelessResult | { status: number; body: unknown }> = {}) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const op = url.split('/').pop()!;
      const r = op === 'wireless' ? state : replies[op];
      if (r && 'status' in r) return new Response(JSON.stringify(r.body), { status: r.status });
      return new Response(JSON.stringify(r ?? {}), { status: 200 });
    }),
  );
}

beforeEach(() => {
  setLanguage('en');
  usePairDialog.setState({ open: false });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openDialog() {
  render(<PairDialogHost />);
  act(() => openPairDialog());
  await screen.findByText('Pair Android over Wi‑Fi');
}

describe('helpers', () => {
  it('addresses and codes as a tester types them', () => {
    expect(parseAddress(' 192.168.1.42:37115 ')).toEqual({ host: '192.168.1.42', port: 37115 });
    expect(parseAddress('[fe80::1]:5555')).toEqual({ host: 'fe80::1', port: 5555 });
    expect(parseAddress('192.168.1.42')).toBeUndefined();
    expect(parseAddress('-k:1')).toBeUndefined();
    expect(cleanCode('123 456')).toBe('123456');
    expect(wirelessPairingAvailable([{ id: 'android', available: true }])).toBe(true);
    expect(wirelessPairingAvailable([{ id: 'android', available: false }, { id: 'ios-sim', available: true }])).toBe(false);
  });
});

describe('PairDialog', () => {
  it('phone steps, phones on the network, "Use this" fills the address; pair + connect in one go', async () => {
    stub(STATE, {
      pair: {
        ok: true,
        code: 'adb.wireless.paired',
        message: 'Paired',
        address: '192.168.1.42:37115',
        connected: { ok: true, address: '192.168.1.42:41235', code: 'adb.wireless.connected' },
      },
    });
    await openDialog();
    expect(screen.getByText(/Developer options/)).toBeTruthy();
    expect(await screen.findByText('R58N91XYZ')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use this' }));
    expect((screen.getByPlaceholderText('192.168.1.20:37099') as HTMLInputElement).value).toBe('192.168.1.42:37115');
    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '123 456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect(await screen.findByText('Paired and connected')).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith('/pair'))?.body).toEqual({ host: '192.168.1.42', port: 37115, code: '123456' });
    expect(screen.getByText(/192\.168\.1\.42:41235/)).toBeTruthy();
  });

  it('checks the input before sending', async () => {
    stub(STATE);
    await openDialog();
    fireEvent.change(screen.getByPlaceholderText('192.168.1.20:37099'), { target: { value: '192.168.1.42' } });
    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect(await screen.findByText('Type the address as 192.168.1.20:37099')).toBeTruthy();
    expect(screen.getByText('The code is 6 digits')).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/pair'))).toBe(false);
  });

  it('a wrong code in plain words; paired without a connect service asks for the connection address', async () => {
    stub(STATE, { pair: { ok: false, code: 'adb.wireless.wrongCode', message: 'Wrong', address: '192.168.1.42:37115' } });
    await openDialog();
    fireEvent.change(screen.getByPlaceholderText('192.168.1.20:37099'), { target: { value: '192.168.1.42:37115' } });
    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect(await screen.findByText('Could not pair')).toBeTruthy();
    expect(screen.getByText(/Wrong pairing code/)).toBeTruthy();

    stub(STATE, {
      pair: { ok: true, code: 'adb.wireless.paired', message: 'Paired', address: '192.168.1.42:37115' },
      connect: { ok: true, code: 'adb.wireless.connected', message: 'Connected', address: '192.168.1.42:41235', serial: '192.168.1.42:41235' },
    });
    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    const field = (await screen.findByPlaceholderText('192.168.1.20:41235')) as HTMLInputElement;
    expect(field.value).toBe('192.168.1.42:');
    fireEvent.change(field, { target: { value: '192.168.1.42:41235' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith('/connect'))?.body).toEqual({ host: '192.168.1.42', port: 41235 });
  });

  it('no adb: says so and offers no form; an adb without discovery still offers the form', async () => {
    stub({ adb: false, discovery: 'unavailable', services: [] });
    await openDialog();
    await waitFor(() => expect(screen.getByText(/adb/)).toBeTruthy());
    expect(screen.queryByPlaceholderText('123456')).toBeNull();
    expect((screen.getByRole('button', { name: 'Pair' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    usePairDialog.setState({ open: false });
    stub({ adb: true, discovery: 'unavailable', services: [], detail: 'ERROR: mdns daemon unavailable' });
    await openDialog();
    expect(await screen.findByText(/cannot list the phones/)).toBeTruthy();
    expect(screen.getByPlaceholderText('123456')).toBeTruthy();
  });

  it('a server error (HTTP 400) shows its text', async () => {
    stub(STATE, { pair: { status: 400, body: { error: 'code is not valid', code: 'action.invalidParams', params: { param: 'code', expected: 'pairingCode' } } } });
    await openDialog();
    fireEvent.change(screen.getByPlaceholderText('192.168.1.20:37099'), { target: { value: '192.168.1.42:37115' } });
    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect(await screen.findByText('Could not pair')).toBeTruthy();
  });
});
