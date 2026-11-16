import { afterEach, describe, expect, it } from 'vitest';
import type { FlowRunStep } from '@durbun/protocol';
import { setLanguage } from '../../../i18n';
import { stepError } from './run';

afterEach(() => setLanguage('en'));

describe('step error text', () => {
  it('explains a setting the server refused because it would cut a Wi-Fi connection', () => {
    const step = {
      id: 3,
      nodeId: 'wifiOff',
      type: 'device.wifi',
      flowId: 'f',
      depth: 0,
      status: 'failed',
      startedAt: 0,
      error: 'Pixel 8 is connected to this Mac over Wi-Fi; this change would cut the connection',
      errorCode: 'action.wouldDisconnect',
      params: { connection: 'wifi' },
    } as FlowRunStep;
    setLanguage('tr');
    expect(stepError(step)).toMatch(/Wi-Fi üzerinden bağlı.*USB/);
    setLanguage('en');
    expect(stepError(step)).toMatch(/over Wi-Fi.*USB/);
  });
});
