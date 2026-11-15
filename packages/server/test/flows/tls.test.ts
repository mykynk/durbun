/**
 * HTTPS test servers with an internal CA or a self-signed certificate: safe by default (the certificate is
 * refused, with a step error that says so), an explicit per-environment choice (trust this certificate / do not
 * verify), a preflight warning, and the choice kept in the run history. A resend can skip verification once.
 *
 * A real HTTPS server on 127.0.0.1 with a certificate made by openssl for the test (skipped without openssl).
 */
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NetworkDetail } from '@durbun/protocol';
import { replayRequest } from '../../src/http/replay';
import { createTlsFetch, fetchErrorCode, isTlsCertError, pemCertificates } from '../../src/http/tlsFetch';
import { makeTempDir } from '../http/fakes';
import { chain, harness, type Harness } from './helpers';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function makeCert(dir: string, name: string): Promise<{ cert: string; key: string }> {
  const cnf = path.join(dir, `${name}.cnf`);
  await writeFile(
    cnf,
    [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = ext',
      'prompt = no',
      '[dn]',
      `CN = ${name}.localhost`,
      '[ext]',
      'subjectAltName = DNS:localhost, IP:127.0.0.1',
      'basicConstraints = critical, CA:TRUE',
      'keyUsage = critical, digitalSignature, keyCertSign',
      '',
    ].join('\n'),
  );
  const keyFile = path.join(dir, `${name}.key.pem`);
  const certFile = path.join(dir, `${name}.cert.pem`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-keyout', keyFile, '-out', certFile, '-config', cnf], { stdio: 'ignore' });
  return { cert: await readFile(certFile, 'utf8'), key: await readFile(keyFile, 'utf8') };
}

const enabled = hasOpenssl();
/** The preflight notes about certificates (the test server is on this Mac, which has its own note). */
const tlsNotes = (issues: { code: string }[] | undefined) => (issues ?? []).filter((i) => i.code.startsWith('preflight.env.'));
let dir: string;
let own: { cert: string; key: string };
let other: { cert: string; key: string };
let server: https.Server;
let base: string;

beforeAll(async () => {
  if (!enabled) return;
  dir = await makeTempDir('durbun-tls-');
  own = await makeCert(dir, 'test-server');
  other = await makeCert(dir, 'other-ca');
  server = https.createServer({ key: own.key, cert: own.cert }, (req, res) => {
    if (req.url === '/gzip') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(JSON.stringify({ zipped: true })));
      return;
    }
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] });
      res.end(JSON.stringify({ ok: true, method: req.method, body }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  if (!enabled) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled)('createTlsFetch', () => {
  it('the normal fetch refuses the self-signed server; its certificate as extra CA or skipVerify reach it', async () => {
    const plain = await fetch(`${base}/ping`).catch((e: unknown) => e);
    expect(isTlsCertError(fetchErrorCode(plain))).toBe(true);

    const trusted = await createTlsFetch({ ca: own.cert })(`${base}/echo`, { method: 'POST', headers: [['content-type', 'text/plain']], body: Buffer.from('hi') });
    expect(trusted.status).toBe(200);
    expect(await trusted.json()).toEqual({ ok: true, method: 'POST', body: 'hi' });
    expect(trusted.headers.getSetCookie()).toEqual(['a=1', 'b=2']);

    const unverified = await createTlsFetch({ skipVerify: true })(`${base}/gzip`);
    expect(await unverified.json()).toEqual({ zipped: true });

    const wrongCa = await createTlsFetch({ ca: other.cert })(`${base}/ping`).catch((e: unknown) => e);
    expect(wrongCa).toBeInstanceOf(TypeError);
    expect(isTlsCertError(fetchErrorCode(wrongCa))).toBe(true);
  });

  it('aborts like fetch; http URLs go to the fallback; only certificate blocks of a PEM text count', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new DOMException('stop', 'AbortError'));
    await expect(createTlsFetch({ skipVerify: true })(`${base}/ping`, { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    let used = '';
    const fallback = (async (u: string) => {
      used = u;
      return new Response('plain');
    }) as typeof fetch;
    expect(await (await createTlsFetch({ skipVerify: true }, fallback)('http://example.test/a')).text()).toBe('plain');
    expect(used).toBe('http://example.test/a');
    expect(pemCertificates(`${own.key}\n${own.cert}`)).toEqual([own.cert.trim()]);
  });
});

describe.skipIf(!enabled)('flow HTTP steps against a self-signed test server', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.close();
  });

  const flow = () =>
    h.save({
      id: 'ping',
      name: 'Ping',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'ping', type: 'http.request', params: { method: 'GET', url: '{{env.baseUrl}}/ping', expectStatus: '2xx' } },
      ],
      edges: chain('start', 'ping'),
    });
  const env = (tls?: Record<string, unknown>) => h.envs.put({ environments: [{ id: 'test', name: 'Test', vars: [{ key: 'baseUrl', value: base }], ...(tls ? { tls } : {}) }] });

  it('safe by default: a refused certificate fails the step with flow.http.tls, no warning in the preflight', async () => {
    // Without a setting the run uses the normal fetch (the harness fake): it reports what Node reports.
    h.route(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) });
    });
    await env();
    await flow();
    const run = await h.run('ping', { environmentId: 'test' });
    expect(run.status).toBe('failed');
    const step = run.steps.find((s) => s.nodeId === 'ping')!;
    expect(step.errorCode).toBe('flow.http.tls');
    expect(run.environment).toEqual({ id: 'test', name: 'Test' });
    expect(tlsNotes(run.preflight)).toEqual([]);
  });

  it('a trusted certificate: the step passes; the history keeps "customCa"', async () => {
    await env({ ca: own.cert });
    await flow();
    const run = await h.run('ping', { environmentId: 'test' });
    expect(run.status).toBe('passed');
    expect(run.environment).toEqual({ id: 'test', name: 'Test', tls: 'customCa' });
    expect(tlsNotes(run.preflight).map((i) => i.code)).toEqual(['preflight.env.customCa']);
    expect((run.steps.find((s) => s.nodeId === 'ping')!.output as { tlsVerified?: boolean }).tlsVerified).toBeUndefined();
  });

  it('another CA does not help: the step says the certificate was refused', async () => {
    await env({ ca: other.cert });
    await flow();
    const run = await h.run('ping', { environmentId: 'test' });
    expect(run.steps.find((s) => s.nodeId === 'ping')!.errorCode).toBe('flow.http.tls');
  });

  it('no verification: passes with a preflight warning, tlsVerified: false in the step output and "unverified" in history', async () => {
    await env({ skipVerify: true });
    await flow();
    const run = await h.run('ping', { environmentId: 'test' });
    expect(run.status).toBe('passed');
    expect(run.environment).toEqual({ id: 'test', name: 'Test', tls: 'unverified' });
    expect(tlsNotes(run.preflight)).toEqual([expect.objectContaining({ level: 'warn', code: 'preflight.env.insecureTls', params: { env: 'Test' } })]);
    expect((run.steps.find((s) => s.nodeId === 'ping')!.output as { tlsVerified?: boolean }).tlsVerified).toBe(false);
  });

  it('the environment keeps only parsable certificates (never a pasted key) and refuses a text without one', async () => {
    const saved = await h.envs.put({ environments: [{ id: 'test', name: 'Test', vars: [], tls: { ca: `${own.key}\n${own.cert}`, skipVerify: 'yes' } }] });
    expect(saved.value.environments[0]!.tls).toEqual({ ca: `${own.cert.trim()}\n` });
    await expect(h.envs.put({ environments: [{ id: 'test', name: 'Test', vars: [], tls: { ca: 'not a certificate' } }] })).rejects.toMatchObject({ code: 'env.tls.invalidCa' });
    const cleared = await h.envs.put({ environments: [{ id: 'test', name: 'Test', vars: [], tls: { ca: '', skipVerify: false } }] });
    expect(cleared.value.environments[0]!.tls).toBeUndefined();
  });
});

