import { describe, expect, it } from 'vitest';
import { FLOW_NODE_SPECS, flowNodeSpec } from '@durbun/protocol';
import '../../../i18n';
import '../i18n';
import { nodeTitle } from './text';
import { rankSteps, stepSupport } from './picker';

describe('step picker search', () => {
  it('puts the step whose title matches before steps that only mention the word', () => {
    const tr = rankSteps(FLOW_NODE_SPECS, 'kontrol', 'tr').map((s) => nodeTitle(s.type, 'tr'));
    expect(tr[0]).toBe(nodeTitle('check.assert', 'tr'));
    const en = rankSteps(FLOW_NODE_SPECS, 'screenshot', 'en');
    expect(en[0]!.type).toBe('device.screenshot');
  });

  it('keeps the catalog order without a search', () => {
    expect(rankSteps(FLOW_NODE_SPECS, '', 'tr').length).toBe(FLOW_NODE_SPECS.length);
    expect(rankSteps(FLOW_NODE_SPECS, ' ', 'en')[0]!.group).toBe(rankSteps(FLOW_NODE_SPECS, '', 'en')[0]!.group);
  });

  it('finds nothing for a word no step has', () => {
    expect(rankSteps(FLOW_NODE_SPECS, 'zzqx', 'en')).toEqual([]);
  });
});

describe('step support on the target', () => {
  const typeText = FLOW_NODE_SPECS.find((s) => s.needs?.deviceAction === 'input-text')!;
  const shot = FLOW_NODE_SPECS.find((s) => s.needs?.deviceAction === 'screenshot')!;
  it('marks an Android-only step on an iPhone and says where it runs', () => {
    const r = stepSupport(typeText, { platform: 'ios', kind: 'physical', name: 'iPhone' });
    expect(r.ok).toBe(false);
    expect(r.where).toEqual(['android']);
    expect(stepSupport(shot, { platform: 'ios', kind: 'physical', name: 'iPhone' }).ok).toBe(true);
  });
  it('never marks steps without a known target or without a device action', () => {
    expect(stepSupport(typeText, null).ok).toBe(true);
    expect(stepSupport(flowNodeSpec('http.request')!, { platform: 'ios', name: 'iOS' }).ok).toBe(true);
  });
});
