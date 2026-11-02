import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { LogQueryHelp, LogQueryInput, QueryHighlight, type QuerySuggestData } from './index';

const DATA: QuerySuggestData = {
  tags: ['OkHttp', 'dio', 'chatty'],
  processes: ['com.mykynk.pati'],
  apps: [{ id: 'app:1', name: 'Pati', bundleId: 'com.mykynk.pati' }],
  history: ['level:error tag:dio', 'is:crash | is:anr'],
};

interface HarnessProps {
  initial?: string;
  onSubmit?: (v: string) => void;
  getData?: () => QuerySuggestData;
}

function Harness({ initial = '', onSubmit, getData = () => DATA }: HarnessProps) {
  const [value, setValue] = useState(initial);
  return <LogQueryInput value={value} onChange={setValue} onSubmit={onSubmit} getSuggestData={getData} shortcut={['/', 'Mod+F']} aria-label="Query" />;
}

const input = () => screen.getByRole('combobox') as HTMLInputElement;
const layerText = () => document.querySelector('.lq__hl-inner')!.textContent;
const options = () => screen.queryAllByRole('option').map((o) => o.textContent ?? '');
/** Types `value` (caret at the end), as the browser reports it to React. */
const typeText = (value: string) => fireEvent.change(input(), { target: { value } });
const key = (k: string, init: Record<string, unknown> = {}) => fireEvent.keyDown(input(), { key: k, ...init });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.getElementById('durbun-layers')?.remove();
});

