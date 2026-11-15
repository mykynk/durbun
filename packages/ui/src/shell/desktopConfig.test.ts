import { describe, expect, it } from 'vitest';
import { isUserPort, parseConfigResult, parseConfigView } from './desktopConfig';

const field = <T>(value: T, extra: Record<string, unknown> = {}) => ({ value, source: 'default', saved: null, default: value, env: 'DURBUN_PORT', pending: false, ...extra });
const view = (extra: Record<string, unknown> = {}) => ({
  httpPort: field(9750),
  sdkPort: field(9751, { env: 'DURBUN_SDK_PORT' }),
  verboseLog: field(false, { env: 'DURBUN_VERBOSE' }),
  restartNeeded: false,
  listening: { httpPort: 9750, sdkPort: 9751 },
  ...extra,
});

describe('desktop config bridge', () => {
  it('reads the app’s ConfigView', () => {
    const v = parseConfigView(view());
    expect(v?.httpPort.value).toBe(9750);
    expect(v?.sdkPort.env).toBe('DURBUN_SDK_PORT');
    expect(v?.listening).toEqual({ httpPort: 9750, sdkPort: 9751 });
    expect(v?.restartNeeded).toBe(false);
  });

  it('needs a restart when a field is pending, even if the flag is missing', () => {
    const v = parseConfigView(view({ sdkPort: field(9761, { source: 'file', saved: 9761, default: 9751, pending: true }), restartNeeded: undefined }));
    expect(v?.restartNeeded).toBe(true);
    expect(v?.sdkPort.saved).toBe(9761);
  });

  it('rejects a reply of another shape (an older app)', () => {
    expect(parseConfigView({ httpPort: 9750 })).toBeUndefined();
    expect(parseConfigView(view({ verboseLog: field('yes') }))).toBeUndefined();
    expect(parseConfigView(null)).toBeUndefined();
  });

  it('reads set results, refusals with their field, and anything else as a bridge failure', () => {
    expect(parseConfigResult({ ok: true, config: view() }).ok).toBe(true);
    const refused = parseConfigResult({ ok: false, error: 'samePorts', field: 'sdkPort', config: view() });
    expect(refused).toMatchObject({ ok: false, error: 'samePorts', field: 'sdkPort' });
    expect(parseConfigResult(null)).toEqual({ ok: false, error: 'bridge' });
    expect(parseConfigResult({ ok: false, error: 'boom' })).toEqual({ ok: false, error: 'bridge' });
  });

  it('accepts the same ports as the app', () => {
    expect(isUserPort(1024)).toBe(true);
    expect(isUserPort(65_535)).toBe(true);
    expect(isUserPort(80)).toBe(false);
    expect(isUserPort(70_000)).toBe(false);
    expect(isUserPort(9750.5)).toBe(false);
  });
});
