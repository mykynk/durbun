import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyZoomLevel,
  entriesToCopy,
  legacyOriginFor,
  migrateUiStorage,
  planZoomMove,
  readMigratedPorts,
  recordZoomMoved,
  zoomLevelToMove,
  type StoragePage,
} from '../src/storageMigration';

/** localStorage of one origin (the parts the page scripts use). */
class FakeStorage {
  private readonly map = new Map<string, string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.map.set(k, v);
  }
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  dump(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

/** A hidden window stand-in: runs the page scripts against the storage of the origin it shows. */
function fakeBrowser(origins: Record<string, Record<string, string>>, opts: { failOn?: string } = {}) {
  const stores = new Map(Object.entries(origins).map(([o, init]) => [o, new FakeStorage(init)]));
  const opened: string[] = [];
  let pages = 0;
  let closed = 0;
  const page = async (): Promise<StoragePage & { close(): void }> => {
    pages++;
    let current = '';
    return {
      open: async (origin) => {
        opened.push(origin);
        current = origin;
        if (!stores.has(origin)) stores.set(origin, new FakeStorage());
      },
      run: async <T,>(script: string): Promise<T> => {
        if (opts.failOn && current === opts.failOn) throw new Error('renderer gone');
        return new Function('localStorage', `return (${script});`)(stores.get(current)) as T;
      },
      close: () => {
        closed++;
      },
    };
  };
  return { page, opened, stores, counts: () => ({ pages, closed }) };
}

const tmpFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'durbun-migration-')), 'storage-migration.json');
const prefs = JSON.stringify({ theme: 'light', language: 'tr', highlightRules: [{ id: 'h1', pattern: 'Pati', color: 'violet' }] });

describe('migrateUiStorage', () => {
  it('moves the UI preferences from localhost:<port> to 127.0.0.1:<port> once', async () => {
    const file = tmpFile();
    const b = fakeBrowser({
      'http://localhost:9750': { 'durbun.prefs.v1': prefs, 'durbun.state.netFilters': '{"q":"api"}', 'other.app': 'x' },
      'http://127.0.0.1:9750': { 'durbun.state.netFilters': '{"q":"kept"}' },
    });
    expect(await migrateUiStorage(9750, file, b.page, 'http://127.0.0.1:9750')).toEqual({ kind: 'moved', keys: 1 });
    // only data: documents of the two origins were opened (main.ts passes them as baseURLForDataURL)
    expect(b.opened).toEqual(['http://localhost:9750', 'http://127.0.0.1:9750']);
    expect(b.stores.get('http://127.0.0.1:9750')!.dump()).toEqual({ 'durbun.state.netFilters': '{"q":"kept"}', 'durbun.prefs.v1': prefs });
    expect(readMigratedPorts(file)).toEqual([9750]);
    expect(b.counts()).toEqual({ pages: 1, closed: 1 });

    // next start: nothing to do, no hidden window
    expect(await migrateUiStorage(9750, file, b.page, 'http://127.0.0.1:9750')).toEqual({ kind: 'skipped' });
    expect(b.counts().pages).toBe(1);
    // another port has its own origin
    expect(await migrateUiStorage(9760, file, b.page, 'http://127.0.0.1:9760')).toEqual({ kind: 'moved', keys: 0 });
    expect(readMigratedPorts(file)).toEqual([9750, 9760]);
  });

  it('tries again next time when reading failed, and always closes the window', async () => {
    const file = tmpFile();
    const b = fakeBrowser({ 'http://localhost:9750': { 'durbun.prefs.v1': prefs } }, { failOn: 'http://localhost:9750' });
    await expect(migrateUiStorage(9750, file, b.page, 'http://127.0.0.1:9750')).rejects.toThrow('renderer gone');
    expect(existsSync(file)).toBe(false);
    expect(b.counts()).toEqual({ pages: 1, closed: 1 });
    const ok = fakeBrowser({ 'http://localhost:9750': { 'durbun.prefs.v1': prefs } });
    expect(await migrateUiStorage(9750, file, ok.page, 'http://127.0.0.1:9750')).toEqual({ kind: 'moved', keys: 1 });
  });
});

describe('entriesToCopy', () => {
  it('copies only the UI\'s keys the new origin lacks', () => {
    expect(entriesToCopy({ 'durbun.a': '1', 'durbun.b': '2', 'x.c': '3' }, { 'durbun.b': 'new' })).toEqual({ 'durbun.a': '1' });
    expect(entriesToCopy(null, {})).toEqual({});
    expect(entriesToCopy({ 'durbun.a': 5 }, null)).toEqual({});
  });
  it('the old origin is the one 0.1.x loaded', () => {
    expect(legacyOriginFor(9750)).toBe('http://localhost:9750');
  });
});

