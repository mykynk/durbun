import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { FlowDoc, FlowPreflight } from '@durbun/protocol';
import '../../../i18n';
import '../i18n';
import { setLanguage } from '../../../i18n/core';
import { PreflightDetails } from './RunControls';

afterEach(() => {
  cleanup();
  setLanguage('en');
});

const flow: FlowDoc = {
  format: 'durbun-flow',
  version: 1,
  id: 'all',
  name: 'All',
  nodes: [{ id: 'start', type: 'trigger.manual' }],
  edges: [],
};

describe('PreflightDetails', () => {
  it('shows the same problem on many steps as one line naming the first few', () => {
    const device = ['record', 'shot', 'launch', 'tap', 'clear'].map((nodeId) => ({ level: 'warn' as const, code: 'preflight.device.missing', message: 'needs a device', nodeId, flowId: 'device' }));
    const preflight: FlowPreflight = {
      ok: true,
      issues: [...device, { level: 'warn', code: 'preflight.env.missing', message: 'missing', params: { key: 'token' } }],
      irreversible: [],
      skipped: [],
    };
    const { container } = render(<PreflightDetails preflight={preflight} flow={flow} />);
    const items = container.querySelectorAll('.fl-preflight__item');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('This step needs a connected device');
    const where = items[0]!.querySelector('.fl-preflight__where')!;
    expect(where.textContent).toBe('device › record, device › shot, device › launch and 2 more steps');
    expect(where.getAttribute('title')).toContain('device › clear');
  });
});