describe.skipIf(!enabled)('resend (net.replay) to a self-signed server', () => {
  it('refused by default with a replay.tlsRejected warning; skipTlsVerify sends it once and warns', async () => {
    const original: NetworkDetail = {
      id: 'app:1',
      deviceId: 'android:X',
      method: 'POST',
      url: `${base}/echo`,
      host: base.slice('https://'.length),
      path: '/echo',
      startTs: 1,
      state: 'complete',
      status: 200,
      requestHeaders: [['content-type', 'text/plain']],
      hasRequestBody: true,
      requestBody: { encoding: 'utf8', data: 'again', size: 5 },
      hasResponseBody: false,
    } as NetworkDetail;
    const recorded: NetworkDetail[] = [];
    const hub = {
      getNetworkDetail: (id: string) => (id === original.id ? original : undefined),
      recordDesktopRequest: (d: NetworkDetail) => {
        recorded.push(d);
        return { ...d } as never;
      },
    };
    const refused = await replayRequest({ hub, maxBodyBytes: 10_000 }, original.id);
    expect(refused.entry.state).toBe('failed');
    expect(refused.warnings.map((w) => w.code)).toEqual(['replay.tlsRejected']);

    const sent = await replayRequest({ hub, maxBodyBytes: 10_000 }, original.id, { skipTlsVerify: true });
    expect(sent.entry).toMatchObject({ state: 'complete', status: 200 });
    expect(sent.warnings.map((w) => w.code)).toEqual(['replay.tlsUnverified']);
    expect(recorded.at(-1)!.responseBody?.data).toContain('"body":"again"');
  });
});
