/**
 * Wireless debugging parsers and adb calls. Every adb line here comes from fixtures/android-adb-wireless.txt and
 * fixtures/android-adb-mdns-services.txt, which are NOT captured from a device (written from adb's sources; see
 * their headers).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../../src/platform/exec';
import {
  AdbWireless,
  parseConnectOutput,
  parseMdnsServices,
  parsePairOutput,
  splitHostPort,
  validWirelessHost,
  wirelessAddress,
} from '../../src/platform/android/wireless';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const res = (stdout: string, stderr = '', ok = true, timedOut = false): RunResult<string> => ({ ok, code: ok ? 0 : 1, signal: null, timedOut, stdout, stderr });

describe('pair / connect output (fixtures NOT from a device)', () => {
  it('every fixture line maps to its code', () => {
    const lines = fixture('android-adb-wireless.txt')
      .split('\n')
      .filter((l) => l && !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(12);
    for (const line of lines) {
      const [cmd, code, text = ''] = line.split('\t');
      const parsed = cmd === 'pair' ? parsePairOutput(text) : parseConnectOutput(text);
      expect([cmd, text, parsed.code]).toEqual([cmd, text, code]);
    }
  });

  it('keeps what it needs: the guid, the serial, the raw text for unknown failures', () => {
    expect(parsePairOutput('Successfully paired to 192.168.1.20:37099 [guid=adb-R5CT20XK9QM-x7Kp2a]\n')).toMatchObject({ ok: true, guid: 'adb-R5CT20XK9QM-x7Kp2a' });
    expect(parseConnectOutput('already connected to 192.168.1.20:41235\n')).toMatchObject({ ok: true, serial: '192.168.1.20:41235' });
    expect(parseConnectOutput('unexpected reply').params).toEqual({ detail: 'unexpected reply' });
    expect(parsePairOutput('')).toMatchObject({ ok: false, code: 'adb.wireless.failed', params: { detail: 'no output' } });
  });
});

describe('mdns services (fixture NOT from a real network)', () => {
  it('pairing and connect services, duplicates and other services dropped, IPv6 kept', () => {
    expect(parseMdnsServices(fixture('android-adb-mdns-services.txt'))).toEqual([
      { name: 'adb-R5CT20XK9QM-x7Kp2a', kind: 'connect', host: '192.168.1.20', port: 41235, serial: 'R5CT20XK9QM' },
      { name: 'adb-R5CT20XK9QM-x7Kp2a', kind: 'pairing', host: '192.168.1.20', port: 37099, serial: 'R5CT20XK9QM' },
      { name: 'adb-RF8N30ABCD-Qw3rTy', kind: 'connect', host: '192.168.1.31', port: 39573, serial: 'RF8N30ABCD' },
      { name: 'adb-V6-AbCdEf', kind: 'connect', host: 'fe80::1c2b:3aff:fe4d:5e6f', port: 40001, serial: 'V6' },
    ]);
    expect(parseMdnsServices('List of discovered mdns services\n')).toEqual([]);
  });

  it('addresses', () => {
    expect(splitHostPort('192.168.1.20:37099')).toEqual({ host: '192.168.1.20', port: 37099 });
    expect(splitHostPort('[fe80::1]:5555')).toEqual({ host: 'fe80::1', port: 5555 });
    expect(splitHostPort('192.168.1.20')).toBeUndefined();
    expect(splitHostPort('192.168.1.20:70000')).toBeUndefined();
    expect(wirelessAddress('fe80::1', 5555)).toBe('[fe80::1]:5555');
    for (const ok of ['192.168.1.20', 'fe80::1', 'pixel.local', 'phone']) expect([ok, validWirelessHost(ok)]).toEqual([ok, true]);
    for (const bad of ['-k', '999.1.1.1', '', 'a b', 'host;rm', '$(x)', 'x'.repeat(300), 42]) expect([bad, validWirelessHost(bad)]).toEqual([bad, false]);
  });
});

describe('AdbWireless', () => {
  it('runs adb pair / connect / mdns services with the address as one argument', async () => {
    const calls: string[][] = [];
    const replies: Record<string, RunResult<string>> = {
      pair: res('Successfully paired to [fe80::1]:37099 [guid=adb-X-AbCdEf]\n'),
      connect: res('', 'failed to connect to \'192.168.1.20:41235\': Connection refused\n', false),
      mdns: res('List of discovered mdns services\nadb-X-AbCdEf\t_adb-tls-connect._tcp\t192.168.1.20:41235\n'),
    };
    const w = new AdbWireless({ run: async (args: string[], _o?: RunOptions) => (calls.push(args), replies[args[0]!]!) });
    expect(await w.pair('fe80::1', 37099, '123456')).toMatchObject({ ok: true, code: 'adb.wireless.paired' });
    expect(await w.connect('192.168.1.20', 41235)).toMatchObject({ ok: false, code: 'adb.wireless.refused' });
    expect(await w.discover()).toEqual({ ok: true, services: [{ name: 'adb-X-AbCdEf', kind: 'connect', host: '192.168.1.20', port: 41235, serial: 'X' }] });
    expect(calls).toEqual([
      ['pair', '[fe80::1]:37099', '123456'],
      ['connect', '192.168.1.20:41235'],
      ['mdns', 'services'],
    ]);
  });

  it('a timeout, and an adb that cannot list mdns services', async () => {
    const w = new AdbWireless({ run: async (args: string[]) => (args[0] === 'pair' ? res('', '', false, true) : res('', 'ERROR: mdns daemon unavailable\n', false)) });
    expect(await w.pair('192.168.1.20', 37099, '123456')).toMatchObject({ ok: false, code: 'adb.wireless.timeout' });
    expect(await w.discover()).toEqual({ ok: false, services: [], detail: 'ERROR: mdns daemon unavailable' });
  });
});
