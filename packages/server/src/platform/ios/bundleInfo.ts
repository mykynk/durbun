/** The bundle id of a .app on the Mac (its Info.plist, read with macOS's own plutil: binary or XML plists). */
import path from 'node:path';
import { run } from '../exec';
import { validAppId } from '../shared/files';

/** Tests: a fake plutil. */
export const BUNDLE_INFO = {
  plutil: (args: string[]) => run('/usr/bin/plutil', args, { timeoutMs: 10_000 }),
};

/** CFBundleIdentifier of a .app folder; undefined when it cannot be read. */
export async function appBundleId(appPath: string): Promise<string | undefined> {
  const r = await BUNDLE_INFO.plutil(['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(appPath, 'Info.plist')]).catch(() => undefined);
  const id = r?.ok ? r.stdout.trim() : undefined;
  return validAppId(id) ? id : undefined;
}

/**
 * The installed copy is in the way: a build signed for another team over it ("Upgrade's application-identifier
 * entitlement string does not match installed application's application-identifier string", installd's
 * MismatchedApplicationIdentifierEntitlement). Uninstalling it first lets the install go through.
 */
export function iosInstallRefusalCode(error: string): string | undefined {
  if (/MismatchedApplicationIdentifierEntitlement|application-identifier entitlement string does not match/i.test(error)) {
    return 'action.install.signatureMismatch';
  }
  return undefined;
}
