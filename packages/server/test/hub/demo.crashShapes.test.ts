/**
 * The demo's dropbox rows must look exactly like the Android driver's (platform/android/dropbox.ts): the
 * same record, read by the driver, gives the same LogEntry. Guards the demo against shape drift.
 */
import { describe, expect, it } from 'vitest';
import { anrReport } from '../../src/demo/content';
import { dropboxRecord, KUMBARA_CHANNEL_CRASH, KUMBARA_WIDGET_NPE, kumbaraAnrTraces, localStamp } from '../../src/demo/crashReports';
import { androidAnrLine } from '../../src/demo/noise';
import { dropboxToCrash, type DropboxRecord } from '../../src/platform/android/dropbox';
import { AndroidCrashGrouper } from '../../src/platform/android/logcat';
import type { DeviceLogInput } from '../../src/types';

const KUMBARA = 'com.mykynk.kumbara';
// the demo's watch started at 13:00:00.250 local time; dropbox prints whole seconds
const WATCH_START = new Date(2026, 10, 2, 13, 0, 0, 250).getTime();

function record(patch: Partial<DropboxRecord> & Pick<DropboxRecord, 'tag' | 'body'>, reportTs: number, headers: Record<string, string>): DropboxRecord {
  return { date: localStamp(reportTs), index: 0, text: true, headers, packages: [`${KUMBARA} v310 (3.1.0)`], ...patch };
}

describe('demo dropbox rows = Android driver rows', () => {
  it('data_app_crash of a previous launch (widget process) and of this launch', () => {
    for (const [process, pid, reportTs, foreground, error] of [
      [`${KUMBARA}:widget`, 9312, WATCH_START - 3 * 3_600_000 - 12 * 60_000 - 9_000, false, KUMBARA_WIDGET_NPE],
      [KUMBARA, 12_045, WATCH_START + 61_480, true, KUMBARA_CHANNEL_CRASH],
      [KUMBARA, 12_045, WATCH_START + 300, true, KUMBARA_CHANNEL_CRASH], // same second as the watch start
    ] as const) {
      const demo = dropboxRecord({ tag: 'data_app_crash', pkg: KUMBARA, process, pid, version: '3.1.0', versionCode: '310', foreground, reportTs, watchStart: WATCH_START, error, body: error.stack });
      const rec = record({ tag: 'data_app_crash', body: `${error.stack}\n` }, reportTs, {
        Process: process,
        PID: String(pid),
        UID: '10241',
        Flags: '0x38c8be44', // FLAG_DEBUGGABLE (0x2) clear: a release build
        Package: `${KUMBARA} v310 (3.1.0)`,
        Foreground: foreground ? 'Yes' : 'No',
        Build: 'google/shiba/shiba:15/AP4A.241205.013/12621605:user/release-keys',
      });
      const driver = dropboxToCrash(rec, {}, WATCH_START)!.entry;
      expect(demo).toEqual(driver);
    }
  });

  it('the live ActivityManager ANR line: what the logcat parser makes of it (app pid and process, data.package)', () => {
    const ts = WATCH_START + 170_000;
    for (const [pkg, pid] of [
      [KUMBARA, 12_045],
      ['com.mykynk.mahalle', 6612],
    ] as const) {
      const report = anrReport(pkg, pid, new Date(ts));
      const parsed: DeviceLogInput[] = [];
      // logcat: system_server (pid 1043) prints the report; the pipeline names the process from its pid table
      new AndroidCrashGrouper((e) => parsed.push(e)).push({ ts, level: 'error', tag: 'ActivityManager', message: report, pid: 1043, tid: 1045, process: 'system_server' });
      expect(parsed).toHaveLength(1);
      expect(androidAnrLine(1043, pkg, pid, report, ts)).toEqual(parsed[0]);
    }
  });

  it('data_app_anr with its main-thread traces', () => {
    const reportTs = WATCH_START + 170_912;
    const traces = kumbaraAnrTraces(12_045, reportTs);
    const subject = `Input dispatching timed out (8f2c1a0 ${KUMBARA}/${KUMBARA}.MainActivity (server) is not responding. Waited 5001ms for MotionEvent)`;
    const demo = dropboxRecord({
      tag: 'data_app_anr',
      pkg: KUMBARA,
      process: KUMBARA,
      pid: 12_045,
      version: '3.1.0',
      versionCode: '310',
      foreground: true,
      reportTs,
      watchStart: WATCH_START,
      error: { type: 'ANR', message: subject, stack: traces.stack },
      body: traces.body,
      duplicateOf: 77,
    });
    const rec = record({ tag: 'data_app_anr', body: traces.body }, reportTs, {
      Process: KUMBARA,
      PID: '12045',
      Flags: '0x38c8be44',
      Package: `${KUMBARA} v310 (3.1.0)`,
      Foreground: 'Yes',
      Subject: subject,
    });
    const driver = dropboxToCrash(rec, {}, WATCH_START)!.entry;
    // duplicateOf is the driver's dedupe step (CrashIndex), done by the demo itself
    expect(demo).toEqual({ ...driver, data: { ...(driver.data as object), duplicateOf: 77 } });
  });
});
