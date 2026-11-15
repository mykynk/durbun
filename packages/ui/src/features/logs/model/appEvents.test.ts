import { describe, expect, it } from 'vitest';
import { appLifecycleOf, exitMemoryKill, exitReportMessage, exitReportOf, isExitAnr, navigationOf, signalName } from './appEvents';

const fmt = { seconds: (s: number) => `${s} s` };
const app = (data: Record<string, unknown>) => ({ source: 'app' as const, data: { previousLaunch: true, ...data } });

describe('earlier-launch reports', () => {
  it('reads Android ApplicationExitInfo lines', () => {
    const r = exitReportOf(app({ exitReason: 'crashNative', signal: 11, importance: 'foreground' }));
    expect(r).toMatchObject({ platform: 'android', reason: 'crashNative', onScreen: true, signal: 11 });
    expect(exitReportMessage(r!, fmt)).toEqual({ key: 'android.crashNative', params: { signal: 'SIGSEGV' } });
  });

  it('tells an on-screen low-memory kill from a background one', () => {
    expect(exitMemoryKill(app({ exitReason: 'lowMemory', importance: 'visible' }))).toEqual({ visible: true });
    expect(exitMemoryKill(app({ exitReason: 'lowMemory', importance: 'cached' }))).toEqual({ visible: false });
    expect(exitReportMessage(exitReportOf(app({ exitReason: 'lowMemory', importance: 'cached' }))!, fmt)?.key).toBe('android.lowMemoryBackground');
    expect(isExitAnr(app({ exitReason: 'anr' }))).toBe(true);
  });

  it('reads iOS MetricKit diagnostics, the watchdog included', () => {
    const hang = exitReportOf(app({ source: 'MetricKit', diagnostic: 'hang', durationSeconds: 4 }));
    expect(exitReportMessage(hang!, fmt)).toEqual({ key: 'ios.hang', params: { time: '4 s' } });
    const watchdog = exitReportOf(app({ source: 'MetricKit', diagnostic: 'crash', terminationReason: 'Namespace SPRINGBOARD, Code 0x8badf00d' }));
    expect(exitReportMessage(watchdog!, fmt)?.key).toBe('ios.watchdog');
  });

  it('leaves other lines and unknown reasons to the SDK’s own text', () => {
    expect(exitReportOf({ source: 'device', data: { previousLaunch: true, exitReason: 'anr' } })).toBeUndefined();
    expect(exitReportOf(app({}))).toBeUndefined();
    expect(exitReportMessage(exitReportOf(app({ exitReason: 'somethingNew' }))!, fmt)).toBeUndefined();
    expect(signalName(undefined)).toBe('?');
    expect(signalName(42)).toBe('signal 42');
  });
});

describe('screen changes and lifecycle', () => {
  it('reads navigation events', () => {
    expect(navigationOf({ kind: 'event', message: 'navigation', data: { from: ' Home ', to: 'Cart' } })).toEqual({ from: 'Home', to: 'Cart' });
    expect(navigationOf({ kind: 'event', message: 'navigation', data: { to: '' } })).toBeUndefined();
    expect(navigationOf({ kind: 'text', message: 'navigation', data: { to: 'Cart' } })).toBeUndefined();
  });

  it('reads Flutter lifecycle lines', () => {
    expect(appLifecycleOf({ source: 'app', tag: 'lifecycle', message: 'AppLifecycleState.paused' })).toBe('paused');
    expect(appLifecycleOf({ source: 'app', tag: 'lifecycle', message: 'paused' })).toBeUndefined();
    expect(appLifecycleOf({ source: 'device', tag: 'lifecycle', message: 'AppLifecycleState.resumed' })).toBeUndefined();
  });
});
