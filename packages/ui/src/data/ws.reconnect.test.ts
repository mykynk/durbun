/** `reconnectNow` (the "Reconnect now" button) and the early retries on focus / network back, with a fake WebSocket. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnection } from './stores/connection';
import { reconnectNow, startConnection, stopConnection } from './ws';

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
  /** The server is not there: the socket closes with 1006. */
  fail(code = 1006, reason = ''): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  useConnection.setState({ status: 'connecting', everConnected: false, attempt: 0, nextRetryAt: null, lastError: null });
});
afterEach(() => {
  stopConnection();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('reconnectNow', () => {
  it('does nothing before the connection is started or after it is stopped', () => {
    reconnectNow();
    expect(FakeSocket.all).toHaveLength(0);
    startConnection({ url: 'ws://127.0.0.1:1/ui' });
    expect(FakeSocket.all).toHaveLength(1);
    stopConnection();
    reconnectNow();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('a failed socket schedules a retry; reconnectNow opens one at once and drops the scheduled one', () => {
    startConnection({ url: 'ws://127.0.0.1:1/ui' });
    last().fail();
    const s = useConnection.getState();
    expect(s).toMatchObject({ status: 'reconnecting', attempt: 1, lastError: null });
    expect(s.nextRetryAt).toBeGreaterThan(Date.now());
    reconnectNow();
    expect(FakeSocket.all).toHaveLength(2);
    // The countdown is gone while this attempt runs.
    expect(useConnection.getState().nextRetryAt).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('does not open a second socket while one is connecting or open', () => {
    startConnection({ url: 'ws://127.0.0.1:1/ui' });
    reconnectNow();
    expect(FakeSocket.all).toHaveLength(1);
    last().readyState = FakeSocket.OPEN;
    reconnectNow();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('a close with a reason keeps it as the last error; the backoff grows with each attempt', () => {
    startConnection({ url: 'ws://127.0.0.1:1/ui' });
    last().fail(4001, 'server shutting down');
    expect(useConnection.getState()).toMatchObject({ attempt: 1, lastError: 'server shutting down' });
    const first = useConnection.getState().nextRetryAt! - Date.now();
    vi.advanceTimersByTime(first + 1);
    expect(FakeSocket.all).toHaveLength(2);
    last().fail(4002, '');
    expect(useConnection.getState()).toMatchObject({ attempt: 2, lastError: 'code 4002' });
    expect(useConnection.getState().nextRetryAt! - Date.now()).toBeGreaterThan(first);
  });
});

describe('early retries', () => {
  it('the network coming back retries at once, but not twice within 2 s', () => {
    startConnection({ url: 'ws://127.0.0.1:1/ui' });
    last().fail();
    // The last attempt was just now: too soon.
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(250);
    vi.setSystemTime(Date.now() + 2_000);
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.all.length).toBeGreaterThanOrEqual(2);
  });

  it('no early retry while no retry is pending', () => {
    startConnection({ url: 'ws://127.0.0.1:1/ui' });
    vi.setSystemTime(Date.now() + 5_000);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeSocket.all).toHaveLength(1);
  });
});
