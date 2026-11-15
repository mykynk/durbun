import { describe, expect, it, vi } from 'vitest';
import type { DesktopPrefs } from '../src/desktopPrefs';
import { STRINGS } from '../src/i18n';
import { createUpdateFlow, DOWNLOAD_WATCHDOG_MS, type MessageBoxRequest, type UpdateFlowDeps, type UpdatePhase } from '../src/updateFlow';
import { feedUrl, type SelfUpdate } from '../src/updates';

const t = STRINGS.en;
const feed = (version: string) => ({
  currentRelease: version,
  releases: [{ version, updateTo: { version, notes: '- New thing', url: `https://github.com/mykynk/durbun/releases/download/v${version}/Durbun-${version}-arm64-mac.zip`, size: 90_000_000 } }],
});

/** A fake world: `answers` are the buttons the user clicks, by label, in order. */
function setup(opts: { reply?: { status: number; body: unknown }; support?: SelfUpdate; answers?: string[]; prefs?: DesktopPrefs } = {}) {
  const asked: MessageBoxRequest[] = [];
  const answers = [...(opts.answers ?? [])];
  let prefs: DesktopPrefs = { ...opts.prefs };
  const phases: UpdatePhase[] = [];
  const timers: (() => void)[] = [];
  const deps: UpdateFlowDeps = {
    t: () => t,
    currentVersion: '0.2.0',
    arch: 'arm64',
    get: vi.fn(async () => opts.reply ?? { status: 200, body: feed('0.3.0') }),
    selfUpdate: () => opts.support ?? { ok: true },
    box: vi.fn(async (req: MessageBoxRequest) => {
      asked.push(req);
      const label = answers.shift();
      const i = label === undefined ? (req.cancelId ?? 0) : req.buttons.indexOf(label);
      if (i < 0) throw new Error(`no button "${label}" in ${JSON.stringify(req.buttons)}`);
      return i;
    }),
    openExternal: vi.fn(),
    startDownload: vi.fn(),
    restart: vi.fn(async () => {}),
    prefs: {
      get: () => prefs,
      update: async (patch) => {
        prefs = { ...prefs, ...patch };
      },
    },
    onPhase: (p) => phases.push(p),
    log: { info: () => {}, warn: () => {} },
    now: () => 1_000_000,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
  };
  const flow = createUpdateFlow(deps);
  return { flow, deps, asked, phases, timers, prefs: () => prefs };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('update flow', () => {
  it('nothing is downloaded before a yes; Later leaves everything as it was', async () => {
    const w = setup({ answers: [t.later] });
    await w.flow.check('manual');
    expect(w.asked[0]!.message).toBe('Dürbün 0.3.0 is available');
    expect(w.asked[0]!.detail).toContain('86 MB');
    expect(w.asked[0]!.detail).toContain("What's new:\n• New thing");
    expect(w.deps.startDownload).not.toHaveBeenCalled();
    expect(w.flow.phase).toEqual({ kind: 'idle' });
  });

  it("Read What's New opens the release page and asks again", async () => {
    const w = setup({ answers: [t.readWhatsNew, t.later] });
    await w.flow.check('manual');
    expect(w.deps.openExternal).toHaveBeenCalledWith('https://github.com/mykynk/durbun/releases/tag/v0.3.0');
    expect(w.asked).toHaveLength(2);
  });

  it('download after a yes, then restart only after a second yes', async () => {
    const w = setup({ answers: [t.downloadAndInstall, t.later, t.restartNow] });
    await w.flow.check('manual');
    expect(w.deps.startDownload).toHaveBeenCalledWith(feedUrl('arm64'));
    expect(w.flow.phase).toEqual({ kind: 'downloading', version: '0.3.0' });
    w.flow.downloaded();
    await tick();
    expect(w.asked.at(-1)!.message).toBe('Dürbün 0.3.0 is ready to install');
    expect(w.deps.restart).not.toHaveBeenCalled(); // "Later"
    expect(w.flow.phase).toEqual({ kind: 'ready', version: '0.3.0' });
    await w.flow.offerRestart(); // the menu item
    expect(w.deps.restart).toHaveBeenCalledOnce();
    expect(w.phases.map((p) => p.kind)).toEqual(['checking', 'idle', 'downloading', 'ready']);
  });

  it('a manual check during a download says so and starts nothing new', async () => {
    const w = setup({ answers: [t.downloadAndInstall, t.ok] });
    await w.flow.check('manual');
    await w.flow.check('manual');
    expect(w.asked.at(-1)!.message).toBe('Dürbün 0.3.0 is downloading');
    expect(w.deps.startDownload).toHaveBeenCalledOnce();
    expect(w.deps.get).toHaveBeenCalledOnce();
  });

  it('a copy that cannot replace itself gets the disk image for this Mac', async () => {
    const w = setup({ support: { ok: false, reason: 'unsigned' }, answers: [t.downloadDiskImage] });
    await w.flow.check('manual');
    expect(w.asked[0]!.detail).toContain('no Developer ID signature');
    expect(w.asked[0]!.detail).toContain('(Apple silicon)');
    expect(w.deps.openExternal).toHaveBeenCalledWith('https://github.com/mykynk/durbun/releases/download/v0.3.0/Durbun-0.3.0-arm64.dmg');
    expect(w.deps.startDownload).not.toHaveBeenCalled();
  });

  it('a failed download says what happened and offers the disk image', async () => {
    const w = setup({ answers: [t.downloadAndInstall, t.downloadDiskImage] });
    await w.flow.check('manual');
    w.flow.failed('Code signature at URL did not pass validation');
    await tick();
    expect(w.flow.phase).toEqual({ kind: 'idle' });
    expect(w.asked.at(-1)!.message).toBe('The update could not be installed');
    expect(w.asked.at(-1)!.detail).toContain('Details: Code signature');
    expect(w.deps.openExternal).toHaveBeenCalledWith(expect.stringContaining('Durbun-0.3.0-arm64.dmg'));
  });

  it('a download that never finishes ends with the same way out', async () => {
    const w = setup({ answers: [t.downloadAndInstall] });
    await w.flow.check('manual');
    expect(w.timers).toHaveLength(1);
    w.timers[0]!();
    await tick();
    expect(w.flow.phase).toEqual({ kind: 'idle' });
    expect(w.asked.at(-1)!.detail).toContain(`${DOWNLOAD_WATCHDOG_MS / 60_000} minutes`);
  });

  it('a Squirrel error with nothing under way is only logged', () => {
    const w = setup();
    w.flow.failed('Could not get code signature for running application');
    expect(w.asked).toHaveLength(0);
  });

  it('manual: up to date, no feed and offline each get an answer', async () => {
    const current = setup({ reply: { status: 200, body: feed('0.2.0') } });
    await current.flow.check('manual');
    expect(current.asked[0]!.message).toBe('Dürbün is up to date');
    const noFeed = setup({ reply: { status: 404, body: null }, answers: [t.openReleases] });
    await noFeed.flow.check('manual');
    expect(noFeed.asked[0]!.detail).toBe(t.updateNoFeedMessage);
    expect(noFeed.deps.openExternal).toHaveBeenCalledWith('https://github.com/mykynk/durbun/releases/latest');
    const offline = setup({ reply: { status: 502, body: null } });
    await offline.flow.check('manual');
    expect(offline.asked[0]!.message).toBe('Could not check for updates');
  });

  it('automatic: silent unless there is news, remembers the time and a skipped version', async () => {
    const quiet = setup({ reply: { status: 502, body: null } });
    await quiet.flow.check('auto');
    expect(quiet.asked).toHaveLength(0);
    expect(quiet.prefs().lastUpdateCheck).toBe(1_000_000);
    const news = setup({ answers: [t.skipVersion] });
    await news.flow.check('auto');
    expect(news.asked[0]!.buttons).toContain(t.skipVersion);
    expect(news.prefs().skippedVersion).toBe('0.3.0');
    await news.flow.check('auto');
    expect(news.asked).toHaveLength(1); // skipped: not asked again
    await news.flow.check('manual');
    expect(news.asked).toHaveLength(2); // the menu still offers it
  });

  it('asks about automatic checks once and remembers the answer', async () => {
    const w = setup({ answers: [t.autoCheckNo] });
    await w.flow.askAboutAutoCheck();
    expect(w.asked[0]!.detail).toContain('no identifier');
    expect(w.prefs().autoUpdateCheck).toBe(false);
    await w.flow.askAboutAutoCheck();
    expect(w.asked).toHaveLength(1);
    await w.flow.setAutoCheck(true); // the menu checkbox
    expect(w.prefs().autoUpdateCheck).toBe(true);
  });
});

describe('update texts', () => {
  it('every dialog text exists in Turkish and English', () => {
    for (const s of [STRINGS.tr, STRINGS.en]) {
      for (const reason of ['development', 'unsigned', 'location'] as const) expect(s.updateManualReason(reason)).toBeTruthy();
      expect(s.updateManualMessage('0.2.0', s.updateManualReason('location'), 'Intel')).toContain('Intel');
      expect(s.updateInstallMessage('0.2.0')).not.toContain('()');
      expect(s.autoCheckMessage).toMatch(/GitHub/);
    }
    expect(STRINGS.tr.autoCheckMessage).toContain('kimlik bilgisi taşımaz');
  });
});
