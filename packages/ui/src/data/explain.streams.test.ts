import { describe, expect, it } from 'vitest';
import type { StreamInfo } from '@durbun/protocol';
import { connectionKind, networkActionAvailability, streamCaptureState } from './explain';

const stream = (kind: StreamInfo['kind']): StreamInfo => ({ kind, state: 'open', openTs: 1, count: 0, in: 0, out: 0, control: 0, bytesIn: 0, bytesOut: 0, dropped: 0, lastSeq: 0 });

describe('networkActionAvailability', () => {
  it('a WebSocket / SSE connection cannot be replayed, edited, mocked, compared or put in a flow', () => {
    for (const action of ['replay', 'editReplay', 'mock', 'compare', 'flow'] as const) {
      expect(networkActionAvailability({ method: 'GET', stream: stream('websocket') }, action)).toEqual({ ok: false, reason: 'websocket' });
      expect(networkActionAvailability({ method: 'GET', stream: stream('sse') }, action)).toEqual({ ok: false, reason: 'sse' });
    }
  });

  it('a response without its request cannot be sent again; it can still be mocked and compared', () => {
    expect(networkActionAvailability({ method: '?' }, 'replay')).toEqual({ ok: false, reason: 'noRequest' });
    expect(networkActionAvailability({ method: '?' }, 'editReplay')).toEqual({ ok: false, reason: 'noRequest' });
    expect(networkActionAvailability({ method: '?' }, 'flow')).toEqual({ ok: false, reason: 'noRequest' });
    expect(networkActionAvailability({ method: '?' }, 'mock')).toEqual({ ok: true });
    expect(networkActionAvailability({ method: 'POST' }, 'replay')).toEqual({ ok: true });
  });
});

describe('streamCaptureState', () => {
  it('imported recording first, then the SDK capability, then the setting', () => {
    expect(streamCaptureState({ deviceId: 'import:2', captureStreams: false })).toBe('imported');
    expect(streamCaptureState({ deviceId: 'android:1', session: { capabilities: ['network'] } })).toBe('noCapability');
    expect(streamCaptureState({ deviceId: 'android:1', session: { capabilities: ['network', 'streams'] }, captureStreams: false })).toBe('captureOff');
    expect(streamCaptureState({ deviceId: 'android:1', session: { capabilities: ['streams'] } })).toBe('ok');
    // The session is gone (older entry): the setting still speaks; absent setting = on.
    expect(streamCaptureState({ deviceId: 'android:1' })).toBe('ok');
    expect(streamCaptureState({ deviceId: 'android:1', captureStreams: false })).toBe('captureOff');
  });
});

describe('connectionKind', () => {
  it('a stream, else the handshake: a 101 or a bodiless text/event-stream response (the server keeps those without a stream for apps that send no messages)', () => {
    expect(connectionKind({ stream: stream('sse'), status: 200 })).toBe('sse');
    expect(connectionKind({ status: 101 })).toBe('websocket');
    expect(connectionKind({ status: 200, responseContentType: 'text/event-stream; charset=utf-8', hasResponseBody: false })).toBe('sse');
    // An SDK that reported the whole event stream as a body: a plain response.
    expect(connectionKind({ status: 200, responseContentType: 'text/event-stream', hasResponseBody: true })).toBeNull();
    expect(connectionKind({ status: 200, responseContentType: 'application/json' })).toBeNull();
    expect(networkActionAvailability({ method: 'GET', status: 101 }, 'replay')).toEqual({ ok: false, reason: 'websocket' });
  });
});