describe('readMigratedPorts', () => {
  it('ignores a missing or damaged file', () => {
    expect(readMigratedPorts(path.join(os.tmpdir(), 'durbun-missing-dir', 'none.json'))).toEqual([]);
  });
});

/** The profile's Preferences as Electron 45 writes it (partition key: a hash of the session's path). */
const chromiumPrefs = (hosts: Record<string, unknown>) => ({ partition: { per_host_zoom_levels: { '6911344115800615741': hosts } }, spellcheck: {} });

describe('page zoom', () => {
  it('moves the localhost zoom to 127.0.0.1 once, and not again after the user went back to 100 %', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'durbun-zoom-'));
    const file = path.join(dir, 'storage-migration.json');
    const prefsFile = path.join(dir, 'Preferences');
    writeFileSync(prefsFile, JSON.stringify(chromiumPrefs({ localhost: 1.5 })));
    expect(planZoomMove(file, prefsFile, '127.0.0.1')).toEqual({ kind: 'move', level: 1.5 });

    // main.ts: the window shows the UI on 127.0.0.1 (no zoom of its own yet) → set, then recorded
    let level = 0;
    const page = { getZoomLevel: () => level, setZoomLevel: (l: number) => void (level = l) };
    expect(applyZoomLevel(page, 1.5)).toBe(true);
    expect(level).toBe(1.5);
    await recordZoomMoved(file);

    // Actual Size on 127.0.0.1 removes its entry while localhost keeps 1.5: the record keeps it at 100 %
    writeFileSync(prefsFile, JSON.stringify(chromiumPrefs({ localhost: 1.5 })));
    expect(planZoomMove(file, prefsFile, '127.0.0.1')).toEqual({ kind: 'done' });
  });

  it('the zoom record and the port record do not overwrite each other', async () => {
    const file = tmpFile();
    const b = fakeBrowser({ 'http://localhost:9750': { 'durbun.prefs.v1': prefs } });
    await Promise.all([recordZoomMoved(file), migrateUiStorage(9750, file, b.page, 'http://127.0.0.1:9750')]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, ports: [9750], zoomMoved: true });
    await migrateUiStorage(9760, file, b.page, 'http://127.0.0.1:9760');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, ports: [9750, 9760], zoomMoved: true });
  });

  it('nothing to move: a new profile, 100 % on localhost, or 127.0.0.1 already has a zoom', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'durbun-zoom-'));
    const file = path.join(dir, 'storage-migration.json');
    expect(planZoomMove(file, path.join(dir, 'Preferences'), '127.0.0.1')).toEqual({ kind: 'none' });
    expect(zoomLevelToMove(chromiumPrefs({}), '127.0.0.1')).toBeUndefined();
    expect(zoomLevelToMove(chromiumPrefs({ localhost: 2, '127.0.0.1': -1 }), '127.0.0.1')).toBeUndefined();
    expect(zoomLevelToMove({ partition: { per_host_zoom_levels: { a: { '127.0.0.1': 1 }, b: { localhost: 2 } } } }, '127.0.0.1')).toBeUndefined();
    // and the page itself got a zoom before the UI loaded: it stays
    let level = 0.5;
    expect(applyZoomLevel({ getZoomLevel: () => level, setZoomLevel: (l) => void (level = l) }, 2)).toBe(false);
    expect(level).toBe(0.5);
  });

  it('reads the level whatever the partition key, in Electron\'s and Chrome\'s format, and ignores junk', () => {
    expect(zoomLevelToMove(chromiumPrefs({ localhost: -0.5, 'example.com': 3 }), '127.0.0.1')).toBe(-0.5);
    expect(zoomLevelToMove(chromiumPrefs({ localhost: { last_modified: '13300000000000000', zoom_level: 1 } }), '127.0.0.1')).toBe(1);
    expect(zoomLevelToMove({ partition: { per_host_zoom_levels: { x: null, y: { localhost: 2 } } } }, '127.0.0.1')).toBe(2);
    for (const junk of [null, 'x', {}, { partition: [] }, chromiumPrefs({ localhost: 'big' }), chromiumPrefs({ localhost: 99 }), chromiumPrefs({ localhost: 0 })]) {
      expect(zoomLevelToMove(junk, '127.0.0.1')).toBeUndefined();
    }
  });
});
