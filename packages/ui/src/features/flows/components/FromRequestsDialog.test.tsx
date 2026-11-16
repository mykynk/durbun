import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { NetworkEntry, StreamInfo } from '@durbun/protocol';
import { networkStore } from '../../../data';
import '../i18n';
import { FromRequestsDialog, canBecomeStep } from './FromRequestsDialog';

afterEach(() => {
  cleanup();
  act(() => {
    networkStore.reset();
    networkStore.flush();
  });
});

const stream: StreamInfo = { kind: 'websocket', state: 'open', openTs: 1, count: 3, in: 2, out: 1, control: 0, bytesIn: 9, bytesOut: 3, dropped: 0, lastSeq: 3 };

function entry(id: string, p: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    id,
    appId: 'app:1',
    deviceId: 'android:1',
    source: 'okhttp',
    method: 'GET',
    url: `https://api.kasa.app/v2/${id}`,
    host: 'api.kasa.app',
    path: `/v2/${id}`,
    startTs: 1000,
    state: 'complete',
    status: 200,
    duration: 50,
    requestHeaders: [],
    hasRequestBody: false,
    hasResponseBody: true,
    ...p,
  };
}

const ws = entry('socket', { url: 'wss://rt.kasa.app/v2/balance', host: 'rt.kasa.app', path: '/v2/balance', status: 101, hasResponseBody: false, stream });
// A handshake the server kept without a stream (the app sends no messages): still a connection, not a step.
const plainWs = entry('plain', { url: 'wss://rt.kasa.app/v2/plain', host: 'rt.kasa.app', path: '/v2/plain', status: 101, hasResponseBody: false });
const sse = entry('events', { responseContentType: 'text/event-stream', hasResponseBody: false });

describe('new flow from requests: connections are not steps', () => {
  it('canBecomeStep follows networkActionAvailability (streams, handshakes without a stream, responses alone)', () => {
    expect(canBecomeStep(entry('balance'))).toBe(true);
    expect(canBecomeStep(ws)).toBe(false);
    expect(canBecomeStep(plainWs)).toBe(false);
    expect(canBecomeStep(sse)).toBe(false);
    expect(canBecomeStep(entry('orphan', { method: '?' }))).toBe(false);
    expect(canBecomeStep(entry('own', { source: 'flow' }))).toBe(false);
    expect(canBecomeStep(undefined)).toBe(false);
  });

  it('the dialog neither lists nor pre-picks a WebSocket / SSE entry', () => {
    act(() => {
      networkStore.upsert([entry('balance'), ws, plainWs, sse]);
      networkStore.flush();
    });
    const { baseElement } = render(
      <FromRequestsDialog open initialIds={['socket']} visibleIds={['balance', 'socket', 'plain', 'events']} from="network" onClose={() => {}} onCreated={() => {}} />,
    );
    const listed = [...baseElement.querySelectorAll('[data-req-id]')].map((el) => el.getAttribute('data-req-id'));
    expect(listed).toEqual(['balance']);
    expect(baseElement.querySelector('.fl-fromreq__chip')).toBeNull();
  });
});
