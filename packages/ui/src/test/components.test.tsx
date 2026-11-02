import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '../i18n/foundation';
import { setLanguage } from '../i18n/core';
import { JsonTree } from '../components/JsonTree';
import { KeyValueTable } from '../components/KeyValueTable';
import { CodeView } from '../components/CodeView';
import { ConfirmHost, confirm } from '../components/Dialog';
import { LevelBadge, MethodBadge, StatusBadge, TagChip } from '../components/Badges';
import { EmptyState } from '../components/Layout';
import { sanitizePrefs } from '../data/stores/prefs';

afterEach(() => cleanup());

describe('JsonTree', () => {
  const data = {
    user: { id: 42, name: 'Yusuf', roles: ['admin', 'dev'] },
    items: Array.from({ length: 250 }, (_, i) => ({ id: i })),
    ok: true,
  };

  it('renders top-level keys and only expands children on demand', () => {
    const { container } = render(<JsonTree data={data} />);
    expect(screen.getByText('user')).toBeTruthy();
    // collapsed child objects are not rendered
    expect(screen.queryByText('roles')).toBeNull();
    const userRow = container.querySelector('[data-jt-key$="user"]') as HTMLElement;
    fireEvent.click(userRow);
    expect(screen.getByText('roles')).toBeTruthy();
  });

  it('pages large arrays instead of rendering 10k rows', () => {
    const { container } = render(<JsonTree data={data} />);
    const itemsRow = container.querySelector('[data-jt-key$="items"]') as HTMLElement;
    fireEvent.click(itemsRow);
    const rows = container.querySelectorAll('[role="treeitem"]');
    // 3 top-level + 100 first items
    expect(rows.length).toBe(103);
    const more = container.querySelector('.jt__more-btn') as HTMLButtonElement;
    expect(more).toBeTruthy();
    fireEvent.click(more);
    expect(container.querySelectorAll('[role="treeitem"]').length).toBe(253);
  });

  it('auto-expands and highlights search matches', () => {
    const { container } = render(<JsonTree data={data} search="admin" />);
    expect(container.querySelector('mark')?.textContent).toBe('admin');
    expect(container.querySelectorAll('.jt__row.is-match')).toHaveLength(1);
  });
});

describe('KeyValueTable', () => {
  it('renders header pairs and filters rows', () => {
    const headers: [string, string][] = Array.from({ length: 10 }, (_, i) => [`X-Header-${i}`, `value-${i}`]);
    headers.push(['Content-Type', 'application/json']);
    render(<KeyValueTable rows={headers} />);
    expect(screen.getByText('Content-Type')).toBeTruthy();
    const filter = screen.getByPlaceholderText('Filter') as HTMLInputElement;
    fireEvent.change(filter, { target: { value: 'content' } });
    expect(screen.queryByText('X-Header-3')).toBeNull();
    expect(screen.getByText('application/json')).toBeTruthy();
  });
});

describe('CodeView', () => {
  it('highlights JSON with line numbers', () => {
    const { container } = render(<CodeView code={'{\n  "a": 1\n}'} language="json" />);
    expect(container.querySelectorAll('.code__line')).toHaveLength(3);
    expect(container.querySelector('.hljs-attr')?.textContent).toBe('"a"');
    expect(container.querySelector('.code__lang')?.textContent).toBe('JSON');
  });
});

describe('confirm()', () => {
  it('resolves true when confirmed and false when cancelled', async () => {
    setLanguage('en');
    render(<ConfirmHost />);
    let p!: Promise<boolean>;
    act(() => {
      p = confirm({ title: 'Clear all data?', confirmLabel: 'Clear', danger: true });
    });
    fireEvent.click(await screen.findByText('Clear'));
    await expect(p).resolves.toBe(true);
    act(() => {
      p = confirm({ title: 'Again?' });
    });
    fireEvent.click(await screen.findByText('Cancel'));
    await expect(p).resolves.toBe(false);
  });
});

describe('badges', () => {
  it('write technical names literally (no CSS uppercase)', () => {
    render(
      <>
        <LevelBadge level="info" />
        <MethodBadge method="get" />
        <StatusBadge state="complete" status={404} />
        <StatusBadge state="failed" error="timeout" />
        <TagChip name="OkHttp" />
      </>,
    );
    expect(screen.getByText('INFO')).toBeTruthy();
    expect(screen.getByText('GET').className).toContain('method--get');
    expect(screen.getByText('404').className).toContain('status--4xx');
    expect(screen.getByTitle('timeout')).toBeTruthy();
    const chip = screen.getByText('OkHttp') as HTMLElement;
    expect(chip.style.getPropertyValue('--h')).not.toBe('');
  });

  it('EmptyState renders title, description and actions', () => {
    render(<EmptyState title="Nothing yet" description="Connect a device" actions={<button>Go</button>} />);
    expect(screen.getByText('Nothing yet')).toBeTruthy();
    expect(screen.getByText('Go')).toBeTruthy();
  });
});

describe('UI prefs sanitizing', () => {
  it('drops malformed persisted values and clamps the font size', () => {
    const p = sanitizePrefs({ theme: 'neon', logFontSize: 40, density: 'comfortable', noiseRules: [{ bogus: true }], panelSizes: { a: 300, b: -1, c: 'x' } });
    expect(p.theme).toBe('system');
    expect(p.logFontSize).toBe(16);
    expect(p.density).toBe('comfortable');
    expect(p.noiseRules).toEqual([]);
    expect(p.panelSizes).toEqual({ a: 300 });
    expect(sanitizePrefs('garbage').theme).toBe('system');
  });
});
