import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const shown: FakeNotification[] = [];
class FakeNotification extends EventEmitter {
  closed = false;
  constructor(readonly opts: { title: string; body: string }) {
    super();
    shown.push(this);
  }
  static isSupported() {
    return true;
  }
  show() {
    this.emit('show');
  }
  close() {
    this.closed = true;
  }
}
vi.mock('electron', () => ({ app: { dock: { bounce() {}, setBadge() {}, getBadge: () => '' } }, Notification: FakeNotification }));

const { createNotifier } = await import('../src/notifier');
const log = { file: '', info() {}, warn() {}, error() {}, debug() {}, scoped: () => ({}) as never };
const sender = { isDestroyed: () => false, send: vi.fn() } as never;
const req = (id: string, tag: string) => ({ id, title: 'Kumbara çöktü', body: 'NullPointerException', tag, silent: false });

describe('createNotifier', () => {
  it('a notification with the same tag replaces the previous one (web API behaviour)', () => {
    shown.length = 0;
    const notifier = createNotifier({ log, onClick() {}, isFocused: () => false });
    notifier.show(req('n1', 'durbun-crash'), sender);
    notifier.show(req('n2', 'durbun-crash'), sender);
    notifier.show(req('n3', ''), sender);
    expect(shown.map((n) => n.closed)).toEqual([true, false, false]);
    notifier.show(req('n4', 'other'), sender);
    expect(shown[1]!.closed).toBe(false);
  });

  it('clicking brings the window forward and tells the page which one', () => {
    shown.length = 0;
    const onClick = vi.fn();
    const send = vi.fn();
    const notifier = createNotifier({ log, onClick, isFocused: () => false });
    notifier.show(req('n1', 'durbun-crash'), { isDestroyed: () => false, send } as never);
    shown[0]!.emit('click');
    expect(onClick).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('durbun:notification-click', 'n1');
    // the clicked one is gone: a new crash with the tag does not try to close it again
    notifier.show(req('n2', 'durbun-crash'), sender);
    expect(shown[0]!.closed).toBe(false);
  });
});
