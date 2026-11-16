/** "Edit and send": prefilled request, input checks, body modes (edit / keep / none), the net.replay command, failures. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NetworkDetail, NetworkEntry, UiToServer } from '@durbun/protocol';
import { __resetCommandsForTests, handleReply, setCommandTransport } from '../../../data/commands';
import { setLanguage } from '../../../i18n';
import { clearDetailCache } from '../detailCache';
import '../i18n';
import '../../mocks/i18n';
import { ReplayDialog } from './ReplayDialog';

type Cmd = Extract<UiToServer, { type: 'command' }>;
let sent: Cmd[] = [];

function entry(p: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    id: 'n1',
    appId: 'app:1',
    deviceId: 'demo:1',
    source: 'dart:io',
    method: 'POST',
    url: 'https://api.pati.app/v1/orders',
    host: 'api.pati.app',
    path: '/v1/orders',
    startTs: 1,
    state: 'complete',
    status: 201,
    duration: 80,
    requestHeaders: [
      [':authority', 'api.pati.app'],
      ['content-type', 'application/json'],
      ['Content-Length', '7'],
      ['authorization', 'Bearer abc'],
    ],
    hasRequestBody: true,
    requestBodySize: 7,
    hasResponseBody: false,
    ...p,
  };
}

function stubDetail(detail: Partial<NetworkDetail> | 'fail') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      detail === 'fail' ? new Response(JSON.stringify({ error: 'gone', code: 'network.unknown' }), { status: 404 }) : new Response(JSON.stringify({ ...entry(), ...detail }), { status: 200 }),
    ),
  );
}

beforeEach(() => {
  setLanguage('en');
  clearDetailCache();
  sent = [];
  setCommandTransport({ isOpen: () => true, send: (m) => (m.type === 'command' && sent.push(m), true) });
});
afterEach(() => {
  cleanup();
  __resetCommandsForTests();
  vi.unstubAllGlobals();
});

describe('ReplayDialog', () => {
  it('prefills method, URL, headers (no pseudo / length headers) and the captured body; Send sends net.replay', async () => {
    stubDetail({ requestBody: { encoding: 'utf8', data: '{"a":1}', size: 7 } });
    const onSent = vi.fn();
    const onClose = vi.fn();
    render(<ReplayDialog entry={entry()} onSent={onSent} onClose={onClose} />);
    const body = (await screen.findByLabelText('Body', { selector: 'textarea' })) as HTMLTextAreaElement;
    expect(body.value).toBe('{"a":1}');
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://api.pati.app/v1/orders');
    const names = screen.getAllByLabelText('Name').map((i) => (i as HTMLInputElement).value);
    expect(names.filter(Boolean)).toEqual(['content-type', 'authorization']);
    fireEvent.change(body, { target: { value: '{"a":2}' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.command).toEqual({
      name: 'net.replay',
      id: 'n1',
      overrides: {
        method: 'POST',
        url: 'https://api.pati.app/v1/orders',
        headers: [
          ['content-type', 'application/json'],
          ['authorization', 'Bearer abc'],
        ],
        body: '{"a":2}',
        bodyEncoding: 'utf8',
      },
    });
    const result = { ...entry(), id: 'r1', deviceId: 'desktop', status: 201 };
    await act(async () => void handleReply({ type: 'reply', requestId: sent[0]!.requestId, ok: true, data: result }));
    expect(onSent).toHaveBeenCalledWith(result);
    expect(onClose).toHaveBeenCalled();
  });

  it('a bad URL or scheme blocks sending, with the reason', async () => {
    stubDetail({});
    render(<ReplayDialog entry={entry({ hasRequestBody: false })} onSent={vi.fn()} onClose={vi.fn()} />);
    const url = screen.getByLabelText('URL');
    fireEvent.change(url, { target: { value: 'not a url' } });
    expect(screen.getByText('Enter a valid URL')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(url, { target: { value: 'ftp://files.pati.app/x' } });
    expect(screen.getByText('Only http and https requests can be sent')).toBeTruthy();
  });

  it('a body that was not captured is kept as is; "Remove body" sends an empty one', async () => {
    stubDetail({ requestBody: { encoding: 'utf8', data: '', size: 2048, truncated: true } });
    render(<ReplayDialog entry={entry()} onSent={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText(/The captured body \(2(\.0)? KB\) is sent as is/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove body' }));
    expect(screen.getByText('The request is sent without a body.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect((sent[0]!.command as { overrides: { body?: string } }).overrides.body).toBe('');
  });

  it('GET with a kept body says the body is dropped', async () => {
    stubDetail({ method: 'GET', requestBody: { encoding: 'utf8', data: '', size: 10, truncated: true } });
    render(<ReplayDialog entry={entry({ method: 'GET' })} onSent={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('GET requests cannot carry a body; it will be dropped.')).toBeTruthy();
  });

  it('a failed send stays open with the error; a body that could not load says so', async () => {
    stubDetail('fail');
    const onClose = vi.fn();
    render(<ReplayDialog entry={entry()} onSent={vi.fn()} onClose={onClose} />);
    expect(await screen.findByText(/Could not load the body/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    await act(async () => void handleReply({ type: 'reply', requestId: sent[0]!.requestId, ok: false, error: 'connect ECONNREFUSED', code: 'command.failed' }));
    expect(await screen.findByText('Could not replay the request')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
