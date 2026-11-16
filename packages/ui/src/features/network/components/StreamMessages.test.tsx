import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_SETTINGS, type AppSession, type NetworkEntry, type StreamInfo, type StreamMessage, type StreamMessagesPage } from '@durbun/protocol';
import { logStore, networkStore, streamMessages, ui, useServerSettings } from '../../../data';
import { useHub } from '../../../data/stores/hub';
import '../i18n';
import { StreamMessagesTab } from './StreamMessages';
import { ConnectionNote } from './ConnectionNote';

// The virtual list measures its scroller: give the jsdom elements a size so rows render.
const sizes = {
  clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight'),
  clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth'),
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
};
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 500 });
  // Measured rows: one line high (jsdom lays nothing out).
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 26 });
});
afterEach(() => {
  cleanup();
  if (sizes.clientHeight) Object.defineProperty(Element.prototype, 'clientHeight', sizes.clientHeight);
  if (sizes.clientWidth) Object.defineProperty(Element.prototype, 'clientWidth', sizes.clientWidth);
  if (sizes.offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', sizes.offsetHeight);
  vi.unstubAllGlobals();
  act(() => {
    streamMessages.reset();
    logStore.reset();
    networkStore.reset();
    networkStore.flush();
    useHub.setState({ apps: {} });
    useServerSettings.setState({ settings: DEFAULT_SETTINGS, loaded: false });
  });
  localStorage.clear();
});

const info = (p: Partial<StreamInfo> = {}): StreamInfo => ({
  kind: 'websocket',
  state: 'open',
  openTs: Date.now() - 65_000,
  count: 0,
  in: 0,
  out: 0,
  control: 0,
  bytesIn: 0,
  bytesOut: 0,
  dropped: 0,
  lastSeq: 0,
  ...p,
});

function entry(stream: StreamInfo, p: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    id: 'app:1:ws',
    appId: 'app:1',
    deviceId: 'android:1',
    source: 'okhttp',
    method: 'GET',
    url: 'wss://chat.pati.app/v2/socket',
    host: 'chat.pati.app',
    path: '/v2/socket',
    startTs: (stream.openTs ?? Date.now()) - 80,
    endTs: stream.openTs,
    state: 'complete',
    status: 101,
    duration: 80,
    requestHeaders: [],
    hasRequestBody: false,
    hasResponseBody: false,
    stream,
    ...p,
  };
}

const msg = (seq: number, dir: 'in' | 'out', data: string, p: Partial<StreamMessage> = {}): StreamMessage => ({
  seq,
  ts: Date.now() - 60_000 + seq * 10,
  dir,
  type: 'text',
  size: data.length,
  body: { encoding: 'utf8', data, size: data.length },
  ...p,
});
const ping = (seq: number): StreamMessage => ({ seq, ts: Date.now() - 60_000 + seq * 10, dir: 'out', type: 'ping', size: 0 });