describe('LogQueryInput', () => {
  it('renders the query as syntax-colored tokens behind a transparent input', () => {
    render(<Harness />);
    act(() => input().focus());
    typeText('level:error -tag:chatty "a b"');
    expect(input().value).toBe('level:error -tag:chatty "a b"');
    expect(layerText()).toBe('level:error -tag:chatty "a b"');
    const layer = document.querySelector('.lq__hl')!;
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(layer.querySelectorAll('.qt--key')).toHaveLength(2);
    expect(layer.querySelector('.qt--negation')?.textContent).toBe('-');
    expect(layer.querySelector('.qt--lv-error')?.textContent).toBe('error');
    expect(layer.querySelector('.qt--phrase')?.textContent).toBe('"a b"');
  });

  it('never loses keystrokes when the parent updates late or echoes stale values', () => {
    const onChange = vi.fn();
    const { rerender } = render(<LogQueryInput value="" onChange={onChange} getSuggestData={() => DATA} />);
    act(() => input().focus());
    for (const v of ['t', 'ta', 'tag', 'tag:', 'tag:d', 'tag:di', 'tag:dio']) typeText(v);
    expect(input().value).toBe('tag:dio');
    expect(onChange).toHaveBeenLastCalledWith('tag:dio');
    // the parent catches up with an old value first (debounce / transition): ignored
    rerender(<LogQueryInput value="tag:d" onChange={onChange} getSuggestData={() => DATA} />);
    expect(input().value).toBe('tag:dio');
    rerender(<LogQueryInput value="tag:dio" onChange={onChange} getSuggestData={() => DATA} />);
    expect(input().value).toBe('tag:dio');
    // a genuinely external change (click on a tag chip) is adopted
    rerender(<LogQueryInput value="tag:dio level:error" onChange={onChange} getSuggestData={() => DATA} />);
    expect(input().value).toBe('tag:dio level:error');
    expect(layerText()).toBe('tag:dio level:error');
  });

  it('keeps Turkish characters and handles IME composition', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    act(() => input().focus());
    typeText('ğüşıöç İSTANBUL Kadıköy');
    expect(input().value).toBe('ğüşıöç İSTANBUL Kadıköy');
    expect(layerText()).toBe('ğüşıöç İSTANBUL Kadıköy');
    const root = document.querySelector('.lq')!;
    fireEvent.compositionStart(input());
    expect(root.classList.contains('is-composing')).toBe(true);
    key('Enter', { isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input());
    expect(root.classList.contains('is-composing')).toBe(false);
    key('Enter');
    expect(onSubmit).toHaveBeenCalledWith('ğüşıöç İSTANBUL Kadıköy');
  });

  it('autocomplete: key → values with the ARIA combobox pattern', () => {
    render(<Harness />);
    act(() => input().focus());
    typeText('le');
    const list = screen.getByRole('listbox');
    expect(options()[0]).toContain('level:');
    const first = within(list).getAllByRole('option')[0]!;
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(input().getAttribute('aria-controls')).toBe(list.id);
    expect(input().getAttribute('aria-activedescendant')).toBe(first.id);

    key('Enter'); // accepts `level:` and opens the values
    expect(input().value).toBe('level:');
    expect(options().map((o) => o.split(/[A-Z]/)[0])).toEqual(['verbose', 'debug', 'info', 'warn', 'error', 'fatal']);
    key('ArrowDown');
    key('ArrowDown');
    key('ArrowUp');
    key('ArrowDown');
    expect(screen.getAllByRole('option')[2]!.getAttribute('aria-selected')).toBe('true');
    key('Enter');
    expect(input().value).toBe('level:info ');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input().getAttribute('aria-expanded')).toBe('false');
  });

  it('Enter submits what was typed when no suggestion is highlighted; Tab accepts the first', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    act(() => input().focus());
    typeText('okh');
    expect(options()).toEqual(['tag:OkHttp']);
    expect(screen.getByRole('option').getAttribute('aria-selected')).toBe('false');
    key('Enter');
    expect(onSubmit).toHaveBeenCalledWith('okh');
    expect(input().value).toBe('okh');
    typeText('okht');
    key('Tab');
    expect(input().value).toBe('tag:OkHttp ');
  });

  it('Escape closes the popup, then clears, then leaves the field', () => {
    render(<Harness />);
    act(() => input().focus());
    typeText('le');
    expect(screen.getByRole('listbox')).toBeTruthy();
    key('Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input().value).toBe('le');
    key('Escape');
    expect(input().value).toBe('');
    key('Escape');
    expect(document.activeElement).not.toBe(input());
  });

  it('picks a suggestion with the mouse without losing focus', () => {
    render(<Harness />);
    act(() => input().focus());
    typeText('is:');
    const crash = screen.getAllByRole('option').find((o) => o.textContent?.startsWith('crash'))!;
    fireEvent.mouseDown(crash);
    fireEvent.click(crash);
    expect(input().value).toBe('is:crash ');
    expect(document.activeElement).toBe(input());
  });

  it('shows recent queries when clicking into the empty field and reads data lazily', () => {
    const getData = vi.fn(() => DATA);
    render(<Harness getData={getData} />);
    expect(getData).not.toHaveBeenCalled();
    fireEvent.pointerDown(input());
    act(() => input().focus());
    expect(getData).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('listbox').getAttribute('aria-label')).toBe('Recent queries');
    expect(options()).toEqual(['level:error tag:dio', 'is:crash | is:anr']);
    typeText('l'); // still open: no new data request
    expect(getData).toHaveBeenCalledTimes(1);
    key('Escape');
    typeText('le');
    expect(getData).toHaveBeenCalledTimes(2);
  });

  it('shows errors (wavy span, icon, aria) right away when not typing', () => {
    render(<Harness initial="tag:dio level:xyz" />);
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('.qt-err')?.textContent).toBe('xyz');
    const icon = screen.getByRole('img', { name: /Query error: Unknown level: xyz/ });
    expect(icon).toBeTruthy();
    const described = document.getElementById(input().getAttribute('aria-describedby')!)!;
    expect(described.textContent).toBe('Unknown level: xyz. Use verbose, debug, info, warn, error or fatal.');
  });

  it('while typing, errors appear only after a pause', () => {
    vi.useFakeTimers();
    render(<Harness />);
    act(() => input().focus());
    typeText('level:x');
    expect(input().getAttribute('aria-invalid')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(input().getAttribute('aria-invalid')).toBe('true');
    typeText('level:e'); // fixed → hidden immediately
    expect(input().getAttribute('aria-invalid')).toBeNull();
  });

  it('keeps back an error about the term being completed while the popup is open', () => {
    vi.useFakeTimers();
    render(<Harness />);
    act(() => input().focus());
    typeText('tag:');
    expect(screen.getByRole('listbox')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(input().getAttribute('aria-invalid')).toBeNull(); // "missing value" while picking the value
    expect(document.querySelector('.lq-pop__error')).toBeNull();
    key('Escape');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect([...document.querySelectorAll('.qt-err')].map((e) => e.textContent).join('')).toBe('tag:');
  });

  it('clear button empties the query and keeps focus', () => {
    render(<Harness initial="tag:dio" />);
    const clear = screen.getByRole('button', { name: 'Clear query' });
    fireEvent.mouseDown(clear);
    fireEvent.click(clear);
    expect(input().value).toBe('');
    expect(document.activeElement).toBe(input());
  });

  it('the shortcut focuses the field; matching parentheses are emphasized', () => {
    render(<Harness initial="(a | b)" />);
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(input());
    input().setSelectionRange(7, 7);
    fireEvent.select(input());
    expect(document.querySelectorAll('.qt--paren.is-match')).toHaveLength(2);
  });
});

describe('LogQueryHelp and QueryHighlight', () => {
  it('renders the cheat sheet and applies examples', () => {
    const onExample = vi.fn();
    render(<LogQueryHelp onExample={onExample} />);
    expect(screen.getByRole('heading', { name: 'Query language' })).toBeTruthy();
    for (const name of [/^Keys$/, /^Operators/, /^is: kinds$/, /^Examples/]) expect(screen.getByRole('heading', { name })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Apply: is:crash \| is:anr/ }));
    expect(onExample).toHaveBeenCalledWith('is:crash | is:anr');
    expect(document.querySelectorAll('.lq-help__ex.is-clickable').length).toBeGreaterThanOrEqual(8);
  });

  it('without onExample the examples are plain text; the title is optional', () => {
    render(<LogQueryHelp showTitle={false} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: 'Query language' })).toBeNull();
    expect(screen.getByText(/msg:/)).toBeTruthy();
  });

  it('QueryHighlight colors a static query', () => {
    const { container } = render(<QueryHighlight query="-tag:chatty age:5m" />);
    expect(container.querySelector('code.qhl')?.textContent).toBe('-tag:chatty age:5m');
    expect(container.querySelector('.qt--k-age.qt--value')?.textContent).toBe('5m');
  });
});
