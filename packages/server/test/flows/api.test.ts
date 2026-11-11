import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DurbunPackage, FlowDoc, FlowEnvironments, FlowRun, PackageManifest } from '@durbun/protocol';
import { connectUi, sampleNetwork, startTestApp, type TestApp } from '../http/fakes';
import { BackupService } from '../../src/backup/scheduler';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const json = { 'Content-Type': 'application/json' };
async function call<T = unknown>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T; headers: Headers }> {
  const res = await fetch(`${t!.base}${url}`, { method, headers: json, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T, headers: res.headers };
}

const simpleFlow = (id: string, extra: Partial<FlowDoc> = {}) => ({
  format: 'durbun-flow',
  version: 1,
  id,
  name: `Flow ${id}`,
  nodes: [
    { id: 'start', type: 'trigger.manual' },
    { id: 'note', type: 'output.note', params: { text: 'hello {{input.who}}' } },
  ],
  edges: [{ from: 'start', to: 'note' }],
  inputs: [{ name: 'who', default: 'world' }],
  ...extra,
});

async function waitRun(id: string): Promise<FlowRun> {
  for (let i = 0; i < 100; i++) {
    const { data } = await call<FlowRun>('GET', `/api/flow-runs/${id}`);
    if (data.status !== 'running') return data;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('run did not end');
}

describe('flows API', () => {
  it('creates, lists, runs and deletes a flow, broadcasting changes', async () => {
    t = await startTestApp({ flowsBackground: false });
    const ui = await connectUi(t.port);
    try {
      const snapshot = await ui.waitForType('snapshot');
      expect(snapshot.flows).toEqual([]);
      const created = await call<{ flow: FlowDoc }>('POST', '/api/flows', { flow: simpleFlow('hello') });
      expect(created.status).toBe(201);
      expect(created.data.flow.createdAt).toBeTypeOf('number');
      await ui.waitFor((m) => m.type === 'flows' && m.flows.length === 1);

      const list = await call<{ id: string }[]>('GET', '/api/flows');
      expect(list.data.map((f) => f.id)).toEqual(['hello']);

      const started = await call<FlowRun>('POST', '/api/flows/hello/run', { inputs: { who: 'Ayşe' } });
      expect(started.status).toBe(202);
      await ui.waitFor((m) => m.type === 'flowRun' && m.run.id === started.data.id && m.run.status === 'passed');
      const run = await waitRun(started.data.id);
      expect(run.steps.find((s) => s.nodeId === 'note')!.output).toEqual({ text: 'hello Ayşe' });
      await ui.waitFor((m) => m.type === 'flows' && m.flows[0]?.lastRun?.id === started.data.id);

      const history = await call<{ runs: { id: string }[] }>('GET', '/api/flow-runs?flowId=hello');
      expect(history.data.runs.map((r) => r.id)).toEqual([started.data.id]);

      expect((await call('DELETE', '/api/flows/hello')).status).toBe(200);
      expect((await call('GET', '/api/flows/hello')).status).toBe(404);
      const files = await readdir(path.join(t.config.dataDir, 'flows'));
      expect(files).toEqual([]);
    } finally {
      ui.close();
    }
  });

  it('answers 409 with the preflight when a run cannot start', async () => {
    t = await startTestApp({ flowsBackground: false });
    await call('POST', '/api/flows', {
      flow: { ...simpleFlow('dev'), nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'shot', type: 'device.screenshot' }], edges: [{ from: 'start', to: 'shot' }] },
    });
    const res = await call<{ code: string; preflight: { issues: { code: string }[] } }>('POST', '/api/flows/dev/run', {});
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('flow.preflight.failed');
    expect(res.data.preflight.issues.map((i) => i.code)).toContain('preflight.device.none');
  });

  it('saves drafts with their issues and renames ids with references', async () => {
    t = await startTestApp({ flowsBackground: false });
    await call('POST', '/api/flows', { flow: simpleFlow('child') });
    await call('POST', '/api/flows', { flow: { ...simpleFlow('parent'), nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'c', type: 'flow.call', params: { flowId: 'child' } }], edges: [{ from: 'start', to: 'c' }] } });
    const draft = await call<{ issues: { code: string }[] }>('PUT', '/api/flows/child', { flow: { ...simpleFlow('kid'), nodes: [...simpleFlow('kid').nodes, { id: 'req', type: 'http.request', params: {} }] } });
    expect(draft.status).toBe(200);
    expect(draft.data.issues.map((i) => i.code)).toContain('flow.param.required');
    const parent = await call<{ flow: FlowDoc }>('GET', '/api/flows/parent');
    expect(parent.data.flow.nodes[1]!.params!.flowId).toBe('kid');
  });

  it('moves the run history with a renamed flow, and refuses a rename while it runs', async () => {
    t = await startTestApp({ flowsBackground: false });
    await call('POST', '/api/flows', { flow: simpleFlow('old') });
    const done = await call<FlowRun>('POST', '/api/flows/old/run', {});
    await waitRun(done.data.id);
    const slow = { ...simpleFlow('old'), nodes: [...simpleFlow('old').nodes, { id: 'w', type: 'logic.delay', params: { durationMs: 400 } }], edges: [{ from: 'start', to: 'note' }, { from: 'note', to: 'w' }] };
    await call('PUT', '/api/flows/old', { flow: slow });
    const running = await call<FlowRun>('POST', '/api/flows/old/run', {});
    const refused = await call<{ code: string }>('PUT', '/api/flows/old', { flow: { ...slow, id: 'new' } });
    expect(refused.status).toBe(409);
    expect(refused.data.code).toBe('flow.running');
    await waitRun(running.data.id);
    const renamed = await call<{ flow: FlowDoc }>('PUT', '/api/flows/old', { flow: { ...slow, id: 'new' } });
    expect(renamed.data.flow.id).toBe('new');
    const runs = await call<{ runs: { id: string; flowId: string }[] }>('GET', '/api/flow-runs?flowId=new');
    expect(runs.data.runs.map((r) => r.id).sort()).toEqual([done.data.id, running.data.id].sort());
    expect((await call<FlowRun>('GET', `/api/flow-runs/${done.data.id}`)).data.flowId).toBe('new');
    // A save without an id keeps the flow's id; API paths are not flow ids.
    const { id: _id, ...noId } = renamed.data.flow;
    expect((await call<{ flow: FlowDoc }>('PUT', '/api/flows/new', { flow: noId })).data.flow.id).toBe('new');
    expect((await call<{ flow: FlowDoc }>('POST', '/api/flows', { flow: { ...simpleFlow('schema'), name: 'Schema' } })).data.flow.id).toBe('schema-2');
  });

  it('imports an AI answer with comments and trailing commas', async () => {
    t = await startTestApp({ flowsBackground: false });
    const answer = [
      'Here is your flow:',
      '```json',
      '{',
      '  // made by an AI',
      '  "format": "durbun-flow", "version": 1, "id": "ai-flow", "name": "AI flow",',
      '  "nodes": [ { "id": "start", "type": "trigger.manual" }, { "id": "get", "type": "http.request", "params": { "url": "{{env.baseUrl}}/x", } }, ],',
      '  "edges": [ { "source": "start", "target": "get" } ]',
      '}',
      '```',
      'Set baseUrl in your environment.',
    ].join('\n');
    const preview = await call<{ items: { flow: FlowDoc; exists: boolean; issues: unknown[] }[]; problems: string[] }>('POST', '/api/flows/import/preview', { text: answer });
    expect(preview.data.problems).toEqual([]);
    const item = preview.data.items[0]!;
    expect(item.flow.edges).toEqual([{ from: 'start', to: 'get' }]);
    expect(item.flow.nodes.every((n) => n.position)).toBe(true);
    const saved = await call<{ saved: { id: string }[] }>('POST', '/api/flows/import', { flows: [item.flow], conflict: 'skip' });
    expect(saved.data.saved.map((s) => s.id)).toEqual(['ai-flow']);
    const again = await call<{ saved: { id: string }[]; skipped: number }>('POST', '/api/flows/import', { flows: [item.flow], conflict: 'keepBoth' });
    expect(again.data.saved[0]!.id).toBe('ai-flow-2');
  });

  it('answers an environments save with the saved document, as GET returns it', async () => {
    t = await startTestApp({ flowsBackground: false });
    const put = await call<FlowEnvironments>('PUT', '/api/flow-environments', {
      environments: [{ id: 'dev', name: 'Dev', vars: [{ key: 'baseUrl', value: 'https://dev.test' }, { key: 'password', value: 'pw', secret: true }] }],
    });
    expect(put.status).toBe(200);
    expect(put.data.environments.map((e) => e.id)).toEqual(['dev']);
    expect(put.data.activeId).toBe('dev');
    const get = await call<FlowEnvironments>('GET', '/api/flow-environments');
    expect(put.data).toEqual(get.data);
  });

  it('builds an AI pack with the catalog, the context and no secrets', async () => {
    t = await startTestApp({ flowsBackground: false });
    await call('PUT', '/api/flow-environments', { environments: [{ id: 'dev', name: 'Dev', vars: [{ key: 'token', value: 'super-secret-value', secret: true }] }] });
    await call('POST', '/api/flows', { flow: simpleFlow('login', { outputs: [{ name: 'token', value: '{{note.text}}' }] }) });
    const pack = await call<{ markdown: string }>('POST', '/api/flows/ai-pack', { goal: 'Sepete ürün ekle ve toplamı kontrol et', language: 'tr' });
    const md = pack.data.markdown;
    expect(md).toContain('Sepete ürün ekle');
    expect(md).toContain('`http.request`');
    expect(md).toContain('`login`');
    expect(md).toContain('{{env.token}}');
    expect(md).toContain('in Turkish');
    expect(md).not.toContain('super-secret-value');
  });

  it('creates a flow from captured requests and saves what it found in the environment', async () => {
    t = await startTestApp({ flowsBackground: false });
    t.hub.network.set(
      'app:1:1',
      sampleNetwork('app:1:1', {
        method: 'POST',
        url: 'https://api.shop.test/v1/login',
        startTs: 1,
        requestHeaders: [['content-type', 'application/json']],
        requestBody: { encoding: 'utf8', data: '{"email":"a@b.c"}', size: 17 },
        requestContentType: 'application/json',
        status: 200,
        responseHeaders: [['content-type', 'application/json']],
        responseBody: { encoding: 'utf8', data: '{"token":"tok-abcdef123"}', size: 25 },
        responseContentType: 'application/json',
      }),
    );
    t.hub.network.set(
      'app:1:2',
      sampleNetwork('app:1:2', {
        method: 'GET',
        url: 'https://api.shop.test/v1/cart',
        startTs: 2,
        requestHeaders: [['authorization', 'Bearer tok-abcdef123']],
        status: 200,
        responseHeaders: [],
      }),
    );
    const res = await call<{ flow: FlowDoc; envVars: { key: string }[] }>('POST', '/api/flows/from-requests', { ids: ['app:1:2', 'app:1:1'], name: 'Sepet' });
    expect(res.status).toBe(201);
    const [, login, cart] = res.data.flow.nodes;
    expect(login!.params!.url).toBe('{{env.baseUrl}}/v1/login');
    expect(cart!.params!.headers).toEqual([['authorization', 'Bearer {{postLogin.body.token}}']]);
    const envs = await call<{ environments: { vars: { key: string; value: string }[] }[] }>('GET', '/api/flow-environments');
    expect(envs.data.environments[0]!.vars).toEqual([{ key: 'baseUrl', value: 'https://api.shop.test' }]);
  });
});

