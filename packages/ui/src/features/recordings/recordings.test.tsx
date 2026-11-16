import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionRecording, SessionRecordingList, SessionRecordingOpen } from '@durbun/protocol';

const sent: { name: string; patch?: Record<string, unknown> }[] = [];
vi.mock('../../data/commands', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../data/commands')>();
  return {
    ...real,
    sendCommand: vi.fn(async (cmd: { name: string; patch?: Record<string, unknown> }) => {
      sent.push(cmd);
      return { ...DEFAULT, ...(cmd.patch ?? {}) };
    }),
  };
});

import { DEFAULT_SETTINGS } from '@durbun/protocol';
import '../../i18n';
import { setLanguage } from '../../i18n/core';
import { useConnection, withView } from '../../data';
import { setServerSettingsFromServer } from '../../data/stores/server';
import { ConfirmHost } from '../../components/Dialog';
import { recordingCounts, recordingSpan, recordingWhen, recordingWho, pauseText } from './model';
import { recordings, resetRecordingsForTests, useRecordings } from './store';
import { RecordingsDialog } from './RecordingsDialog';
import { LaunchOffer, RecordingBanner, RecorderStatusItem } from './RecordingsParts';
import { RecordingsSection } from './RecordingsSection';

const DEFAULT = { ...DEFAULT_SETTINGS };
const MB = 1024 * 1024;
const NOW = new Date(2026, 10, 16, 10, 0).getTime();
const START = new Date(2026, 10, 15, 21, 40).getTime();

const rec = (p: Partial<SessionRecording> = {}): SessionRecording => ({
  id: '20261115T184000Z-c3d4',
  startedAt: START,
  lastWriteAt: START + 134 * 60_000,
  endedAt: START + 134 * 60_000,
  state: 'ended',
  bytes: 48 * MB,
  counts: { logs: 12408, requests: 316, errors: 3, crashes: 1 },
  devices: [{ id: 'android:R5CT', name: 'Pixel 8', platform: 'android' }],
  apps: [{ name: 'Pati', bundleId: 'com.mykynk.pati', deviceId: 'android:R5CT' }],
  ...p,
});
const LIVE = rec({ id: '20261116T070000Z-a1b2', startedAt: NOW - 60 * 60_000, lastWriteAt: NOW, endedAt: undefined, state: 'recording', bytes: 3 * MB, counts: { logs: 900, requests: 12, errors: 0, crashes: 0 } });
const CRASHED = rec({ id: '20261114T120500Z-e5f6', startedAt: START - DAY(), endedAt: undefined, state: 'interrupted', gaps: 412 });
function DAY(): number {
  return 24 * 60 * 60_000;
}

const list = (recordings: SessionRecording[], p: Partial<SessionRecordingList['status']> = {}, previous?: string): SessionRecordingList => ({
  status: { enabled: true, state: 'recording', current: LIVE.id, dir: '/tmp/durbun/recordings', usedBytes: recordings.reduce((s, r) => s + r.bytes, 0), maxDays: 7, maxBytes: 1024 * MB, maxRecordingBytes: 256 * MB, ...p },
  recordings,
  ...(previous ? { previous } : {}),
});

