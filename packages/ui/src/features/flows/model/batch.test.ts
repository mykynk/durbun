import { afterEach, describe, expect, it } from 'vitest';
import type { FlowBatch, FlowBatchItem } from '@durbun/protocol';
import { setLanguage, t } from '../../../i18n';
import '../i18n';
import { batchFileName, batchHeadline, batchReport, batchTitle, batchTone, finishedRunIds, flowsWithTag, itemDetail, itemStatusKey, tagCounts } from './batch';
import { changesText, replacedByKey } from './versions';

afterEach(() => setLanguage('en'));

const T = (k: string, p?: Record<string, string | number>) => t(k, p);

const item = (flowName: string, status: FlowBatchItem['status'], patch: Partial<FlowBatchItem> = {}): FlowBatchItem => ({ flowId: flowName.toLowerCase(), flowName, status, ...patch });

function batch(items: FlowBatchItem[], patch: Partial<FlowBatch> = {}): FlowBatch {
  const counts = { passed: 0, failed: 0, skipped: 0, cancelled: 0, total: items.length };
  for (const i of items) if (i.status === 'passed' || i.status === 'failed' || i.status === 'skipped' || i.status === 'cancelled') counts[i.status]++;
  const running = items.some((i) => i.status === 'running' || i.status === 'pending');
  return {
    id: 'b1',
    tag: 'smoke',
    status: running ? 'running' : counts.failed ? 'failed' : 'passed',
    startedAt: new Date(2026, 10, 16, 14, 30).getTime(),
    ...(running ? {} : { durationMs: 65_000 }),
    request: {},
    onFailure: 'continue',
    items,
    counts,
    ...patch,
  };
}

describe('tags', () => {
  it('counts flows per tag (case does not matter, the first spelling wins), most used first', () => {
    const flows = [{ tags: ['smoke', 'Login'] }, { tags: ['Smoke'] }, { tags: ['nightly', 'smoke', 'smoke'] }, {}];
    expect(tagCounts(flows)).toEqual([
      { tag: 'smoke', count: 3 },
      { tag: 'Login', count: 1 },
      { tag: 'nightly', count: 1 },
    ]);
  });

  it('picks the flows of a tag in the order the server runs them (by name)', () => {
    const flows = [
      { id: 'c', name: 'Checkout', tags: ['smoke'] },
      { id: 'a', name: 'Add to cart', tags: ['SMOKE '] },
      { id: 'p', name: 'Profile', tags: ['nightly'] },
    ];
    expect(flowsWithTag(flows, 'Smoke').map((f) => f.id)).toEqual(['a', 'c']);
  });
});

describe('a set in words', () => {
  it('tells running, passed, failed, stopped and "passed but some did not run" apart', () => {
    expect(batchTone(batch([item('A', 'running')]))).toBe('running');
    expect(batchTone(batch([item('A', 'passed')]))).toBe('passed');
    expect(batchTone(batch([item('A', 'passed'), item('B', 'skipped')]))).toBe('partial');
    expect(batchTone(batch([item('A', 'failed')]))).toBe('failed');
    expect(batchTone(batch([item('A', 'cancelled')], { status: 'cancelled' }))).toBe('cancelled');
  });

  it('heads the result with what matters most', () => {
    expect(batchTitle(batch([item('A', 'passed')]), T)).toBe('Flows tagged “smoke”');
    expect(batchTitle(batch([item('A', 'passed'), item('B', 'passed')], { tag: undefined }), T)).toBe('2 picked flows');
    expect(batchHeadline(batch([item('A', 'passed'), item('B', 'running'), item('C', 'pending')]), T)).toBe('1 of 3 flows done');
    expect(batchHeadline(batch([item('A', 'passed'), item('B', 'failed'), item('C', 'failed')]), T)).toBe('2 of 3 flows failed');
    expect(batchHeadline(batch([item('A', 'passed'), item('B', 'skipped')]), T)).toBe('1 passed, 1 did not run');
    expect(batchHeadline(batch([item('A', 'passed'), item('B', 'passed')]), T)).toBe('All 2 flows passed');
    expect(batchHeadline(batch([item('A', 'passed'), item('B', 'cancelled', { runId: 'r' }), item('C', 'cancelled')], { status: 'cancelled' }), T)).toBe('Stopped after 1 of 3 flows');
    setLanguage('tr');
    expect(batchHeadline(batch([item('A', 'passed'), item('B', 'failed')]), T)).toBe('2 akıştan 1 tanesi başarısız');
  });

  it('says "Stopped" for a flow cut off mid-run and "Not run" for one never started', () => {
    expect(t(itemStatusKey(item('A', 'cancelled', { runId: 'r' })))).toBe('Stopped');
    expect(t(itemStatusKey(item('A', 'cancelled')))).toBe('Not run');
    expect(t(itemStatusKey(item('A', 'pending')))).toBe('Waiting');
  });

  it('names the failing step and words the reason from its code', () => {
    const failed = item('Login', 'failed', {
      runId: 'r1',
      failedStep: { nodeId: 'call', type: 'http.request', label: 'Sign in', flowId: 'login', error: 'Expected 2xx, got 500', errorCode: 'flow.http.status', params: { method: 'POST', url: '/login', status: 500, expected: '2xx' } },
    });
    const d = itemDetail(failed, 'en');
    expect(d.step).toBe('Sign in');
    expect(d.text).toMatch(/500/);
    expect(d.text).not.toBe('Expected 2xx, got 500');
    const skipped = item('Wipe', 'skipped', { reason: { code: 'flow.batch.irreversible', message: 'Not run: hard to undo (Clear data)', params: { steps: 'Clear data' } } });
    expect(itemDetail(skipped, 'tr').text).toBe('Geri alınması zor adımları olduğu için çalışmadı: Clear data');
  });
});