describe('packages API', () => {
  it('shares without secrets and backs up with encrypted secrets that restore', async () => {
    t = await startTestApp({ flowsBackground: false });
    await call('POST', '/api/flows', { flow: simpleFlow('child') });
    await call('POST', '/api/flows', { flow: { ...simpleFlow('parent'), nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'c', type: 'flow.call', params: { flowId: 'child' } }], edges: [{ from: 'start', to: 'c' }] } });
    await call('PUT', '/api/flow-environments', { environments: [{ id: 'dev', name: 'Dev', vars: [{ key: 'baseUrl', value: 'https://dev.test' }, { key: 'token', value: 'tok-secret-1', secret: true }] }] });
    await call('PUT', '/api/ui-prefs', { theme: 'dark' });

    const share = await call<DurbunPackage>('POST', '/api/packages/export', { kind: 'share', include: { flows: ['parent'], environments: true } });
    expect(share.headers.get('content-disposition')).toContain('.durbun');
    expect(share.data.contents.flows!.map((f) => f.id).sort()).toEqual(['child', 'parent']);
    expect(JSON.stringify(share.data)).not.toContain('tok-secret-1');
    expect(share.data.secrets).toBeUndefined();
    // A share goes to other people: it names no machine.
    expect(share.data.createdBy.host).toBeUndefined();

    const backup = await call<DurbunPackage>('POST', '/api/packages/export', {
      kind: 'backup',
      include: { flows: 'all', environments: true, uiPrefs: true, settings: true, mocks: true, slack: true, runs: true },
      passphrase: 'correct horse',
    });
    expect(JSON.stringify(backup.data)).not.toContain('tok-secret-1');
    expect(backup.data.secrets?.cipher).toBe('aes-256-gcm');
    expect(backup.data.createdBy.host).toMatch(/\S/);
    await t.close();

    // A new Mac
    t = await startTestApp({ flowsBackground: false });
    const wrong = await call<PackageManifest>('POST', '/api/packages/inspect', { package: backup.data, passphrase: 'nope nope' });
    expect(wrong.data.passphraseOk).toBe(false);
    const manifest = await call<PackageManifest>('POST', '/api/packages/inspect', { package: backup.data, passphrase: 'correct horse' });
    expect(manifest.data).toMatchObject({ kind: 'backup', hasSecrets: true, passphraseOk: true, uiPrefs: true });
    expect(manifest.data.flows.map((f) => [f.id, f.exists])).toEqual([
      ['child', false],
      ['parent', false],
    ]);
    const imported = await call<{ flows: { added: number }; secretsRestored: boolean; uiPrefs: unknown }>('POST', '/api/packages/import', {
      token: manifest.data.token,
      passphrase: 'correct horse',
      include: { flows: 'all', environments: true, uiPrefs: true },
      conflict: 'skip',
    });
    expect(imported.status).toBe(200);
    expect(imported.data).toMatchObject({ flows: { added: 2 }, secretsRestored: true, uiPrefs: { theme: 'dark' } });
    const envs = await call<{ environments: { vars: { key: string; value: string }[] }[] }>('GET', '/api/flow-environments');
    expect(envs.data.environments[0]!.vars.find((v) => v.key === 'token')!.value).toBe('tok-secret-1');
    const wrongImport = await call<{ code: string }>('POST', '/api/packages/import', { package: backup.data, passphrase: 'nope nope', include: { environments: true }, conflict: 'skip' });
    expect(wrongImport.data.code).toBe('package.passphrase.wrong');
  });

  it('tells a flow file or a session from a package', async () => {
    t = await startTestApp({ flowsBackground: false });
    const res = await call<{ code: string }>('POST', '/api/packages/inspect', { package: simpleFlow('x') });
    expect(res.status).toBe(400);
    expect(res.data.code).toBe('package.isFlow');
  });

  it('writes a backup into the chosen folder and keeps the newest', async () => {
    t = await startTestApp({ flowsBackground: false });
    const folder = path.join(t.dir, 'Backups');
    const bad = await call<{ code: string }>('PUT', '/api/backup', { enabled: true });
    expect(bad.data.code).toBe('backup.folder.missing');
    const set = await call<{ folder: string; hasPassphrase: boolean }>('PUT', '/api/backup', { enabled: true, folder, keep: 1, passphrase: 'long enough phrase' });
    expect(set.data).toMatchObject({ folder, hasPassphrase: true });
    await call('POST', '/api/flows', { flow: simpleFlow('a') });
    const first = await call<{ file: string }>('POST', '/api/backup/run');
    await new Promise((r) => setTimeout(r, 1100));
    const second = await call<{ file: string }>('POST', '/api/backup/run');
    expect(first.data.file).not.toBe(second.data.file);
    const files = await readdir(folder);
    expect(files).toEqual([path.basename(second.data.file)]);
    const pkg = JSON.parse(await readFile(second.data.file, 'utf8')) as DurbunPackage;
    expect(pkg).toMatchObject({ format: 'durbun-package', kind: 'backup' });
    const listed = await call<{ name: string }[]>('GET', '/api/backup/files');
    expect(listed.data.map((f) => f.name)).toEqual(files);
    const status = await call<{ lastBackupFile: string }>('GET', '/api/backup');
    expect(status.data.lastBackupFile).toBe(second.data.file);
  });
});

describe('backup folder suggestions', () => {
  it('offers iCloud Drive and sync services, not plain mounts', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'durbun-home-'));
    try {
      await mkdir(path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), { recursive: true });
      for (const name of ['GoogleDrive-ayse@example.com', 'OneDrive-Personal', 'Box-Box', 'MacDroid-samsungSM-A736B', 'Dropbox']) {
        await mkdir(path.join(home, 'Library', 'CloudStorage', name), { recursive: true });
      }
      await mkdir(path.join(home, 'Dropbox'));
      const labels = (await BackupService.suggestions(home)).map((s) => s.label);
      expect(labels).toEqual(['iCloud Drive', 'Box', 'Dropbox', 'Google Drive (ayse@example.com)', 'OneDrive (Personal)', 'Documents']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
