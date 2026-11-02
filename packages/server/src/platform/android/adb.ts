/** Thin wrapper around the resolved adb binary (argv only, no shell on the desktop side). */
import { run, runBuffer, type RunOptions, type RunResult } from '../exec';
import type { ResolvedTool } from '../tools';
import { parseForwardPort, parsePortMappings, type PortMapping } from './parsers';

export class Adb {
  constructor(readonly tool: ResolvedTool) {}

  get path(): string {
    return this.tool.path;
  }

  private opts(opts?: RunOptions): RunOptions {
    return { ...opts, env: { ...this.tool.env, ...opts?.env } };
  }

  run(args: string[], opts?: RunOptions): Promise<RunResult<string>> {
    return run(this.tool.path, args, this.opts(opts));
  }

  runBuffer(args: string[], opts?: RunOptions): Promise<RunResult<Buffer>> {
    return runBuffer(this.tool.path, args, this.opts(opts));
  }

  /** `adb -s S shell '<command>'` — `command` is interpreted by the device's /system/bin/sh. */
  shell(serial: string, command: string, opts?: RunOptions): Promise<RunResult<string>> {
    return this.run(['-s', serial, 'shell', command], { timeoutMs: 20_000, ...opts });
  }

  async version(): Promise<string | undefined> {
    const r = await this.run(['version'], { timeoutMs: 10_000 });
    if (!r.ok) return undefined;
    const v = /Android Debug Bridge version ([\d.]+)/.exec(r.stdout)?.[1];
    const build = /^Version (\S+)/m.exec(r.stdout)?.[1];
    if (!v) return undefined;
    return build ? `${v} (${build})` : v;
  }

  startServer(): Promise<RunResult<string>> {
    return this.run(['start-server'], { timeoutMs: 30_000 });
  }

  devices(): Promise<RunResult<string>> {
    return this.run(['devices', '-l'], { timeoutMs: 15_000 });
  }

  async getState(serial: string): Promise<string | undefined> {
    const r = await this.run(['-s', serial, 'get-state'], { timeoutMs: 5000 });
    return r.ok ? r.stdout.trim() : undefined;
  }

  async reverseList(serial: string): Promise<PortMapping[] | undefined> {
    const r = await this.run(['-s', serial, 'reverse', '--list'], { timeoutMs: 8000 });
    return r.ok ? parsePortMappings(r.stdout) : undefined;
  }

  reverse(serial: string, devicePort: number, hostPort: number): Promise<RunResult<string>> {
    return this.run(['-s', serial, 'reverse', `tcp:${devicePort}`, `tcp:${hostPort}`], { timeoutMs: 8000 });
  }

  reverseRemove(serial: string, devicePort: number): Promise<RunResult<string>> {
    return this.run(['-s', serial, 'reverse', '--remove', `tcp:${devicePort}`], { timeoutMs: 5000 });
  }

  /** `adb forward tcp:0 tcp:<devicePort>` → allocated local port. */
  async forward(serial: string, devicePort: number): Promise<{ port?: number; error?: string }> {
    const r = await this.run(['-s', serial, 'forward', 'tcp:0', `tcp:${devicePort}`], { timeoutMs: 8000 });
    if (!r.ok) return { error: r.error ?? (r.stderr.trim() || `adb forward failed (exit ${r.code})`) };
    const port = parseForwardPort(r.stdout);
    if (port) return { port };
    // Older adb prints nothing for tcp:0; look the mapping up.
    const list = await this.run(['-s', serial, 'forward', '--list'], { timeoutMs: 5000 });
    const mapping = parsePortMappings(list.stdout)
      .reverse()
      .find((m) => m.remote === `tcp:${devicePort}` && m.local.startsWith('tcp:'));
    const p = mapping ? Number(mapping.local.slice(4)) : NaN;
    return Number.isInteger(p) && p > 0 ? { port: p } : { error: 'adb forward did not report a port' };
  }

  forwardRemove(serial: string, localPort: number): Promise<RunResult<string>> {
    return this.run(['-s', serial, 'forward', '--remove', `tcp:${localPort}`], { timeoutMs: 5000 });
  }
}
