import { afterEach, describe, expect, it } from 'vitest';
import type { DurbunPackage, FlowDoc, FlowEnvironments, PackageImportResult, PackageManifest } from '@durbun/protocol';
import { decryptSecrets, encryptSecrets } from '../../src/backup/package';
import { startTestApp, type TestApp } from '../http/fakes';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const json = { 'Content-Type': 'application/json' };
async function call<T = unknown>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${t!.base}${url}`, { method, headers: json, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
}

const flow = (id: string, extra: Partial<FlowDoc> = {}) => ({
  format: 'durbun-flow',
  version: 1,
  id,
  name: `Flow ${id}`,
  nodes: [
    { id: 'start', type: 'trigger.manual' },
    { id: 'note', type: 'output.note', params: { text: 'hello' } },
  ],
  edges: [{ from: 'start', to: 'note' }],
  ...extra,
});

const loginFlow = flow('login', { inputs: [{ name: 'password', default: 'Hunter2-pass', secret: true }, { name: 'email', default: 'a@b.test' }] });
const automated = flow('watch', { automation: { enabled: true } });
const rule = { id: 'm1', name: 'Login', enabled: true, method: 'GET', url: '/login', match: 'contains', action: { type: 'respond', status: 200, body: '{}' }, createdAt: 1 };

async function importAll(pkg: unknown, conflict: string, extra: Record<string, unknown> = {}) {
  const m = await call<PackageManifest>('POST', '/api/packages/inspect', { package: pkg });
  expect(m.status).toBe(200);
  return call<PackageImportResult & { code?: string }>('POST', '/api/packages/import', {
    token: m.data.token,
    include: { flows: 'all', mocks: true, environments: true, settings: true, slack: true },
    conflict,
    ...extra,
  });
}

describe('secret flow inputs', () => {
  it('a share leaves their defaults out; a backup keeps them encrypted and brings them back', async () => {
    t = await startTestApp({ flowsBackground: false });
    await call('POST', '/api/flows', { flow: loginFlow });
    const share = await call<DurbunPackage>('POST', '/api/packages/export', { kind: 'share', include: { flows: 'all' } });
    expect(JSON.stringify(share.data)).not.toContain('Hunter2-pass');
    expect(JSON.stringify(share.data)).toContain('a@b.test');
    expect(share.data.contents.secretInputs).toEqual({ login: ['password'] });

    const locked = await call<DurbunPackage>('POST', '/api/packages/export', { kind: 'backup', include: { flows: 'all' }, passphrase: 'correct horse' });
    expect(JSON.stringify(locked.data)).not.toContain('Hunter2-pass');
    const open = await call<DurbunPackage>('POST', '/api/packages/export', { kind: 'backup', include: { flows: 'all' } });
    expect(JSON.stringify(open.data)).not.toContain('Hunter2-pass');
    await t.close();

    // A new Mac: the encrypted backup restores the default.
    t = await startTestApp({ flowsBackground: false });
    const restored = await importAll(locked.data, 'replace', { passphrase: 'correct horse' });
    expect(restored.data.emptySecrets).toBeUndefined();
    const got = await call<{ flow: FlowDoc }>('GET', '/api/flows/login');
    expect(got.data.flow.inputs?.find((d) => d.name === 'password')?.default).toBe('Hunter2-pass');
    await t.close();

    // Without the passphrase (or from a share) the default stays empty, and the result says so.
    t = await startTestApp({ flowsBackground: false });
    const plain = await importAll(open.data, 'replace');
    expect(plain.data.emptySecrets).toEqual([{ kind: 'input', id: 'login', name: 'Flow login', keys: ['password'] }]);
  });

  it('a replace by a package without the default keeps this Mac’s', async () => {
    t = await startTestApp({ flowsBackground: false });
    await call('POST', '/api/flows', { flow: loginFlow });
    const share = await call<DurbunPackage>('POST', '/api/packages/export', { kind: 'share', include: { flows: 'all' } });
    const changed = { ...share.data, contents: { ...share.data.contents, flows: share.data.contents.flows!.map((f) => ({ ...f, description: 'new' })) } };
    const r = await importAll(changed, 'replace');
    expect(r.data.flows.replaced).toBe(1);
    const got = await call<{ flow: FlowDoc }>('GET', '/api/flows/login');
    expect(got.data.flow.description).toBe('new');
    expect(got.data.flow.inputs?.find((d) => d.name === 'password')?.default).toBe('Hunter2-pass');
    expect(r.data.emptySecrets).toBeUndefined();
  });
});

describe('automation', () => {
  it('shared flows come in with it off; a backup keeps it', async () => {
    t = await startTestApp({ flowsBackground: false });
    await call('POST', '/api/flows', { flow: automated });
    const share = await call<DurbunPackage>('POST', '/api/packages/export', { kind: 'share', include: { flows: 'all' } });
    const backup = await call<DurbunPackage>('POST', '/api/packages/export', { kind: 'backup', include: { flows: 'all' } });
    await t.close();

    t = await startTestApp({ flowsBackground: false });
    const m = await call<PackageManifest>('POST', '/api/packages/inspect', { package: share.data });
    expect(m.data.flows[0]).toMatchObject({ id: 'watch', automation: true });
    const shared = await importAll(share.data, 'keepBoth');
    expect(shared.data.automationOff).toBe(1);
    expect((await call<{ flow: FlowDoc }>('GET', '/api/flows/watch')).data.flow.automation?.enabled).toBe(false);
    await t.close();

    t = await startTestApp({ flowsBackground: false });
    const restored = await importAll(backup.data, 'replace');
    expect(restored.data.automationOff).toBe(0);
    expect((await call<{ flow: FlowDoc }>('GET', '/api/flows/watch')).data.flow.automation?.enabled).toBe(true);
  });

  it('a replace from a share switches it off too, and an identical flow is left alone', async () => {
    t = await startTestApp({ flowsBackground: false });
    await call('POST', '/api/flows', { flow: automated });
    const share = await call<DurbunPackage>('POST', '/api/packages/export', { kind: 'share', include: { flows: 'all' } });
    // Identical: nothing changes, this Mac's automation stays on.
    const same = await importAll(share.data, 'replace');
    expect(same.data.flows).toMatchObject({ same: 1, replaced: 0 });
    expect((await call<{ flow: FlowDoc }>('GET', '/api/flows/watch')).data.flow.automation?.enabled).toBe(true);
    // Changed: the replaced flow comes in switched off.
    const changed = { ...share.data, contents: { flows: share.data.contents.flows!.map((f) => ({ ...f, description: 'v2' })) } };
    const r = await importAll(changed, 'replace');
    expect(r.data).toMatchObject({ flows: { replaced: 1 }, automationOff: 1 });
    expect((await call<{ flow: FlowDoc }>('GET', '/api/flows/watch')).data.flow.automation?.enabled).toBe(false);
  });
});

describe('identical items', () => {
  it('are skipped in every mode and counted as the same, mock rules under any id', async () => {
    t = await startTestApp({ flowsBackground: false });
    t.config.setMocks([rule]);
    await call('POST', '/api/flows', { flow: flow('a') });
    await call('PUT', '/api/flow-environments', { environments: [{ id: 'dev', name: 'Dev', vars: [{ key: 'baseUrl', value: 'https://dev.test' }, { key: 'token', value: 'tok', secret: true }] }] });
    const share = await call<DurbunPackage>('POST', '/api/packages/export', { kind: 'share', include: { flows: 'all', mocks: true, environments: true } });
    // A teammate's copy of the same rule has its own id.
    const twin = { ...share.data, contents: { ...share.data.contents, mocks: [{ ...share.data.contents.mocks![0]!, id: 'other-id', createdAt: 99 }] } };
    const m = await call<PackageManifest>('POST', '/api/packages/inspect', { package: twin });
    expect(m.data.mocks).toEqual([{ id: 'other-id', name: 'Login', exists: true, differs: false }]);
    expect(m.data.environments).toEqual([{ id: 'dev', name: 'Dev', exists: true, differs: false }]);
    for (const conflict of ['keepBoth', 'replace', 'skip']) {
      const r = await importAll(twin, conflict);
      expect(r.data.flows).toMatchObject({ added: 0, replaced: 0, renamed: 0, same: 1 });
      expect(r.data.mocks).toMatchObject({ added: 0, replaced: 0, same: 1 });
      expect(r.data.environments).toMatchObject({ added: 0, replaced: 0, same: 1 });
    }
    expect(t.config.mocks).toHaveLength(1);
    const envs = await call<FlowEnvironments>('GET', '/api/flow-environments');
    expect(envs.data.environments).toHaveLength(1);
  });

  it('numbers kept copies (2), (3)…', async () => {
    t = await startTestApp({ flowsBackground: false });
    await call('POST', '/api/flows', { flow: flow('a') });
    const share = await call<DurbunPackage>('POST', '/api/packages/export', { kind: 'share', include: { flows: 'all' } });
    const changed = (d: string) => ({ ...share.data, contents: { flows: share.data.contents.flows!.map((f) => ({ ...f, description: d })) } });
    await importAll(changed('x'), 'keepBoth');
    await importAll(changed('y'), 'keepBoth');
    const list = await call<{ id: string; name: string }[]>('GET', '/api/flows');
    expect(list.data.map((f) => f.name).sort()).toEqual(['Flow a', 'Flow a (2)', 'Flow a (3)']);
  });
});

describe('environments', () => {
  it('a replace merges by key: the package wins, this Mac’s other keys and secrets stay; empty secrets are reported', async () => {
    t = await startTestApp({ flowsBackground: false });
    await call('PUT', '/api/flow-environments', {
      environments: [{ id: 'dev', name: 'Dev', vars: [{ key: 'baseUrl', value: 'https://old.test' }, { key: 'token', value: 'mine', secret: true }, { key: 'myPassword', value: 'pw', secret: true }] }],
    });
    const pkg = {
      format: 'durbun-package',
      version: 1,
      kind: 'share',
      createdAt: 1,
      createdBy: { app: 'Dürbün', version: '0.1.0' },
      contents: {
        environments: {
          environments: [
            { id: 'dev', name: 'Dev', vars: [{ key: 'baseUrl', value: 'https://new.test' }, { key: 'token', value: '', secret: true }, { key: 'apiKey', value: '', secret: true }] },
            { id: 'stage', name: 'Staging', vars: [{ key: 'baseUrl', value: 'https://stage.test' }, { key: 'token', value: '', secret: true }] },
          ],
        },
      },
    };
    const r = await importAll(pkg, 'replace');
    expect(r.data.environments).toMatchObject({ added: 1, replaced: 1 });
    const envs = await call<FlowEnvironments>('GET', '/api/flow-environments');
    const dev = envs.data.environments.find((e) => e.id === 'dev')!;
    expect(dev.vars).toEqual([
      { key: 'baseUrl', value: 'https://new.test' },
      { key: 'token', value: 'mine', secret: true },
      { key: 'myPassword', value: 'pw', secret: true },
      { key: 'apiKey', value: '', secret: true },
    ]);
    expect(r.data.emptySecrets).toEqual([
      { kind: 'env', id: 'dev', name: 'Dev', keys: ['apiKey'] },
      { kind: 'env', id: 'stage', name: 'Staging', keys: ['token'] },
    ]);
  });
});

describe('encryption', () => {
  it('binds the secrets to the contents: an edited package does not open', async () => {
    t = await startTestApp({ flowsBackground: false });
    await call('PUT', '/api/flow-environments', { environments: [{ id: 'dev', name: 'Dev', vars: [{ key: 'baseUrl', value: 'https://dev.test' }, { key: 'token', value: 'tok-1', secret: true }] }] });
    const backup = await call<DurbunPackage>('POST', '/api/packages/export', { kind: 'backup', include: { environments: true }, passphrase: 'correct horse' });
    expect(backup.data.secrets).toMatchObject({ aad: 'contents-sha256', N: 1 << 17, r: 8, p: 1 });
    const edited = JSON.parse(JSON.stringify(backup.data).replace('https://dev.test', 'https://evil.test')) as DurbunPackage;
    const m = await call<PackageManifest>('POST', '/api/packages/inspect', { package: edited, passphrase: 'correct horse' });
    expect(m.data.passphraseOk).toBe(false);
    const r = await call<{ code: string }>('POST', '/api/packages/import', { package: edited, passphrase: 'correct horse', include: { environments: true }, conflict: 'replace' });
    expect(r.data.code).toBe('package.passphrase.wrong');
    // The unchanged file opens (a JSON round trip does not change the digest).
    const ok = await call<PackageManifest>('POST', '/api/packages/inspect', { package: JSON.parse(JSON.stringify(backup.data, null, 2)), passphrase: 'correct horse' });
    expect(ok.data.passphraseOk).toBe(true);
  });

  it('still opens blobs made without associated data', async () => {
    const blob = await encryptSecrets({ slackWebhook: 'https://hooks.slack.test/x' }, 'correct horse');
    expect(blob.aad).toBeUndefined();
    await expect(decryptSecrets(blob, 'correct horse', { anything: true })).resolves.toEqual({ slackWebhook: 'https://hooks.slack.test/x' });
    await expect(decryptSecrets(blob, 'wrong horse')).rejects.toMatchObject({ code: 'package.passphrase.wrong' });
  });

  it('answers malformed or greedy encryption settings with a code, never a crash', async () => {
    const good = await encryptSecrets({}, 'correct horse', {});
    const cases: [Record<string, unknown>, string][] = [
      [{ ...good, salt: 5 }, 'package.crypto.invalid'],
      [{ ...good, iv: 'AAAA' }, 'package.crypto.invalid'],
      [{ ...good, tag: 'AAAAAAAA' }, 'package.crypto.invalid'],
      [{ ...good, data: 'not base64!' }, 'package.crypto.invalid'],
      [{ ...good, N: 1 << 20, r: 16 }, 'package.crypto.unknown'],
      [{ ...good, N: 3 }, 'package.crypto.unknown'],
      [{ ...good, cipher: 'rot13' }, 'package.crypto.unknown'],
      [{ ...good, aad: 'something-else' }, 'package.crypto.unknown'],
    ];
    for (const [blob, code] of cases) await expect(decryptSecrets(blob as never, 'correct horse', {})).rejects.toMatchObject({ code });

    t = await startTestApp({ flowsBackground: false });
    const pkg = { format: 'durbun-package', version: 1, kind: 'backup', contents: {}, secrets: { ...good, salt: 5 } };
    const r = await call<{ code: string }>('POST', '/api/packages/import', { package: pkg, passphrase: 'correct horse', include: {}, conflict: 'skip' });
    expect(r).toMatchObject({ status: 400, data: { code: 'package.crypto.invalid' } });
  });

  it('wants a passphrase of at least 8 characters', async () => {
    t = await startTestApp({ flowsBackground: false });
    const r = await call<{ code: string }>('POST', '/api/packages/export', { kind: 'backup', include: { flows: 'all' }, passphrase: 'short' });
    expect(r).toMatchObject({ status: 400, data: { code: 'package.passphrase.short' } });
  });
});

describe('inspect', () => {
  it('reads hand-made packages into a manifest of plain strings', async () => {
    t = await startTestApp({ flowsBackground: false });
    const m = await call<PackageManifest>('POST', '/api/packages/inspect', {
      package: { format: 'durbun-package', version: 1, kind: 'share', name: { a: 1 }, note: 7, createdAt: 'yesterday', contents: { mocks: [{ id: 5, name: { x: 1 } }] } },
    });
    expect(m.status).toBe(200);
    expect(m.data).toMatchObject({ kind: 'share', createdAt: 0, createdBy: { app: 'Dürbün', version: '' } });
    expect(m.data.name).toBeUndefined();
    expect(m.data.note).toBeUndefined();
    expect(m.data.mocks).toEqual([]);
    expect(m.data.warnings.map((w) => w.code)).toEqual(['package.mock.invalid']);
  });

  it('a passphrase check reuses the token; the server keeps at most two packages and lets one go', async () => {
    t = await startTestApp({ flowsBackground: false });
    await call('PUT', '/api/flow-environments', { environments: [{ id: 'dev', name: 'Dev', vars: [{ key: 'token', value: 'tok', secret: true }] }] });
    const backup = await call<DurbunPackage>('POST', '/api/packages/export', { kind: 'backup', include: { environments: true }, passphrase: 'correct horse' });
    const first = await call<PackageManifest>('POST', '/api/packages/inspect', { package: backup.data });
    const check = await call<PackageManifest>('POST', '/api/packages/inspect', { token: first.data.token, passphrase: 'correct horse' });
    expect(check.data).toMatchObject({ token: first.data.token, passphraseOk: true });
    const wrong = await call<PackageManifest>('POST', '/api/packages/inspect', { token: first.data.token, passphrase: 'wrong horse' });
    expect(wrong.data).toMatchObject({ token: first.data.token, passphraseOk: false });

    const second = await call<PackageManifest>('POST', '/api/packages/inspect', { package: backup.data });
    const third = await call<PackageManifest>('POST', '/api/packages/inspect', { package: backup.data });
    // The oldest went when the third came.
    expect((await call<{ code: string }>('POST', '/api/packages/inspect', { token: first.data.token })).data.code).toBe('package.expired');
    expect((await call<{ released: boolean }>('POST', '/api/packages/release', { token: second.data.token })).data.released).toBe(true);
    expect((await call<{ code: string }>('POST', '/api/packages/inspect', { token: second.data.token })).data.code).toBe('package.expired');
    expect((await call<PackageManifest>('POST', '/api/packages/inspect', { token: third.data.token })).status).toBe(200);
  });
});

describe('import notices', () => {
  it('carry codes and params besides the English text', async () => {
    t = await startTestApp({ flowsBackground: false });
    await call('PUT', '/api/flow-environments', { environments: [{ id: 'dev', name: 'Dev', vars: [{ key: 'token', value: 'tok', secret: true }] }] });
    const backup = await call<DurbunPackage>('POST', '/api/packages/export', { kind: 'backup', include: { environments: true }, passphrase: 'correct horse' });
    const pkg = { ...backup.data, contents: { ...backup.data.contents, mocks: [{ id: 'bad' }], settings: { futureSetting: 1 } } };
    const r = await call<PackageImportResult>('POST', '/api/packages/import', { package: pkg, include: { environments: true, mocks: true, settings: true }, conflict: 'skip' });
    expect(r.status).toBe(200);
    const codes = r.data.notices!.map((n) => n.code);
    expect(codes).toContain('package.secrets.notRestored');
    expect(codes).toContain('package.mock.invalid');
    expect(codes).toContain('package.settings.ignored');
    expect(r.data.warnings).toHaveLength(r.data.notices!.length);
    expect(r.data.notices!.find((n) => n.code === 'package.settings.ignored')!.params).toEqual({ keys: 'futureSetting' });
  });
});