describe('the set report', () => {
  it('lists every flow with its result, the failing step and why the others did not run', () => {
    const b = batch(
      [
        item('Add to cart', 'passed', { runId: 'r1', durationMs: 1500, counts: { passed: 3, failed: 0, skipped: 0, total: 3 } }),
        item('Login', 'failed', {
          runId: 'r2',
          durationMs: 800,
          counts: { passed: 1, failed: 1, skipped: 0, total: 2 },
          failedStep: { nodeId: 'call', type: 'http.request', label: 'Sign in', flowId: 'login', error: 'boom', errorCode: 'flow.http.status', params: { method: 'POST', url: '/login', status: 500, expected: '2xx' } },
        }),
        item('Screenshot', 'skipped', { reason: { code: 'flow.batch.afterFailure', message: 'Not run: Login failed first', params: { flow: 'Login' } } }),
      ],
      { onFailure: 'stop', target: { deviceId: 'android:A1', deviceName: 'Pixel 8', platform: 'android', osVersion: '15' }, environment: { id: 's', name: 'Staging' } },
    );
    const text = batchReport(b, { t: T, lang: 'en' });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Flows tagged “smoke” → 1 of 3 flows failed');
    expect(lines[1]).toMatch(/^1 passed · 1 failed · 1 skipped · /);
    expect(text).toContain('- Device: Pixel 8 · Android 15');
    expect(text).toContain('- Environment: Staging');
    expect(text).toContain('- Stops at the first failed flow');
    expect(text).toContain('1. Passed · Add to cart · 3/3 steps passed (1.50 s)');
    expect(text).toMatch(/2\. Failed · Login · 1\/2 steps passed \(800 ms\)\n {3}Failed at “Sign in” — .*500/);
    expect(text).toContain('3. Skipped · Screenshot\n   Not run: “Login” failed first');
  });

  it('shares only the runs that ended, and names the file after the tag and the time', () => {
    const b = batch([item('A', 'passed', { runId: 'r1' }), item('B', 'skipped'), item('C', 'cancelled', { runId: 'r3' }), item('D', 'running', { runId: 'r4' })]);
    expect(finishedRunIds(b)).toEqual(['r1', 'r3']);
    expect(batchFileName({ tag: 'Smoke Tests!', startedAt: b.startedAt })).toBe('smoke-tests-set-2026-11-16_14-30.md');
    expect(batchFileName({ startedAt: b.startedAt })).toBe('flows-set-2026-11-16_14-30.md');
  });
});

describe('versions in words', () => {
  it('says what a save changed, and stays quiet about moves when more happened', () => {
    expect(changesText({ stepsAdded: 2, stepsRemoved: 0, stepsChanged: 1, stepsMoved: 4, connections: 0, settings: false, renamedFrom: 'Old login' }, T)).toBe(
      'renamed from “Old login” · 2 steps added · 1 step changed',
    );
    expect(changesText({ stepsAdded: 0, stepsRemoved: 0, stepsChanged: 0, stepsMoved: 3, connections: 0, settings: false }, T)).toBe('3 steps moved');
    expect(changesText({ stepsAdded: 0, stepsRemoved: 1, stepsChanged: 0, stepsMoved: 0, connections: 2, settings: true }, T)).toBe('1 step removed · 2 connections changed · settings changed');
    expect(changesText(undefined, T)).toBe('');
    expect(replacedByKey('edit')).toBeNull();
    expect(t(replacedByKey('restore')!)).toBe('before a restore');
  });
});
