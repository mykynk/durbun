import { execFileSync } from 'node:child_process';
import os from 'node:os';

let cached: string | undefined;

/**
 * A readable name for this Mac ("Ayşe’s MacBook Pro") for backup files and their manifest. `os.hostname()` is
 * often the DHCP address on macOS, so the System Settings name comes first and an address never stands as a name.
 */
export function machineName(): string {
  if (cached !== undefined) return cached;
  let name = '';
  if (process.platform === 'darwin') {
    try {
      name = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // No scutil (or it timed out): fall back to the host name.
    }
  }
  if (!name) {
    const host = os.hostname().replace(/\.local$/, '');
    if (!/^[\d.:]+$/.test(host)) name = host;
  }
  return (cached = name.slice(0, 80) || 'Mac');
}
