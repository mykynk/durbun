import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { splashUrl, statusPageUrl, syncFullScreen, type FullScreenSource } from '../src/chrome';

describe('splash', () => {
  it('is a self-contained data: page without scripts', () => {
    const url = splashUrl('Dürbün başlatılıyor…', 'dark');
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    const html = decodeURIComponent(url.slice(url.indexOf(',') + 1));
    expect(html).toContain('Dürbün başlatılıyor…');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('#0b0d12');
    expect(decodeURIComponent(splashUrl('<b>x</b>', 'light'))).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('status page', () => {
  const html = (url: string) => decodeURIComponent(url.slice(url.indexOf(',') + 1));
  it('a failed start says why instead of "starting…" (no spinner, no scripts)', () => {
    const page = html(statusPageUrl({ theme: 'light', title: 'Dürbün başlatılamadı', text: 'Port 9750 is already in use', busy: false }));
    expect(page).toContain('Dürbün başlatılamadı');
    expect(page).toContain('Port 9750 is already in use');
    expect(page).not.toContain('class="bar"');
    expect(page).not.toMatch(/<script/i);
    expect(page).toContain('#f5f6f9');
    expect(html(splashUrl('Dürbün başlatılıyor…', 'dark'))).toContain('class="bar"');
  });
});

describe('syncFullScreen', () => {
  function fakeWindow() {
    const w = new EventEmitter() as EventEmitter & FullScreenSource & { full: boolean };
    w.full = false;
    w.isFullScreen = () => w.full;
    w.webContents = new EventEmitter() as unknown as FullScreenSource['webContents'];
    return w;
  }
  it('sends the state on transitions and on every page load (a reload in full screen keeps it)', () => {
    const w = fakeWindow();
    const sent: boolean[] = [];
    syncFullScreen(w, (on) => sent.push(on));
    w.full = true;
    w.emit('enter-full-screen');
    (w.webContents as unknown as EventEmitter).emit('dom-ready'); // ⌘R while in full screen
    w.full = false;
    w.emit('leave-full-screen');
    (w.webContents as unknown as EventEmitter).emit('dom-ready');
    expect(sent).toEqual([true, true, false, false]);
  });
});
