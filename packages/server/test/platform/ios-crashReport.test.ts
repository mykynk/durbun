import { describe, expect, it } from 'vitest';
import {
  crashFileDate,
  crashFileProcess,
  crashReportEntry,
  formatFrame,
  isCrashFileName,
  isCrashReport,
  isThirdPartyBundle,
  parseIps,
  simulatorUdidOf,
} from '../../src/platform/ios/crashReport';
import { fixture } from './helpers';

/** The UI's Apple frame matcher (packages/ui/src/features/logs/model/frames.ts). */
const UI_APPLE_FRAME = /^\s*\d+\s+(\S+)\s+0x[0-9a-fA-F]+\s+(.*)$/;

describe('.ips crash reports (bug_type 309, two-part JSON)', () => {
  it('Swift crash in a developer build: header, exception, ASI message, unsymbolicated app frames', () => {
    const r = parseIps(fixture('ios-swift-crash.ips'))!;
    expect(r).toMatchObject({
      bugType: '309',
      appName: 'Runner',
      bundleId: 'com.mykynk.pati',
      version: '2.3.0',
      build: '57',
      pid: 1234,
      procName: 'Runner',
      exceptionType: 'EXC_BREAKPOINT',
      signal: 'SIGTRAP',
      termination: 'SIGNAL 5 Trace/BPT trap: 5',
      crashedThread: 0,
      crashedQueue: 'com.apple.main-thread',
      symbolicated: false,
      legacy: false,
    });
    expect(isCrashReport(r)).toBe(true);
    // captureTime (more precise than the header timestamp), +03:00.
    expect(r.ts).toBeCloseTo(Date.UTC(2026, 10, 2, 8, 42, 58) + 771.2, 1);
    expect(r.frames).toHaveLength(8);
    expect(r.frames[0]).toMatchObject({ image: 'Runner', imageOffset: 53412, appImage: true, address: 4302635008 + 53412 });
    expect(r.frames[0]!.symbol).toBeUndefined();
    expect(r.frames[3]).toMatchObject({ image: 'UIKitCore', symbol: '-[UIApplication sendAction:to:from:forEvent:]', appImage: false });

    const e = crashReportEntry(r, { watchStart: Date.UTC(2026, 10, 2, 9, 0, 0), file: '/tmp/x/Runner.ips' });
    expect(e).toMatchObject({
      level: 'fatal',
      kind: 'crash',
      origin: 'crash-report',
      tag: 'crash-report',
      process: 'Runner',
      pid: 1234,
      message:
        'Runner 2.3.0 (57) crashed: Runner/BasketViewModel.swift:42: Fatal error: Unexpectedly found nil while unwrapping an Optional value',
    });
    expect(e.data).toMatchObject({
      origin: 'crash-report',
      bundleId: 'com.mykynk.pati',
      previousLaunch: true,
      symbolicated: false,
      version: '2.3.0',
      build: '57',
      file: '/tmp/x/Runner.ips',
    });
    expect(e.error?.type).toBe('EXC_BREAKPOINT');
    expect(e.error?.message).toContain('Termination: SIGNAL 5 Trace/BPT trap: 5');
    const stack = e.error!.stack!.split('\n');
    expect(stack[0]).toBe('Thread 0 Crashed (com.apple.main-thread):');
    expect(stack[1]).toBe(`0   Runner                  0x${(4302635008 + 53412).toString(16).padStart(16, '0')} Runner + 0xd0a4`);
    expect(stack[4]).toContain('-[UIApplication sendAction:to:from:forEvent:] + 96');
    for (const line of stack.slice(1)) expect(UI_APPLE_FRAME.test(line)).toBe(true);
    // Display name from the device when known.
    expect(crashReportEntry(r, { watchStart: 0, appName: 'Pati' }).message.startsWith('Pati 2.3.0 (57) crashed:')).toBe(true);
    expect((crashReportEntry(r, { watchStart: 0 }).data as { previousLaunch: boolean }).previousLaunch).toBe(false);
  });

  it('ObjC exception: exceptionReason + Last Exception Backtrace before the crashed thread', () => {
    const r = parseIps(fixture('ios-objc-exception.ips'))!;
    expect(r.objcException).toEqual({
      name: 'NSInvalidArgumentException',
      message: '-[__NSCFNumber length]: unrecognized selector sent to instance 0x8000000000000000',
    });
    expect(r.exceptionFrames).toHaveLength(8);
    expect(r.exceptionFrames[5]).toMatchObject({ image: 'Mahalle', appImage: true });
    expect(r.asi).toEqual(['abort() called']);
    const e = crashReportEntry(r, { watchStart: 0 });
    expect(e.message).toBe(
      'Mahalle 4.1.0 (412) crashed: NSInvalidArgumentException: -[__NSCFNumber length]: unrecognized selector sent to instance 0x8000000000000000',
    );
    expect(e.error?.type).toBe('NSInvalidArgumentException');
    expect(e.error?.message).toContain('EXC_CRASH (SIGABRT)');
    expect(e.error?.message).not.toContain('codes 0x0');
    const stack = e.error!.stack!;
    expect(stack.startsWith('Last Exception Backtrace:\n0   CoreFoundation')).toBe(true);
    expect(stack).toContain('\n\nThread 0 Crashed (com.apple.main-thread):\n0   libsystem_kernel.dylib');
    expect(stack).toContain('Mahalle + 0xdec00');
  });

  it('Flutter engine abort on the io.flutter.1.ui thread (TestFlight build)', () => {
    const r = parseIps(fixture('ios-flutter-abort.ips'))!;
    expect(r).toMatchObject({ bundleId: 'com.mykynk.kasa', crashedThread: 3, crashedQueue: 'io.flutter.1.ui', symbolicated: false });
    expect(r.frames.map((f) => f.image)).toEqual([
      'libsystem_kernel.dylib',
      'libsystem_pthread.dylib',
      'libsystem_c.dylib',
      'Flutter',
      'Flutter',
      'Flutter',
      'App',
      'App',
      'Flutter',
    ]);
    expect(r.frames.filter((f) => f.appImage).length).toBe(6);
    const e = crashReportEntry(r, { watchStart: 0 });
    expect(e.message).toBe('Runner 1.0.4 (19) crashed: EXC_CRASH (SIGABRT) · abort() in the Flutter engine');
    expect(e.error!.stack).toContain('Thread 3 Crashed (io.flutter.1.ui):');
    expect(e.error!.stack).toContain('Flutter                 0x');
    expect(e.error!.stack).toContain('App + 0x21ba48');
  });

  it('simulator report (macOS side): anonymized paths, UDID from the coalition, symbols present', () => {
    const r = parseIps(fixture('ios-sim-crash.ips'))!;
    expect(r.platform).toBe(7);
    expect(simulatorUdidOf(r)).toBe('7B1E9C2A-4D3F-4A8B-9C6D-2E5F8A1B3C4D');
    expect(r.subtype).toBe('KERN_INVALID_ADDRESS at 0x0000000000000010');
    expect(r.symbolicated).toBe(true);
    const e = crashReportEntry(r, { watchStart: 0 });
    expect(e.message).toBe('Runner 2.4.0 (60) crashed: EXC_BAD_ACCESS (SIGSEGV) · KERN_INVALID_ADDRESS at 0x0000000000000010');
    expect(e.error!.stack).toContain('BasketCell.configure(with:) + 312 (BasketCell.swift:48)');
    // Older macOS keeps full CoreSimulator paths.
    expect(simulatorUdidOf({ ...r, coalition: undefined, paths: ['/Users/dev/Library/Developer/CoreSimulator/Devices/7b1e9c2a-4d3f-4a8b-9c6d-2e5f8a1b3c4d/data/x'] })).toBe(
      '7B1E9C2A-4D3F-4A8B-9C6D-2E5F8A1B3C4D',
    );
  });

  it('legacy iOS 14 report (bug_type 109, text body)', () => {
    const r = parseIps(fixture('ios-legacy-crash.ips'))!;
    expect(r).toMatchObject({
      legacy: true,
      bugType: '109',
      bundleId: 'com.mykynk.pati',
      version: '1.8.0',
      build: '31',
      pid: 2215,
      procName: 'Runner',
      exceptionType: 'EXC_BAD_ACCESS',
      signal: 'SIGSEGV',
      subtype: 'KERN_INVALID_ADDRESS at 0x0000000000000010',
      termination: 'Namespace SIGNAL, Code 0xb',
      crashedThread: 0,
      crashedQueue: 'com.apple.main-thread',
      symbolicated: false,
    });
    expect(isCrashReport(r)).toBe(true);
    expect(r.frames).toHaveLength(7);
    expect(r.frames[0]).toMatchObject({ image: 'Runner', appImage: true, imageOffset: 12704 });
    expect(r.frames[2]).toMatchObject({ image: 'UIKitCore', symbol: '-[UIApplication sendAction:to:from:forEvent:]', symbolLocation: 96 });
    const e = crashReportEntry(r, { watchStart: Date.now() });
    expect(e.ts).toBeCloseTo(Date.UTC(2021, 2, 14, 7, 21, 33) + 451.6, 1);
    expect((e.data as { previousLaunch: boolean }).previousLaunch).toBe(true);
    for (const line of e.error!.stack!.split('\n').slice(1)) expect(UI_APPLE_FRAME.test(line)).toBe(true);
  });

  it('ignores non-crash report types and keeps system apps out', () => {
    const jetsam = parseIps(fixture('ios-jetsam.ips'))!;
    expect(jetsam.bugType).toBe('298');
    expect(isCrashReport(jetsam)).toBe(false);
    const safari = parseIps(fixture('ios-system-crash.ips'))!;
    expect(isCrashReport(safari)).toBe(true);
    expect(isThirdPartyBundle(safari.bundleId)).toBe(false);
    expect(isThirdPartyBundle('com.mykynk.pati')).toBe(true);
    expect(isThirdPartyBundle('com.apple')).toBe(false);
    expect(isThirdPartyBundle(undefined)).toBe(false);
    // Simulated corpses (ExcUserFault_*) are not crashes.
    const simulated = parseIps('{"bug_type":"309","is_simulated":1,"bundleID":"x.y"}\n{}')!;
    expect(isCrashReport(simulated)).toBe(false);
    expect(parseIps('not an ips')).toBeNull();
    expect(parseIps('')).toBeNull();
    // Header only (file still being written) parses without throwing.
    expect(parseIps('{"bug_type":"309","bundleID":"x.y"}\n{"exception" : ')).toMatchObject({ bugType: '309', frames: [] });
  });

  it('recognizes crash file names and their dates', () => {
    expect(isCrashFileName('Runner-2026-11-02-114258.ips')).toBe(true);
    expect(isCrashFileName('Retired/Runner-2026-11-02-114258.000.ips')).toBe(true);
    expect(isCrashFileName('JetsamEvent-2026-11-02-084012.ips')).toBe(false);
    expect(isCrashFileName('ExcUserFault_Runner-2026-11-02-084012.ips')).toBe(false);
    expect(isCrashFileName('Analytics-2026-11-02-000412.ips.ca.synced')).toBe(false);
    expect(crashFileProcess('Runner-2026-11-02-114258.ips')).toBe('Runner');
    expect(crashFileProcess('My-App-2026-11-02-114258.ips')).toBe('My-App');
    expect(crashFileDate('Runner-2026-11-02-114258.ips')).toBe(new Date(2026, 10, 2, 11, 42, 58).getTime());
    expect(crashFileDate('Runner.ips')).toBeUndefined();
  });

  it('formats frames like Apple crash logs', () => {
    expect(formatFrame(0, { image: 'Runner', imageOffset: 0x1a2b0, address: 0x1000001a2b0, appImage: true })).toBe(
      '0   Runner                  0x000001000001a2b0 Runner + 0x1a2b0',
    );
    expect(formatFrame(12, { image: 'UIKitCore', symbol: 'UIApplicationMain', symbolLocation: 340, address: 0x1a2b3c4d5, appImage: false })).toBe(
      '12  UIKitCore               0x00000001a2b3c4d5 UIApplicationMain + 340',
    );
    expect(formatFrame(1, { image: 'Runner', imageOffset: 16, appImage: true })).toBe('1   Runner                  Runner + 0x10');
  });
});
