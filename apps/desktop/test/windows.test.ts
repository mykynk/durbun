import { describe, expect, it } from 'vitest';
import { CASCADE_STEP, cascadeBounds, closeDecision, createWindowRegistry, mayTakeOpenedFiles, type WindowLike } from '../src/windows';

let nextId = 1;
function fakeWindow(opts: { visible?: boolean; focused?: boolean } = {}) {
  const w = {
    destroyed: false,
    visible: opts.visible ?? true,
    focused: opts.focused ?? false,
    webContents: { id: nextId++ },
    isDestroyed: () => w.destroyed,
    isVisible: () => w.visible,
    isFocused: () => w.focused,
  };
  return w;
}
type Fake = ReturnType<typeof fakeWindow> & WindowLike;

describe('window registry', () => {
  it('the first window is the main one; the most recently focused comes first', () => {
    const r = createWindowRegistry<Fake>();
    const a = fakeWindow();
    const b = fakeWindow();
    r.add(a);
    r.add(b);
    expect(r.main()).toBe(a);
    expect(r.isMain(b)).toBe(false);
    expect(r.all()).toEqual([b, a]);
    r.focused(a);
    expect(r.all()).toEqual([a, b]);
    expect(r.size).toBe(2);
  });
  it('current: the focused window, else a visible one used last, else any', () => {
    const r = createWindowRegistry<Fake>();
    const main = fakeWindow({ visible: false });
    const other = fakeWindow();
    r.add(main);
    r.add(other);
    r.focused(main);
    expect(r.current()).toBe(other); // main is hidden
    other.focused = true;
    expect(r.current()).toBe(other);
    other.visible = false;
    other.focused = false;
    expect(r.current()).toBe(main); // nothing visible: the one used last
  });
  it('a sender is trusted only while its window lives', () => {
    const r = createWindowRegistry<Fake>();
    const a = fakeWindow();
    const b = fakeWindow();
    r.add(a);
    r.add(b);
    expect(r.byWebContentsId(b.webContents.id)).toBe(b);
    expect(r.byWebContentsId(9_999)).toBeUndefined();
    b.destroyed = true;
    expect(r.byWebContentsId(b.webContents.id)).toBeUndefined();
    expect(r.all()).toEqual([a]);
  });
  it('closing the main window leaves no main; the next window becomes it', () => {
    const r = createWindowRegistry<Fake>();
    const a = fakeWindow();
    r.add(a);
    r.remove(a);
    expect(r.main()).toBeUndefined();
    const b = fakeWindow();
    r.add(b);
    expect(r.main()).toBe(b);
  });
  it('counts the other visible windows', () => {
    const r = createWindowRegistry<Fake>();
    const a = fakeWindow();
    const b = fakeWindow();
    const c = fakeWindow({ visible: false });
    for (const w of [a, b, c]) r.add(w);
    expect(r.visibleOthers(a)).toBe(1);
    b.visible = false;
    expect(r.visibleOthers(a)).toBe(0);
  });
});

describe('closeDecision', () => {
  it('the main window hides, another window closes; the menu-bar note only for the last one on screen', () => {
    expect(closeDecision({ quitting: false, isMain: true, otherVisible: 0 })).toEqual({ action: 'hide', lastWindow: true });
    expect(closeDecision({ quitting: false, isMain: true, otherVisible: 1 })).toEqual({ action: 'hide', lastWindow: false });
    expect(closeDecision({ quitting: false, isMain: false, otherVisible: 1 })).toEqual({ action: 'close', lastWindow: false });
    expect(closeDecision({ quitting: false, isMain: false, otherVisible: 0 })).toEqual({ action: 'close', lastWindow: true });
  });
  it('a quit closes every window without the note', () => {
    expect(closeDecision({ quitting: true, isMain: true, otherVisible: 0 })).toEqual({ action: 'close', lastWindow: false });
  });
});

describe('cascadeBounds', () => {
  const area = { x: 0, y: 25, width: 1512, height: 920 };
  const size = { width: 1360, height: 860 };
  it('one step down and right of the window in use, same size', () => {
    expect(cascadeBounds({ x: 10, y: 40, width: 1000, height: 700 }, area, size)).toEqual({ x: 10 + CASCADE_STEP, y: 40 + CASCADE_STEP, width: 1000, height: 700 });
  });
  it('back to the top left when the step would leave the screen', () => {
    expect(cascadeBounds({ x: 500, y: 200, width: 1000, height: 700 }, area, size)).toEqual({ x: CASCADE_STEP, y: 25 + CASCADE_STEP, width: 1000, height: 700 });
    // A window as large as the screen stays inside it.
    expect(cascadeBounds({ x: 0, y: 25, width: 1512, height: 920 }, area, size)).toEqual({ x: 0, y: 25, width: 1512, height: 920 });
  });
  it('without a window to start from: centred, never larger than the screen', () => {
    expect(cascadeBounds(undefined, area, size)).toEqual({ x: 76, y: 55, width: 1360, height: 860 });
    expect(cascadeBounds(undefined, { x: 0, y: 0, width: 1000, height: 600 }, size)).toEqual({ x: 0, y: 0, width: 1000, height: 600 });
  });
});

describe('files opened from Finder', () => {
  it('go to the window they were sent to while it lives', () => {
    expect(mayTakeOpenedFiles({ senderId: 1, targetId: null, targetAlive: false })).toBe(true);
    expect(mayTakeOpenedFiles({ senderId: 1, targetId: 1, targetAlive: true })).toBe(true);
    expect(mayTakeOpenedFiles({ senderId: 2, targetId: 1, targetAlive: true })).toBe(false);
    expect(mayTakeOpenedFiles({ senderId: 2, targetId: 1, targetAlive: false })).toBe(true);
  });
});