/** Puts the entry in the store and answers GET /api/network/:id/messages with `page` (or fails). */
function serve(e: NetworkEntry, page: Partial<StreamMessagesPage> | Error) {
  const fetchMock = vi.fn(async () => {
    if (page instanceof Error) return new Response(JSON.stringify({ error: page.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ messages: [], more: false, ...page }), { headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  act(() => {
    networkStore.upsert([e]);
    networkStore.flush();
  });
  return fetchMock;
}

function session(capabilities: AppSession['capabilities']): void {
  const s = {
    id: 'app:1',
    sessionKey: 's',
    deviceId: 'android:1',
    sdk: { name: 'durbun-android', version: '0.1.0', platform: 'android' },
    app: { id: 'com.mykynk.pati', name: 'Pati', version: '1.4.2' },
    transport: 'adb-reverse',
    connected: true,
    connectedAt: 1,
    capabilities,
    actions: [],
    stats: { logs: 0, requests: 0, errors: 0 },
  } as unknown as AppSession;
  act(() => useHub.setState({ apps: { 'app:1': s } }));
}

describe('StreamMessagesTab', () => {
  it('lists messages in seq order with direction, a gap row for removed ones and hidden ping/pong counted', async () => {
    const stream = info({ count: 8, in: 4, out: 4, control: 1, bytesIn: 60, bytesOut: 40, dropped: 3, lastSeq: 8 });
    const e = entry(stream);
    serve(e, { messages: [msg(1, 'out', '{"type":"auth"}'), msg(2, 'in', '{"type":"auth.ok"}'), ping(3), msg(7, 'in', '{"type":"message","text":"hi"}'), msg(8, 'out', '{"type":"read"}')], stream });
    render(<StreamMessagesTab entry={e} gone={false} />);
    await screen.findByText('{"type":"auth.ok"}');
    expect(screen.getByText(/^Open for/)).toBeTruthy();
    expect(screen.getByText('4 received')).toBeTruthy();
    // Quiet in the counts line (the sentence and the why for the tooltip and screen readers), and the gap row
    // between seq 3 and 7.
    expect(screen.getByText('3 removed')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^3 messages removed by the memory limit\. Dürbün keeps the first 100/ })).toBeTruthy();
    expect(screen.getAllByText('3 messages removed by the memory limit')).toHaveLength(1);
    // Direction in words, not color alone.
    expect(screen.getAllByText('Received').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Sent').length).toBeGreaterThan(0);
    // ping/pong hidden by default, one click shows it.
    const ctl = screen.getByRole('button', { name: /1 ping\/pong hidden/ });
    expect(screen.queryByText('ping', { selector: '.net-msg__type' })).toBeNull();
    fireEvent.click(ctl);
    expect(screen.getByText('ping', { selector: '.net-msg__type' })).toBeTruthy();
  });

  it('searches messages with a match count, and says when nothing matches', async () => {
    const stream = info({ count: 3, in: 2, out: 1, lastSeq: 3 });
    const e = entry(stream);
    serve(e, { messages: [msg(1, 'out', '{"type":"auth"}'), msg(2, 'in', '{"type":"auth.ok"}'), msg(3, 'in', '{"type":"typing"}')], stream });
    render(<StreamMessagesTab entry={e} gone={false} />);
    await screen.findByText('{"type":"typing"}');
    const search = screen.getByPlaceholderText('Search messages…');
    fireEvent.change(search, { target: { value: 'auth' } });
    expect(screen.getByText('2 matches')).toBeTruthy();
    expect(screen.queryByText('{"type":"typing"}')).toBeNull();
    fireEvent.change(search, { target: { value: 'nothing-like-this' } });
    expect(screen.getByText('No messages match the filter')).toBeTruthy();
  });

  it('the direction filter keeps sent or received messages', async () => {
    const stream = info({ count: 2, in: 1, out: 1, lastSeq: 2 });
    const e = entry(stream);
    serve(e, { messages: [msg(1, 'out', 'hello server'), msg(2, 'in', 'hello app')], stream });
    render(<StreamMessagesTab entry={e} gone={false} />);
    await screen.findByText('hello app');
    fireEvent.click(screen.getByRole('radio', { name: 'Sent' }));
    expect(screen.getByText('hello server')).toBeTruthy();
    expect(screen.queryByText('hello app')).toBeNull();
  });

  it('expands a message: JSON tree, copy buttons, truncated note with the full size', async () => {
    const stream = info({ count: 1, in: 1, lastSeq: 1 });
    const e = entry(stream);
    const data = '{"type":"history","items":[1,2,3]}';
    serve(e, { messages: [msg(1, 'in', data, { size: 114_688, body: { encoding: 'utf8', data, size: 114_688, truncated: true } })], stream });
    render(<StreamMessagesTab entry={e} gone={false} />);
    fireEvent.click(await screen.findByText(data));
    expect(screen.getByRole('button', { name: /Copy payload/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy message as JSON/ })).toBeTruthy();
    expect(screen.getAllByText(/112 KB/).length).toBeGreaterThan(0);
  });

  it('closed connection: who closed it, the close code by name and the reason', async () => {
    const stream = info({ state: 'closed', closedTs: Date.now() - 1000, closedBy: 'in', closeCode: 1001, closeReason: 'Server restarting', count: 1, in: 1, lastSeq: 1 });
    const e = entry(stream);
    serve(e, { messages: [msg(1, 'in', 'bye')], stream });
    render(<StreamMessagesTab entry={e} gone={false} />);
    await screen.findByText('bye');
    expect(screen.getByText(/^Was open for/)).toBeTruthy();
    expect(screen.getByText(/1001/)).toBeTruthy();
    expect(screen.getByText('“Server restarting”')).toBeTruthy();
  });

  it('failed connection: the failure text; the app leaving is said in the UI language', async () => {
    const stream = info({ state: 'failed', error: 'The app disconnected', lastTs: Date.now() - 1000 });
    const e = entry(stream);
    serve(e, { messages: [], stream });
    render(<StreamMessagesTab entry={e} gone={false} />);
    expect(await screen.findByText('The connection broke')).toBeTruthy();
    expect(screen.queryByText('The app disconnected')).toBeNull();
    expect(screen.getByText('The connection broke before any message')).toBeTruthy();
  });

  it('empty states: open with nothing yet, capture off (with a way to Settings), imported', async () => {
    const stream = info();
    const e = entry(stream);
    serve(e, { messages: [], stream });
    const { unmount } = render(<StreamMessagesTab entry={e} gone={false} />);
    expect(await screen.findByText('Connection open, no messages yet')).toBeTruthy();
    unmount();

    session(['logs', 'network', 'streams']);
    act(() => useServerSettings.setState({ settings: { ...DEFAULT_SETTINGS, captureStreams: false }, loaded: true }));
    const r3 = render(<StreamMessagesTab entry={e} gone={false} />);
    expect(await screen.findByText('Message capture is off')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Settings/ })).toBeTruthy();
    r3.unmount();

    const imported = entry(stream, { id: 'import:1:ws', deviceId: 'import:1', appId: undefined as unknown as string });
    serve(imported, { messages: [], stream });
    render(<StreamMessagesTab entry={imported} gone={false} />);
    expect(await screen.findByText('This recording has no messages for this connection')).toBeTruthy();
    expect(screen.getByText(/^Still open when recorded/)).toBeTruthy();
  });

  it('renders only the rows in view for a long connection', async () => {
    const messages = Array.from({ length: 2500 }, (_, i) => msg(i + 1, i % 2 ? 'in' : 'out', `{"n":${i + 1}}`));
    const stream = info({ state: 'closed', closedTs: Date.now(), closedBy: 'out', closeCode: 1000, count: 2500, in: 1250, out: 1250, lastSeq: 2500 });
    const e = entry(stream);
    serve(e, { messages, stream });
    const { container } = render(<StreamMessagesTab entry={e} gone={false} />);
    await screen.findByText('{"n":1}');
    expect(container.querySelectorAll('.net-msg').length).toBeLessThan(100);
  });

  it('a 101 without a stream (the app sends no messages) says why in one line; a stream says the actions do not apply', () => {
    const plain = entry(info(), { stream: undefined });
    delete (plain as Partial<NetworkEntry>).stream;
    session(['logs', 'network']);
    const r1 = render(<ConnectionNote entry={plain} />);
    expect(screen.getByText('This app’s SDK does not capture messages yet')).toBeTruthy();
    r1.unmount();

    session(['logs', 'network', 'streams']);
    act(() => useServerSettings.setState({ settings: { ...DEFAULT_SETTINGS, captureStreams: false }, loaded: true }));
    const r2 = render(<ConnectionNote entry={plain} />);
    expect(screen.getByText('Message capture is off')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Settings/ })).toBeTruthy();
    r2.unmount();

    render(<ConnectionNote entry={entry(info())} />);
    expect(screen.getByText('Replay, edit and mock work on one-off requests.')).toBeTruthy();
    expect(screen.getByText(/WebSocket connections cannot be replayed/)).toBeTruthy();
  });

  it('a 101 without a stream from an app that captures streams: the SDK did not see it; its SDK line is one click away', () => {
    const plain = entry(info());
    delete (plain as Partial<NetworkEntry>).stream;
    session(['logs', 'network', 'streams']);
    const first = render(<ConnectionNote entry={plain} />);
    expect(screen.getByText('The SDK could not see this connection’s messages')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Show in Logs/ })).toBeNull();
    first.unmount();
    act(() =>
      logStore.append([
        { id: 41, ts: 1, deviceId: 'android:1', appId: 'app:1', source: 'app', level: 'info', tag: 'durbun', kind: 'text', message: 'A WebSocket was opened with OkHttpClient.newWebSocket…', data: { reason: 'noWebSocketFactory' } },
      ]),
    );
    const focus = vi.spyOn(ui, 'focusLog').mockImplementation(() => {});
    render(<ConnectionNote entry={plain} />);
    fireEvent.click(screen.getByRole('button', { name: /Show in Logs/ }));
    expect(focus).toHaveBeenCalledWith(41);
    focus.mockRestore();
  });

  it('nothing for an ordinary request', () => {
    const { container } = render(<ConnectionNote entry={{ ...entry(info()), stream: undefined, status: 200 } as NetworkEntry} />);
    expect(container.textContent).toBe('');
  });

  it('a failed fetch offers to try again', async () => {
    const stream = info({ count: 2, in: 2, lastSeq: 2 });
    const e = entry(stream);
    const fetchMock = serve(e, new Error('boom'));
    render(<StreamMessagesTab entry={e} gone={false} />);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByText('Could not load the messages')).toBeTruthy();
    const calls = fetchMock.mock.calls.length;
    fireEvent.click(retry);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(calls));
  });
});
