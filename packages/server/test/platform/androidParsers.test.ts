import { describe, expect, it } from 'vitest';
import {
  connectionForSerial,
  cpuPercent,
  mapAdbState,
  parseAdbDevices,
  parseBattery,
  parseForwardPort,
  parseGetprop,
  parsePackageDump,
  parsePackageList,
  parsePidof,
  parsePortMappings,
  parseProcStat,
  parsePs,
  parseVmRssMB,
  parseWmOutput,
} from '../../src/platform/android/parsers';

describe('adb devices -l', () => {
  const out = [
    '* daemon not running; starting now at tcp:5037',
    '* daemon started successfully',
    'List of devices attached',
    'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1',
    'R58M123ABC             unauthorized usb:1-1 transport_id:2',
    '192.168.1.20:5555      offline transport_id:3',
    'adb-R58M123ABC-AbCdEf._adb-tls-connect._tcp device product:o1sxeea model:SM_G991B device:o1s transport_id:4',
    '0123456789ABCDEF       no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:1-2 transport_id:5',
    '',
  ].join('\n');

  it('parses serial, state and properties', () => {
    const rows = parseAdbDevices(out);
    expect(rows.map((r) => [r.serial, r.state])).toEqual([
      ['emulator-5554', 'device'],
      ['R58M123ABC', 'unauthorized'],
      ['192.168.1.20:5555', 'offline'],
      ['adb-R58M123ABC-AbCdEf._adb-tls-connect._tcp', 'device'],
      ['0123456789ABCDEF', 'no permissions'],
    ]);
    expect(rows[0]!.props).toMatchObject({ model: 'sdk_gphone64_arm64', transport_id: '1', device: 'emu64a' });
    expect(rows[3]!.props.model).toBe('SM_G991B');
    expect(rows[4]!.props).toMatchObject({ usb: '1-2', transport_id: '5' });
  });

  it('maps states and connection types', () => {
    expect(mapAdbState('device')).toBe('online');
    expect(mapAdbState('unauthorized')).toBe('unauthorized');
    expect(mapAdbState('authorizing')).toBe('unauthorized');
    expect(mapAdbState('offline')).toBe('offline');
    expect(mapAdbState('recovery')).toBe('offline');
    expect(connectionForSerial('emulator-5554')).toBe('local');
    expect(connectionForSerial('127.0.0.1:5555')).toBe('local');
    expect(connectionForSerial('192.168.1.20:5555')).toBe('wifi');
    expect(connectionForSerial('[fe80::1%wlan0]:5555')).toBe('wifi');
    expect(connectionForSerial('adb-R58M123ABC-AbCdEf._adb-tls-connect._tcp')).toBe('wifi');
    expect(connectionForSerial('R58M123ABC')).toBe('usb');
  });

  it('returns nothing for an empty list', () => {
    expect(parseAdbDevices('List of devices attached\n\n')).toEqual([]);
  });
});

describe('device info', () => {
  it('parses getprop', () => {
    const props = parseGetprop(
      [
        '[ro.build.version.release]: [14]',
        '[ro.build.version.sdk]: [34]',
        '[ro.product.manufacturer]: [Google]',
        '[ro.product.model]: [Pixel 8]',
        '[ro.boot.qemu.avd_name]: [Pixel_8_API_34]',
        '[persist.sys.timezone]: [Europe/Istanbul]',
        '[empty.prop]: []',
      ].join('\n'),
    );
    expect(props['ro.product.model']).toBe('Pixel 8');
    expect(props['ro.build.version.sdk']).toBe('34');
    expect(props['empty.prop']).toBe('');
  });

  it('parses wm size/density (override wins, density as a scale factor)', () => {
    expect(parseWmOutput('Physical size: 1080x2400\nPhysical density: 420\n')).toEqual({
      width: 1080,
      height: 2400,
      density: 2.625,
    });
    expect(
      parseWmOutput('Physical size: 1440x3120\nOverride size: 1080x2340\nPhysical density: 560\nOverride density: 420\n'),
    ).toEqual({ width: 1080, height: 2340, density: 2.625 });
    expect(parseWmOutput('Error: no window manager')).toBeUndefined();
  });

  it('parses dumpsys battery', () => {
    const text = [
      'Current Battery Service state:',
      '  AC powered: false',
      '  USB powered: true',
      '  Wireless powered: false',
      '  Max charging current: 500000',
      '  status: 2',
      '  health: 2',
      '  present: true',
      '  level: 85',
      '  scale: 100',
      '  voltage: 4237',
      '  temperature: 280',
      '  technology: Li-ion',
    ].join('\n');
    expect(parseBattery(text)).toEqual({ level: 85, charging: true });
    expect(parseBattery(text.replace('status: 2', 'status: 3').replace('USB powered: true', 'USB powered: false'))).toEqual({
      level: 85,
      charging: false,
    });
    expect(parseBattery(text.replace('status: 2', 'status: 5'))).toEqual({ level: 85, charging: true });
    expect(parseBattery('nothing')).toBeUndefined();
  });
});