let current: SessionRecordingList;
const calls: string[] = [];
function serve(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${input}`);
      const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (input === '/api/recordings' && method === 'GET') return ok(current);
      if (input === '/api/recordings' && method === 'DELETE') {
        current = { ...current, recordings: current.recordings.filter((r) => r.state === 'recording') };
        return ok(current);
      }
      const open = /^\/api\/recordings\/([^/]+)\/open$/.exec(input);
      if (open && method === 'POST') {
        const r = current.recordings.find((x) => x.id === open[1])!;
        const out: SessionRecordingOpen = { recording: r, loaded: { logs: 50_000, requests: 316 }, left: { logs: 2408, requests: 0 } };
        return ok(out);
      }
      if (open && method === 'DELETE') return ok({ ok: true });
      return new Response(JSON.stringify({ error: 'Not found', code: 'api.notFound' }), { status: 404 });
    }),
  );
}

beforeEach(() => {
  setLanguage('tr');
  resetRecordingsForTests();
  setServerSettingsFromServer({ ...DEFAULT });
  useConnection.setState({ status: 'live', everConnected: true });
  sent.length = 0;
  calls.length = 0;
  current = list([LIVE, rec(), CRASHED], {}, rec().id);
  serve();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('wording', () => {
  it('words when, how long, who and what', () => {
    expect(recordingWhen(START, 'tr', NOW)).toBe('15 Kas 21:40');
    expect(recordingWhen(START, 'en', NOW)).toBe('15 Nov 21:40');
    expect(recordingWhen(START, 'tr', NOW + 400 * DAY())).toBe('15 Kas 2026 21:40');
    expect(recordingSpan(30_000, 'tr')).toBe('1 dakikadan kısa');
    expect(recordingSpan(134 * 60_000, 'tr')).toBe('2 sa 14 dk');
    expect(recordingSpan(134 * 60_000, 'en')).toBe('2 h 14 min');
    expect(recordingSpan(26 * 60 * 60_000, 'en')).toBe('1 d 2 h');
    const many = rec({ devices: ['A', 'B', 'C'].map((n) => ({ id: n, name: n, platform: 'android' as const })), apps: [] });
    expect(recordingWho(many, 'en')).toBe('A, B +1');
    expect(recordingWho(rec({ devices: [], apps: [] }), 'tr')).toBe('Cihaz bilgisi yok');
    expect(recordingCounts(rec(), 'tr')).toBe('12.408 satır · 316 istek · 3 hata · 1 çökme');
    expect(recordingCounts(rec({ counts: { logs: 1, requests: 1, errors: 0, crashes: 0 } }), 'en')).toBe('1 line · 1 request');
    expect(pauseText({ code: 'recorder.diskLow', params: { free: 0.7 * 1024 ** 3, min: 1024 ** 3 }, message: 'x' }, 'tr')).toBe(
      'Mac’in diskinde 0,7 GB boş yer kaldı: oturum kaydı 1 GB altına düşmemek için duraklatıldı',
    );
  });
});

describe('recordings dialog', () => {
  it('lists the recordings: the live one cannot be opened, an interrupted one says so', async () => {
    render(<RecordingsDialog />);
    act(() => recordings.openDialog());
    await screen.findByText('15 Kas 21:40');
    expect(screen.getByText('Şu an kaydediliyor')).toBeTruthy();
    expect(screen.getByText('Yarıda kaldı')).toBeTruthy();
    expect(screen.getByText('412 öğe eksik')).toBeTruthy();
    // Two closed recordings → two Open buttons; the live one has none.
    expect(screen.getAllByRole('button', { name: /^Aç ·/ })).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toContain('Bu oturum kaydediliyor');
  });

  it('says why it is empty, and offers to turn recording on when it is off', async () => {
    current = list([], { enabled: false, state: 'off', current: undefined, usedBytes: 0 });
    render(<RecordingsDialog />);
    act(() => recordings.openDialog());
    await screen.findByText('Oturum kaydı kapalı');
    fireEvent.click(screen.getByRole('button', { name: 'Kaydı aç' }));
    await waitFor(() => expect(sent.some((c) => c.name === 'settings.update' && c.patch?.recordSessions === true)).toBe(true));
  });

  it('empty while on: no recordings yet', async () => {
    current = list([], { state: 'waiting', current: undefined, usedBytes: 0 });
    render(<RecordingsDialog />);
    act(() => recordings.openDialog());
    expect(await screen.findByText('Henüz kayıt yok')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Tümünü sil' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('opening a recording', () => {
  it('launch offer → the recording is shown apart from live, with a banner; back to live leaves it', async () => {
    await act(() => recordings.refresh());
    render(
      <>
        <RecordingBanner />
        <LaunchOffer />
        <RecorderStatusItem />
      </>,
    );
    expect(screen.getByText('Önceki oturum kaydedildi')).toBeTruthy();
    expect(screen.getByText(/12\.408 satır/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Önceki oturumu aç' }));
    await screen.findByText('Kayıt: 15 Kas 21:40');
    expect(calls).toContain(`POST /api/recordings/${rec().id}/open`);
    expect(screen.getByText(/canlı değil/)).toBeTruthy();
    expect(screen.getByText(/en yeni 50\.000 satır ve 316 istek yüklendi/)).toBeTruthy();
    expect(screen.queryByText('Önceki oturum kaydedildi')).toBeNull();
    // REST of the shown data carries the view.
    expect(withView('/api/export')).toBe(`/api/export?view=${rec().id}`);
    fireEvent.click(screen.getByRole('button', { name: 'Canlıya dön' }));
    expect(useRecordings.getState().viewing).toBeNull();
    expect(withView('/api/export')).toBe('/api/export');
    expect(screen.queryByText('Kayıt: 15 Kas 21:40')).toBeNull();
    await waitFor(() => expect(calls).toContain(`DELETE /api/recordings/${rec().id}/open`));
  });

  it('the offer stays closed once closed', async () => {
    await act(() => recordings.refresh());
    const { unmount } = render(<LaunchOffer />);
    fireEvent.click(screen.getByRole('button', { name: 'Kapat' }));
    expect(screen.queryByText('Önceki oturum kaydedildi')).toBeNull();
    unmount();
    resetRecordingsForTests();
    await act(() => recordings.refresh());
    render(<LaunchOffer />);
    expect(screen.queryByText('Önceki oturum kaydedildi')).toBeNull();
  });

  it('status bar says when recording is paused', async () => {
    current = list([LIVE], { state: 'paused', paused: { code: 'recorder.diskFull', params: { dir: '/tmp' }, message: 'The disk is full', since: NOW } });
    await act(() => recordings.refresh());
    render(<RecorderStatusItem />);
    expect(screen.getByRole('button', { name: 'Kayıt duraklatıldı' })).toBeTruthy();
  });
});

describe('Settings → Recordings', () => {
  it('turning recording off stops it, then asks whether to delete what exists', async () => {
    render(
      <>
        <RecordingsSection />
        <ConfirmHost />
      </>,
    );
    await screen.findByText('/tmp/durbun/recordings');
    expect(screen.getByText(/yakalandığı gibi saklanır/)).toBeTruthy();
    current = list([{ ...LIVE, state: 'ended', endedAt: NOW }, rec(), CRASHED], { enabled: false, state: 'off', current: undefined });
    fireEvent.click(screen.getByRole('switch', { name: 'Oturumları kaydet' }));
    await screen.findByText('Mevcut kayıtlar silinsin mi?');
    expect(sent.some((c) => c.patch?.recordSessions === false)).toBe(true);
    expect(screen.getByText(/Bu Mac’te 3 kayıt var/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Kayıtları sil' }));
    await waitFor(() => expect(calls).toContain('DELETE /api/recordings'));
  });
});
