import { afterEach, describe, expect, it } from 'vitest';
import type { FlowRun, FlowRunStep } from '@durbun/protocol';
import { setLanguage, t } from '../../../i18n';
import '../i18n';
import { lastOutputs, lastSteps, reportFileName, runOverlay, runReport, statusKey } from './run';

afterEach(() => setLanguage('en'));

let seq = 0;
const step = (nodeId: string, patch: Partial<FlowRunStep> = {}): FlowRunStep => ({ id: ++seq, nodeId, type: 'http.request', flowId: 'login', depth: 0, status: 'passed', startedAt: 0, ...patch });

function run(steps: FlowRunStep[], patch: Partial<FlowRun> = {}): FlowRun {
  return {
    id: 'r1',
    flowId: 'login',
    flowName: 'Login',
    status: 'failed',
    startedAt: new Date(2026, 10, 16, 9, 5).getTime(),
    durationMs: 2400,
    trigger: { kind: 'manual' },
    counts: { passed: 1, failed: 1, skipped: 0, total: 2 },
    steps,
    ...patch,
  } as FlowRun;
}

describe('the canvas overlay', () => {
  it('shows each node of the started flow with its last status and how often it ran', () => {
    const r = run([
      step('poll', { status: 'failed', handled: true }),
      step('poll', { status: 'passed', output: { status: 200 } }),
      step('inner', { flowId: 'helper', depth: 1, status: 'failed' }),
      step('shot', { type: 'device.screenshot', status: 'skipped', unsupported: 'preflight.device.none' }),
    ]);
    const o = runOverlay(r);
    expect(o.get('poll')).toEqual({ status: 'passed', count: 2, handled: undefined, unsupported: false });
    expect(o.get('shot')).toMatchObject({ status: 'skipped', unsupported: true });
    // Sub-flow steps belong to another canvas.
    expect(o.has('inner')).toBe(false);
    expect(runOverlay(undefined).size).toBe(0);
  });

  it('keeps the latest step and its output per node for the inspector and template hints', () => {
    const r = run([step('poll', { output: { status: 500 } }), step('poll', { output: { status: 200 } }), step('note', { type: 'output.note' })]);
    expect(lastSteps(r).get('poll')!.output).toEqual({ status: 200 });
    expect(lastOutputs(r)).toEqual({ poll: { status: 200 } });
  });
});

describe('the run report', () => {
  it('says what ran, where, and why it failed, in the chosen language', () => {
    const r = run(
      [
        step('start', { type: 'trigger.manual', durationMs: 1 }),
        step('login', {
          status: 'failed',
          label: 'Sign in',
          durationMs: 1200,
          error: 'Expected status 200, got 500 (POST /login)',
          errorCode: 'flow.http.status',
          params: { method: 'POST', url: '/login', status: 500, expected: '200', duration: '1.2 s' },
        }),
      ],
      {
        target: { deviceId: 'android:A1', deviceName: 'Pixel 8', platform: 'android', osVersion: '15', appId: 'com.example.app', appName: 'Example' },
        environment: { id: 'staging', name: 'Staging' },
        inputs: { user: 'qa@example.test' },
        error: 'Expected status 200, got 500 (POST /login)',
        errorCode: 'flow.http.status',
        errorParams: { method: 'POST', url: '/login', status: 500, expected: '200', duration: '1.2 s' },
      },
    );
    const text = runReport(r, { t: (k, p) => t(k, p), lang: 'en' });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Flow: Login → Failed');
    expect(lines[1]).toMatch(/^1\/2 steps passed · 1 failed · 2\.40 s$/);
    expect(text).toContain('- Device: Pixel 8 · Android 15');
    expect(text).toContain('- App: Example (com.example.app)');
    expect(text).toContain('- Environment: Staging');
    expect(text).toContain('- Inputs: user=qa@example.test');
    // The failing step by its label and id, worded from its code (not the English server text), with its time.
    expect(text).toMatch(/2\. Failed · Sign in \[login\] — .*500.*\(1\.20 s\)/);
    expect(text).toContain('Why:');

    setLanguage('tr');
    const tr = runReport(r, { t: (k, p) => t(k, p), lang: 'tr' });
    expect(tr.split('\n')[0]).toBe('Akış: Login → Başarısız');
    expect(tr).toContain('- Ortam: Staging');
    // Worded from the code in Turkish, never the server's English text.
    expect(tr).toMatch(/Durum kodu 500 geldi, 200 bekleniyordu/);
    expect(tr).not.toContain('Expected status');
  });

  it('leaves out what a run did not have, and names the file after the flow and the start time', () => {
    const r = run([step('start', { type: 'trigger.manual' })], { status: 'passed', counts: { passed: 1, failed: 0, skipped: 0, total: 1 } });
    const text = runReport(r, { t: (k, p) => t(k, p), lang: 'en' });
    expect(text).not.toMatch(/Device|Environment|Inputs|Why/);
    expect(text).toContain('- Started by: Manual');
    expect(reportFileName(r)).toBe('login-2026-11-16_09-05.md');
  });

  it('words a handled failure apart from a real one', () => {
    expect(statusKey('failed', true)).toBe('flows.status.handled');
    expect(statusKey('failed')).toBe('flows.status.failed');
  });
});
