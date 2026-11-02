import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fallbackPorts, isPortFree, parsePortEnv, planHttpPort, type PortDeps } from '../src/ports';

const deps = (running: Record<number, string>, busy: number[]): PortDeps => ({
  probe: async (p) => (running[p] ? { version: running[p]! } : undefined),
  isFree: async (p) => !busy.includes(p) && !running[p],
});

describe('planHttpPort', () => {
  it('starts on the preferred port when it is free', async () => {
    expect(await planHttpPort(9750, 9751, deps({}, []))).toEqual({ kind: 'start', port: 9750, fallback: false });
  });
  it('attaches to a Dürbün already answering on the port', async () => {
    expect(await planHttpPort(9750, 9751, deps({ 9750: '0.1.0' }, []))).toEqual({ kind: 'attach', port: 9750, version: '0.1.0' });
  });
  it('picks a stable nearby port when another program holds it', async () => {
    expect(await planHttpPort(9750, 9751, deps({}, [9750]))).toEqual({ kind: 'start', port: 9760, fallback: true });
    expect(await planHttpPort(9750, 9751, deps({}, [9750, 9760, 9770]))).toEqual({ kind: 'start', port: 9780, fallback: true });
  });
  it('falls back to an OS-assigned port at last', async () => {
    expect(await planHttpPort(9750, 9751, deps({}, [9750, 9760, 9770, 9780]))).toEqual({ kind: 'start', port: 0, fallback: true });
  });
  it('never proposes the SDK port', () => {
    expect(fallbackPorts(9741, 9751)).toEqual([9761, 9771, 0]);
  });
});

describe('parsePortEnv', () => {
  it('accepts 1–65535 and falls back otherwise', () => {
    expect(parsePortEnv('9800', 9750)).toBe(9800);
    expect(parsePortEnv(' 9801 ', 9751)).toBe(9801);
    expect(parsePortEnv(undefined, 9750)).toBe(9750);
    expect(parsePortEnv('0', 9750)).toBe(9750);
    expect(parsePortEnv('70000', 9750)).toBe(9750);
    expect(parsePortEnv('abc', 9750)).toBe(9750);
  });
});

describe('isPortFree', () => {
  let srv: net.Server | undefined;
  afterEach(() => new Promise<void>((r) => (srv ? srv.close(() => r()) : r())));
  it('detects a listening port', async () => {
    srv = net.createServer();
    const port = await new Promise<number>((r) => srv!.listen(0, '127.0.0.1', () => r((srv!.address() as net.AddressInfo).port)));
    expect(await isPortFree(port)).toBe(false);
    await new Promise<void>((r) => srv!.close(() => r()));
    srv = undefined;
    expect(await isPortFree(port)).toBe(true);
  });
});
