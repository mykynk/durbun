import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JavaScript build script without type declarations
import { dmgFollowUp, releaseGate, runVerification, signingState, verificationSteps } from '../scripts/releaseSigning.mjs';

const API_KEY = { APPLE_API_KEY: '/keys/AuthKey.p8', APPLE_API_KEY_ID: 'KEYID', APPLE_API_ISSUER: 'issuer-uuid' };
const APPLE_ID = { APPLE_ID: 'dev@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'app-pw', APPLE_TEAM_ID: 'TEAM123' };
const SIGNED = { CSC_NAME: 'Jane Doe (TEAM123)' };

describe('signingState (same rules as electron-builder.config.cjs)', () => {
  it('needs an identity and one complete notarization set', () => {
    expect(signingState({})).toMatchObject({ signed: false, notarize: false, missing: ['CSC_NAME (or CSC_LINK)', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'] });
    expect(signingState({ ...SIGNED, ...API_KEY })).toMatchObject({ signed: true, notarize: true, missing: [] });
    expect(signingState({ CSC_LINK: '/certs/id.p12', ...APPLE_ID })).toMatchObject({ signed: true, notarize: true, missing: [] });
  });

  it('notarization alone does not sign (electron-builder only notarizes signed apps)', () => {
    expect(signingState(API_KEY)).toMatchObject({ signed: false, notarize: false, missing: ['CSC_NAME (or CSC_LINK)'] });
  });

  it('names the missing variables of the set being filled in; blank values count as missing', () => {
    expect(signingState({ ...SIGNED, APPLE_ID: 'dev@example.com', APPLE_TEAM_ID: 'TEAM123' }).missing).toEqual(['APPLE_APP_SPECIFIC_PASSWORD']);
    expect(signingState({ ...SIGNED, ...API_KEY, APPLE_API_ISSUER: '  ' }).missing).toEqual(['APPLE_API_ISSUER']);
    expect(signingState({ CSC_NAME: '', ...API_KEY }).signed).toBe(false);
  });
});

describe('releaseGate', () => {
  it('stops before building and lists what is missing', () => {
    const gate = releaseGate({ ...SIGNED });
    expect(gate.proceed).toBe(false);
    const text = gate.lines.join('\n');
    expect(text).toContain('APPLE_API_KEY_ID');
    expect(text).toContain('APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID');
    expect(text).toContain('DURBUN_ALLOW_UNSIGNED=1');
  });

  it('proceeds when signed and notarized', () => {
    const gate = releaseGate({ ...SIGNED, ...API_KEY });
    expect(gate).toMatchObject({ proceed: true, signed: true, notarize: true });
    expect(gate.lines[0]).toContain('Jane Doe (TEAM123)');
  });

  it('builds ad-hoc only when asked to, with a warning', () => {
    for (const [env, argv] of [
      [{}, ['--release', '--allow-unsigned']],
      [{ DURBUN_ALLOW_UNSIGNED: '1' }, []],
      [{ DURBUN_ALLOW_UNSIGNED: 'true' }, []],
    ] as const) {
      const gate = releaseGate(env, [...argv]);
      expect(gate.proceed).toBe(true);
      expect(gate.lines.join('\n')).toContain('Do not publish');
    }
    expect(releaseGate({ DURBUN_ALLOW_UNSIGNED: '0' }).proceed).toBe(false);
    expect(releaseGate({ DURBUN_ALLOW_UNSIGNED: '' }).proceed).toBe(false);
  });
});

describe('verification after the build', () => {
  const apps = ['/r/mac-arm64/Dürbün.app', '/r/mac/Dürbün.app'];

  it('checks the signature, Gatekeeper and the stapled ticket of each notarized app', () => {
    const steps = verificationSteps(signingState({ ...SIGNED, ...API_KEY }), apps);
    expect(steps.map((s: { cmd: string; args: string[] }) => [s.cmd, ...s.args].join(' '))).toEqual([
      'codesign --verify --deep --strict --verbose=2 /r/mac-arm64/Dürbün.app',
      'spctl --assess --type execute -vv /r/mac-arm64/Dürbün.app',
      'xcrun stapler validate /r/mac-arm64/Dürbün.app',
      'codesign --verify --deep --strict --verbose=2 /r/mac/Dürbün.app',
      'spctl --assess --type execute -vv /r/mac/Dürbün.app',
      'xcrun stapler validate /r/mac/Dürbün.app',
    ]);
  });

  it('an allowed ad-hoc build only checks that its signature is intact', () => {
    const steps = verificationSteps(signingState({}), apps);
    expect(steps.map((s: { cmd: string }) => s.cmd)).toEqual(['codesign', 'codesign']);
  });

  it('reports the failing steps and keeps going', () => {
    const spawn = vi.fn((cmd: string) => ({ status: cmd === 'spctl' ? 3 : 0 }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const failed = runVerification(verificationSteps(signingState({ ...SIGNED, ...API_KEY }), apps.slice(0, 1)), spawn);
    log.mockRestore();
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(failed).toEqual(['Gatekeeper accepts /r/mac-arm64/Dürbün.app']);
    const throwing = () => {
      throw new Error('ENOENT');
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runVerification([{ label: 'x', cmd: 'missing', args: [] }], throwing)).toEqual(['x']);
    vi.restoreAllMocks();
  });

  it('lists the DMG steps with variable names (never secrets) and the checksums last', () => {
    const env = { ...SIGNED, ...API_KEY };
    const lines = dmgFollowUp(signingState(env), ['Durbun-1.0.0-arm64.dmg'], env);
    expect(lines).toEqual([
      'codesign --sign "Developer ID Application: $CSC_NAME" --timestamp Durbun-1.0.0-arm64.dmg',
      'xcrun notarytool submit Durbun-1.0.0-arm64.dmg --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait',
      'xcrun stapler staple Durbun-1.0.0-arm64.dmg',
      'spctl --assess --type open --context context:primary-signature -v Durbun-1.0.0-arm64.dmg',
      'xcrun stapler validate Durbun-1.0.0-arm64.dmg',
      'shasum -a 256 *.dmg *.zip durbun-update-mac-*.json > SHA256SUMS.txt',
    ]);
    expect(lines.join('\n')).not.toContain('/keys/AuthKey.p8');
    const appleId = { CSC_LINK: '/certs/id.p12', ...APPLE_ID };
    expect(dmgFollowUp(signingState(appleId), ['a.dmg'], appleId)[1]).toContain('--apple-id "$APPLE_ID"');
    expect(dmgFollowUp(signingState({}), ['a.dmg'], {})).toEqual([]);
  });
});
