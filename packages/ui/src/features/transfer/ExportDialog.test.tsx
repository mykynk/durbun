import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FlowRunHeader, FlowSummary, PackageExportRequest } from '@durbun/protocol';
import '../../i18n';
import { setLanguage } from '../../i18n/core';
import { useFlows } from '../../data';
import { ExportDialog } from './ExportDialog';

const summary = (id: string, name: string, calls: string[] = []): FlowSummary => ({ id, name, nodeCount: 3, triggers: ['manual'], automation: false, calls, issues: { errors: 0, warnings: 0 } });
const header = (id: string, flowId: string, status: FlowRunHeader['status'] = 'passed'): FlowRunHeader =>
  ({ id, flowId, flowName: flowId, status, startedAt: 1, trigger: { kind: 'manual' }, counts: { passed: 1, failed: 0, skipped: 0 }, stepCount: 1 }) as unknown as FlowRunHeader;

let sent: PackageExportRequest[] = [];

beforeEach(() => {
  setLanguage('en');
  sent = [];
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/flow-runs')) {
      return new Response(JSON.stringify({ running: [], runs: [header('r-cart', 'cart'), header('r-otp', 'otp', 'failed'), header('r-admin', 'admin')] }));
    }
    if (url === '/api/flow-environments') return new Response(JSON.stringify({ format: 'durbun-environments', version: 1, environments: [] }));
    if (url === '/api/packages/export') {
      sent.push(JSON.parse(String(init?.body)) as PackageExportRequest);
      return new Response('{}', { headers: { 'Content-Disposition': 'attachment; filename="Durbun-share.durbun"' } });
    }
    return new Response('{}', { status: 404 });
  });
  act(() => useFlows.setState({ summaries: [summary('cart', 'Sepet', ['login']), summary('login', 'Giriş', ['otp']), summary('otp', 'OTP'), summary('admin', 'Yönetici')] }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  act(() => useFlows.setState({ summaries: [] }));
});

describe('share package: run history', () => {
  it('sends only the runs of the picked flows and the sub-flows they call, by id, and says how many', async () => {
    render(<ExportDialog open mode="share" flows={['cart']} onClose={() => {}} />);
    // cart → login → otp travel together: their runs (r-cart, r-otp), never the admin flow's.
    await screen.findByText('2 runs · from 2 flows');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Run history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save the file' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.include?.runs).toEqual(['r-cart', 'r-otp']);
    expect(sent[0]!.include?.flows).toEqual(['cart']);
  });

  it('never sends `runs: true` from a share; a pick without runs cannot tick the box', async () => {
    render(<ExportDialog open mode="share" flows={['admin']} onClose={() => {}} />);
    await screen.findByText('1 run · from 1 flow');
    // Untick the flow: nothing to pack runs for.
    fireEvent.click(screen.getByRole('checkbox', { name: /Yönetici/ }));
    expect(screen.getByText('Pick flows first')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Run history' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('runs left unticked go out as `false`', async () => {
    render(<ExportDialog open mode="share" onClose={() => {}} />);
    await screen.findByText('3 runs · from 3 flows');
    fireEvent.click(screen.getByRole('button', { name: 'Save the file' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.include?.runs).toBe(false);
  });
});
