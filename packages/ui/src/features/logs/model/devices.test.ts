import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { compileNoiseRules } from '../../../data/noise';
import { deviceMarks, keepCrashRelevant, shortDeviceName } from './devices';

type Line = Pick<LogEntry, 'source' | 'origin' | 'tag' | 'process' | 'message'>;

describe('device markers', () => {
  it('gives every device its own hue, the same for the same set whatever the order', () => {
    const list = ['ios:a', 'android:b', 'demo:1', 'demo:2', 'demo:3', 'ios-sim:x'].map((id) => ({ id, name: id }));
    const a = deviceMarks(list);
    const b = deviceMarks([...list].reverse());
    expect(new Set([...a.values()].map((m) => m.hue)).size).toBe(list.length);
    for (const { id } of list) expect(b.get(id)).toEqual(a.get(id));
  });

  it('keeps chip labels short (the demo suffix stays in the tooltip)', () => {
    expect(shortDeviceName('iPhone 16 Pro · Demo')).toBe('iPhone 16 Pro');
    expect(shortDeviceName('Yusuf iPhone’u')).toBe('Yusuf iPhone’u');
    expect(deviceMarks([{ id: 'demo:1', name: 'Pixel 8 · Demo' }]).get('demo:1')).toMatchObject({ name: 'Pixel 8 · Demo', short: 'Pixel 8' });
  });
});

describe('noise next to the iPhone “apps” scope', () => {
  const rules: (e: Line) => boolean = compileNoiseRules([
    { id: 'k', field: 'process', match: 'exact', value: 'kernel', enabled: true },
    { id: 'b', field: 'process', match: 'exact', value: 'bluetoothd', enabled: true },
  ]);
  const kill = { source: 'device' as const, origin: 'idevicesyslog' as const, tag: 'kernel', process: 'kernel', message: 'memorystatus: killing_specific_process pid 811 [Runner] (per-process-limit)' };

  it('never hides the daemon lines the server kept because they explain an app’s death', () => {
    expect(rules(kill)).toBe(true);
    expect(keepCrashRelevant(rules, true)(kill)).toBe(false);
    // Other noise rules, other devices and the "all" scope work as before.
    expect(keepCrashRelevant(rules, true)({ ...kill, process: 'bluetoothd', tag: 'bluetoothd' })).toBe(true);
    expect(keepCrashRelevant(rules, true)({ ...kill, origin: 'simctl-log' })).toBe(true);
    expect(keepCrashRelevant(rules, false)(kill)).toBe(true);
  });

  it('keeps the daemons’ routine chatter hideable (the server passes it while it does not know the phone’s apps)', () => {
    const keep = keepCrashRelevant(rules, true);
    expect(keep({ ...kill, message: 'AppleBCMWLANCore: rssi -61 noise -94' })).toBe(true);
    for (const message of ['Process exited: <RBSProcessIdentity: [app<com.mykynk.kumbara>:811]>', 'jetsam: kill Runner', 'Received EXC_RESOURCE (CPU)', 'scene-update watchdog transgression: app<com.x>', 'termination reported by launchd (0, 0, 9)'])
      expect(keep({ ...kill, message })).toBe(false);
    // jetsam priority bookkeeping is chatter, not a kill.
    expect(keep({ ...kill, message: 'memorystatus: set jetsam priority 10 for pid 811' })).toBe(true);
  });
});
