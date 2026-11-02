import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MockRule, NetworkEntry } from '@durbun/protocol';
import { networkStore, useMocks } from '../../data';
import NetworkView from './index';
import MocksView from '../mocks/index';

afterEach(() => {
  cleanup();
  act(() => {
    networkStore.reset();
    networkStore.flush();
    useMocks.setState({ rules: [], loaded: false });
  });
  localStorage.clear();
});

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
    startTs: Date.now(),
    state: 'complete',
    status: 200,
    duration: 120,
    requestHeaders: [],
    hasRequestBody: false,
    hasResponseBody: false,
    ...p,
  };
}

describe('NetworkView', () => {
  it('explains how to capture traffic when there are no requests', () => {
    render(<NetworkView />);
    expect(screen.getByText('No network requests yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'SDK setup' })).toBeTruthy();
    expect(screen.getByPlaceholderText(/Filter requests/)).toBeTruthy();
  });

  it('counts requests in scope and explains when filters hide everything', () => {
    render(<NetworkView />);
    act(() => {
      networkStore.upsert([entry('a'), entry('b', { status: 404 })]);
      networkStore.flush();
    });
    expect(screen.getByText('2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '5xx' }));
    expect(screen.getByText('No requests match the filters')).toBeTruthy();
    expect(screen.getByText('0 / 2')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Clear filters/ })[0]!);
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('flags invalid query tokens', () => {
    render(<NetworkView />);
    const input = screen.getByPlaceholderText(/Filter requests/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'status:abc' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('MocksView', () => {
  const rules: MockRule[] = [
    { id: 'r1', enabled: true, name: 'Empty pets', method: 'GET', url: '/v1/pets', match: 'contains', action: { type: 'respond', status: 200, headers: [['content-type', 'application/json']], body: '[]', bodyEncoding: 'utf8' }, createdAt: 1 },
    { id: 'r2', enabled: false, method: '*', url: '/v1/feed', match: 'contains', action: { type: 'delay', delayMs: 2000 }, createdAt: 2 },
  ];

  it('shows the empty state with a call to action', () => {
    act(() => useMocks.setState({ rules: [], loaded: true }));
    render(<MocksView />);
    expect(screen.getByText('No mock rules yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create the first rule' })).toBeTruthy();
  });

  it('lists rules in order with summaries and the active banner', () => {
    act(() => useMocks.setState({ rules, loaded: true }));
    render(<MocksView />);
    expect(screen.getByText('Empty pets')).toBeTruthy();
    expect(screen.getByText('200 · JSON')).toBeTruthy();
    expect(screen.getByText('Delay 2 s')).toBeTruthy();
    expect(screen.getByText(/1 rule active/)).toBeTruthy();
    expect(screen.getByText(/Order matters/)).toBeTruthy();
  });

  it('opens the editor with validation for a new rule', async () => {
    act(() => useMocks.setState({ rules, loaded: true }));
    render(<MocksView />);
    fireEvent.click(screen.getByRole('button', { name: 'New rule' }));
    // openNew awaits the unsaved-changes guard, so the editor appears a tick later.
    fireEvent.click(await screen.findByRole('button', { name: /Create rule/ }));
    expect(await screen.findByText('A URL pattern is required')).toBeTruthy();
  });
});
