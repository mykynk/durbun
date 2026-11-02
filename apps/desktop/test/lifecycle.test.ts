import { describe, expect, it, vi } from 'vitest';
import { createQuitFlow } from '../src/lifecycle';

/** Electron's quit as the app sees it: 'before-quit' (preventable), then windows close. */
function fakeElectron() {
  const events: string[] = [];
  let flow: ReturnType<typeof createQuitFlow>;
  const before = () => {
    let prevented = false;
    flow.beforeQuit({ preventDefault: () => (prevented = true) });
    events.push(prevented ? 'before-quit (held)' : 'before-quit');
    return !prevented;
  };
  return { events, before, bind: (f: ReturnType<typeof createQuitFlow>) => (flow = f) };
}

describe('createQuitFlow', () => {
  it('holds the first quit until the server stopped, then quits', async () => {
    const e = fakeElectron();
    let release!: () => void;
    const stop = vi.fn(() => new Promise<void>((r) => (release = r)));
    const quit = vi.fn(() => void e.before());
    const flow = e.bind(createQuitFlow({ stop, quit }));
    expect(e.before()).toBe(false);
    expect(flow.quitting).toBe(true);
    e.before(); // ⌘Q again while stopping: still held, no second stop
    expect(stop).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    expect(e.events).toEqual(['before-quit (held)', 'before-quit (held)', 'before-quit']);
  });

  it('a quit Electron dropped during a page load ("window-all-closed" instead of "will-quit") is issued again', async () => {
    const e = fakeElectron();
    const quit = vi.fn();
    const flow = e.bind(createQuitFlow({ stop: async () => {}, quit }));
    e.before();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    // Electron reset its quitting flag: the last window closed as an ordinary close.
    flow.windowAllClosed();
    expect(quit).toHaveBeenCalledTimes(2);
  });

  it('closing the last window without a quit keeps the app in the menu bar', () => {
    const quit = vi.fn();
    createQuitFlow({ stop: async () => {}, quit }).windowAllClosed();
    expect(quit).not.toHaveBeenCalled();
  });

  it('a failing or slow stop still quits', async () => {
    const quit = vi.fn();
    const onStopped = vi.fn();
    const flow = createQuitFlow({ stop: () => Promise.reject(new Error('adb hung')), quit, onStopped });
    flow.beforeQuit({ preventDefault() {} });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(onStopped).toHaveBeenCalledOnce();
  });
});
