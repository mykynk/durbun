/** "Compare requests": the general and header tables, swap, and every body state (same, different, binary, none, failed). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { NetworkDetail, NetworkEntry, WireBody } from '@durbun/protocol';
import { setLanguage } from '../../../i18n';
import { clearDetailCache } from '../detailCache';
import '../i18n';
import { CompareDialog } from './CompareDialog';

function entry(id: string, p: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    id,
    appId: 'app:1',
    deviceId: 'demo:1',
    source: 'dart:io',
    method: 'GET',
    url: `https://api.pati.app/v1/${id}`,
    host: 'api.pati.app',
    path: `/v1/${id}`,
    startTs: 1_700_000_000_000,
    state: 'complete',
    status: 200,
    duration: 120,
    requestHeaders: [['accept', 'application/json']],
    responseHeaders: [['content-type', 'application/json']],
    responseContentType: 'application/json',
    hasRequestBody: false,
    hasResponseBody: true,
    ...p,
  };
}

const json = (data: string): WireBody => ({ encoding: 'utf8', data, size: data.length });

/** GET /api/network/:id answers with the given bodies (or fails for ids in `failing`). */
function stubDetails(bodies: Record<string, Partial<NetworkDetail>>, failing: string[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const id = decodeURIComponent(url.split('/').pop()!);
      if (failing.includes(id)) return new Response(JSON.stringify({ error: 'gone', code: 'network.unknown' }), { status: 404 });
      return new Response(JSON.stringify({ ...entry(id), ...bodies[id] }), { status: 200 });
    }),
  );
}

beforeEach(() => {
  setLanguage('en');
  clearDetailCache();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

describe('CompareDialog', () => {
  it('general: differing fields are marked; Swap trades the sides', async () => {
    stubDetails({});
    render(<CompareDialog a={entry('a', { status: 200 })} b={entry('b', { status: 500, duration: 900 })} onClose={vi.fn()} />);
    tab('General');
    const table = screen.getByRole('table', { name: 'General' });
    const status = within(table).getByRole('row', { name: /Status/ });
    expect(status.className).toContain('is-changed');
    expect(within(status).getAllByRole('cell').map((c) => c.textContent)).toEqual(['200 OK', '500 Internal Server Error']);
    expect(within(table).getByRole('row', { name: /Source/ }).className).not.toContain('is-changed');
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    const swapped = within(screen.getByRole('table', { name: 'General' })).getByRole('row', { name: /Status/ });
    expect(within(swapped).getAllByRole('cell').map((c) => c.textContent)).toEqual(['500 Internal Server Error', '200 OK']);
  });

  it('headers: only the differences by default, a missing header said so', () => {
    stubDetails({});
    render(
      <CompareDialog
        a={entry('a', { requestHeaders: [['accept', 'application/json'], ['authorization', 'Bearer 1']] })}
        b={entry('b', { requestHeaders: [['accept', 'application/json']] })}
        onClose={vi.fn()}
      />,
    );
    tab('Headers');
    const req = screen.getByRole('table', { name: 'Request headers' });
    expect(within(req).getAllByRole('row')).toHaveLength(1);
    expect(within(req).getByRole('row').textContent).toContain('authorization');
    expect(within(req).getByText('missing')).toBeTruthy();
    expect(screen.getByText('The headers are identical.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only differences' }));
    expect(within(screen.getByRole('table', { name: 'Request headers' })).getAllByRole('row')).toHaveLength(2);
  });

  it('response bodies: identical says so (JSON key order ignored), different counts the lines', async () => {
    stubDetails({ a: { responseBody: json('{"a":1,"b":2}') }, b: { responseBody: json('{"b":2,"a":1}') }, c: { responseBody: json('{"a":1,"b":3}') } });
    const { unmount } = render(<CompareDialog a={entry('a')} b={entry('b')} onClose={vi.fn()} />);
    tab('Response body');
    expect(await screen.findByText('The bodies are identical')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show the whole body' })).toBeTruthy();
    unmount();
    render(<CompareDialog a={entry('a')} b={entry('c')} onClose={vi.fn()} />);
    expect(await screen.findByText('lines changed')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('−1')).toBeTruthy();
  });

  it('binary bodies, no bodies, and a body that could not load', async () => {
    stubDetails({ a: { responseBody: { encoding: 'base64', data: 'AAEC', size: 3 } }, b: { responseBody: { encoding: 'base64', data: 'AAED', size: 3 } } }, ['gone']);
    const first = render(<CompareDialog a={entry('a', { responseContentType: 'image/png' })} b={entry('b', { responseContentType: 'image/png' })} onClose={vi.fn()} />);
    tab('Response body');
    expect(await screen.findByText('The binary bodies differ')).toBeTruthy();
    tab('Request body');
    expect(await screen.findByText('Neither request has a body')).toBeTruthy();
    first.unmount();
    render(<CompareDialog a={entry('a')} b={entry('gone')} onClose={vi.fn()} />);
    tab('Response body');
    expect(await screen.findByText('Could not load the body')).toBeTruthy();
  });
});