describe('processes', () => {
  it('parses toybox `ps -A -o PID,NAME`', () => {
    const map = parsePs(
      [
        '  PID NAME',
        '    1 init',
        '    2 [kthreadd]',
        '  612 system_server',
        '  700 /system/bin/surfaceflinger',
        ' 4321 com.mykynk.pati',
        ' 4400 com.google.android.gms:persistent',
      ].join('\n'),
    );
    expect(map.get(1)).toBe('init');
    expect(map.get(2)).toBe('[kthreadd]');
    expect(map.get(700)).toBe('surfaceflinger');
    expect(map.get(4321)).toBe('com.mykynk.pati');
    expect(map.get(4400)).toBe('com.google.android.gms:persistent');
  });

  it('parses legacy toolbox ps', () => {
    const map = parsePs(
      [
        'USER     PID   PPID  VSIZE  RSS     WCHAN    PC         NAME',
        'root      1     0     8904   788   ffffffff 00000000 S /init',
        'u0_a61    1234  187   1525492 54460 ffffffff 00000000 S com.example.app',
      ].join('\n'),
    );
    expect(map.get(1)).toBe('init');
    expect(map.get(1234)).toBe('com.example.app');
  });

  it('parses pidof', () => {
    expect(parsePidof('4321\n')).toBe(4321);
    expect(parsePidof('4321 4400\n')).toBe(4321);
    expect(parsePidof('')).toBeUndefined();
  });

  it('parses /proc/<pid>/stat with odd comm values and computes CPU %', () => {
    const stat =
      '4321 (com.example (x) app) S 612 612 0 0 -1 1077952832 92536 0 1 0 1530 412 0 0 10 -10 57 0 4021 15692783616 32460 18446744073709551615 1 1 0 0 0 0 4612 1 1073775864 0 0 0 17 6 0 0 0 0 0';
    expect(parseProcStat(stat)).toEqual({ cpuTicks: 1942, threads: 57 });
    expect(parseProcStat('cat: /proc/1/stat: No such file or directory')).toBeUndefined();
    expect(parseVmRssMB('Name:\tx\nThreads:\t57\nVmRSS:\t  245760 kB\n')).toBe(240);
    expect(cpuPercent(1000, 1100, 2000)).toBe(50);
    expect(cpuPercent(1000, 1500, 2000)).toBe(250);
    expect(cpuPercent(1000, 900, 2000)).toBeUndefined();
  });
});

describe('reverse / forward / packages', () => {
  it('parses reverse and forward lists', () => {
    expect(
      parsePortMappings('UsbFfs tcp:9751 tcp:53123\nUsbFfs tcp:9750 tcp:9750\nemulator-5554 tcp:51000 localabstract:foo\n'),
    ).toEqual([
      { local: 'tcp:9751', remote: 'tcp:53123' },
      { local: 'tcp:9750', remote: 'tcp:9750' },
      { local: 'tcp:51000', remote: 'localabstract:foo' },
    ]);
    expect(parseForwardPort('53124\n')).toBe(53124);
    expect(parseForwardPort('')).toBeUndefined();
  });

  it('parses pm list packages', () => {
    expect(parsePackageList('package:com.a\npackage:com.b.c\n\npackage:/data/app/x/base.apk=com.d\n')).toEqual([
      'com.a',
      'com.b.c',
      'com.d',
    ]);
  });

  it('parses filtered dumpsys package output', () => {
    const meta = parsePackageDump(
      [
        '  Package [com.mykynk.pati] (1a2b3c):',
        '    versionName=1.4.2',
        '    flags=[ DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP ]',
        '  Package [com.android.chrome] (4d5e6f):',
        '    versionName=129.0.6668.100',
        '    pkgFlags=[ SYSTEM HAS_CODE ALLOW_CLEAR_USER_DATA ]',
        '  Package [com.android.chrome] (998877):',
        '    versionName=120.0.0.1',
        '    pkgFlags=[ SYSTEM DEBUGGABLE ]',
      ].join('\n'),
    );
    expect(meta.get('com.mykynk.pati')).toEqual({ version: '1.4.2', debuggable: true });
    expect(meta.get('com.android.chrome')).toEqual({ version: '129.0.6668.100', debuggable: false });
  });
});
