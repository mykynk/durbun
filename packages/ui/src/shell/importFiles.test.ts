import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ sessions: [] as string[], flows: [] as string[], toasts: [] as { kind: string; title: string; description?: string }[] }));

vi.mock('../data/api', async (orig) => ({
  ...(await orig<typeof import('../data/api')>()),
  importSession: vi.fn(async (input: File) => {
    if (input.name.startsWith('broken')) {
      const { ApiError } = await orig<typeof import('../data/api')>();
      throw new ApiError(400, 'Session file is missing the "logs" list', 'import.invalid', { error: 'Session file is missing the "logs" list', code: 'import.invalid', params: { field: 'logs' } });
    }
    if (input.name.startsWith('future')) {
      const { ApiError } = await orig<typeof import('../data/api')>();
      throw new ApiError(400, 'Unsupported session version 9', 'import.version', { error: 'Unsupported session version 9', code: 'import.version', params: { version: '9' } });
    }
    calls.sessions.push(input.name);
    return { deviceIds: [`import:${calls.sessions.length}`] };
  }),
}));
vi.mock('../data/stores/ui', async (orig) => {
  const real = await orig<typeof import('../data/stores/ui')>();
  return { ...real, ui: { ...real.ui, importFlows: (text: string) => calls.flows.push(text), setTab: () => undefined } };
});
vi.mock('../components/Toast', () => {
  const push = (kind: string) => (title: string, o?: { description?: string }) => {
    calls.toasts.push({ kind, title, ...(o?.description ? { description: o.description } : {}) });
    return 'id';
  };
  const toast = Object.assign((i: { kind?: string; title: string }) => push(i.kind ?? 'info')(i.title), { success: push('success'), info: push('info'), warn: push('warn'), error: push('error'), dismiss: () => undefined });
  return { toast };
});

import { setLanguage } from '../i18n';
import { classifyImport, importFile, importFiles } from './actions';

const file = (name: string, body: string) => new File([body], name, { type: 'application/json' });
const flow = (id: string) => file(`${id}.durbun-flow.json`, JSON.stringify({ format: 'durbun-flow', version: 1, id, name: id, nodes: [], edges: [] }));
const session = (name: string) => file(name, JSON.stringify({ format: 'durbun-session', version: 1 }));

beforeEach(() => {
  calls.sessions = [];
  calls.flows = [];
  calls.toasts = [];
});

describe('importing several files', () => {
  it('tells files apart by name and content', async () => {
    expect(await classifyImport(file('app.apk', 'x'))).toBe('install');
    expect(await classifyImport(flow('a'))).toBe('flow');
    expect(await classifyImport(session('rec.durbun.json'))).toBe('session');
    expect(await classifyImport(file('notes.json', '{"a":1}'))).toBe('notDurbun');
  });

  it('imports every file, puts the flows into one import and sums it up once', async () => {
    await importFiles([flow('cart'), session('rec.durbun.json'), file('app.apk', 'x'), flow('login')]);
    expect(calls.sessions).toEqual(['rec.durbun.json']);
    expect(calls.flows).toHaveLength(1);
    expect(JSON.parse(calls.flows[0]!).map((f: { id: string }) => f.id)).toEqual(['cart', 'login']);
    const summary = calls.toasts.filter((x) => x.kind !== 'info');
    expect(summary).toHaveLength(1);
    expect(summary[0]!.kind).toBe('warn');
    expect(summary[0]!.description).toContain('app.apk');
  });
});

describe('a session file the server turns down', () => {
  it('says why in the UI language, from the code and its params', async () => {
    setLanguage('tr');
    try {
      await importFile(session('broken.durbun.json'));
      await importFile(session('future.durbun.json'));
    } finally {
      setLanguage('en');
    }
    const errors = calls.toasts.filter((x) => x.kind === 'error').map((x) => x.description);
    expect(errors).toEqual(['Oturum dosyasındaki “logs” listesi eksik ya da bozuk', 'Bu oturum dosyasının sürümü (9) tanınmıyor']);
  });
});
