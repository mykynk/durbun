/**
 * Android users and profiles: a work profile (MDM), Samsung Secure Folder, Xiaomi Second Space, a second user.
 * Apps live per user, so `pm`, `am` and `adb install` take `--user <id>` for anything but the default one.
 *
 *   pm list users          Users:
 *                            UserInfo{0:Owner:c13} running
 *                            UserInfo{10:Work profile:1030} running
 *   (UserManagerService's shell command prints UserInfo.toString(): "UserInfo{<id>:<name>:<flags in hex>}",
 *   then " running" for a started user.)
 *   am get-current-user    0
 *
 * Flags (android.content.pm.UserInfo): PRIMARY 0x1, ADMIN 0x2, MANAGED_PROFILE 0x20, SYSTEM 0x800,
 * FULL 0x400, PROFILE 0x1000 (Android 11+), MAIN 0x4000 (Android 14+).
 */
import type { DeviceUser } from '@durbun/protocol';

const FLAG_PRIMARY = 0x1;
const FLAG_MANAGED_PROFILE = 0x20;
const FLAG_SYSTEM = 0x800;
const FLAG_PROFILE = 0x1000;
const FLAG_MAIN = 0x4000;

/** `pm list users` (+ `am get-current-user` as `current`) → users, sorted by id. */
export function parseUserList(text: string, current?: number): DeviceUser[] {
  const users: DeviceUser[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*UserInfo\{(\d+):(.*):([0-9a-fA-F]+)\}(\s+running)?\s*$/.exec(line);
    if (!m) continue;
    const id = Number(m[1]);
    const flags = parseInt(m[3]!, 16);
    if (!Number.isInteger(id) || id < 0 || id > 999_999 || !Number.isFinite(flags)) continue;
    const name = m[2]!.trim().slice(0, 80) || `User ${id}`;
    let kind: DeviceUser['kind'];
    if (flags & FLAG_MANAGED_PROFILE) kind = 'work';
    else if (flags & FLAG_PROFILE) kind = 'profile';
    else if (id === 0 || flags & (FLAG_PRIMARY | FLAG_MAIN | FLAG_SYSTEM)) kind = 'main';
    else kind = 'secondary';
    users.push({ id, name, kind, ...(m[4] ? { running: true } : {}), ...(current === id ? { current: true } : {}) });
  }
  return users.sort((a, b) => a.id - b.id);
}

/** `am get-current-user` → user id (undefined when not a number, e.g. an error text). */
export function parseCurrentUser(text: string): number | undefined {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return /^\d{1,6}$/.test(line) ? Number(line) : undefined;
}

/**
 * The `userId` param of an app action: undefined when absent, a number when it names a user of the phone,
 * 'invalid' otherwise (not an integer, or a user the phone does not have when its users are known).
 */
export function userParam(params: Record<string, unknown>, users: readonly DeviceUser[] | undefined): number | undefined | 'invalid' {
  const v = params.userId;
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,6}$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return 'invalid';
  if (users && users.length > 0 && !users.some((u) => u.id === n)) return 'invalid';
  return n;
}

/** " --user 10" for shell commands ('' for the default user). */
export function userFlag(userId: number | undefined): string {
  return userId === undefined ? '' : ` --user ${userId}`;
}

/** ['--user', '10'] for adb argv commands. */
export function userArgs(userId: number | undefined): string[] {
  return userId === undefined ? [] : ['--user', String(userId)];
}
