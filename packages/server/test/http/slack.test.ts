import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_SLACK_TEXT_CHARS, SLACK_FILE_NAME, SlackStore, slackHint, validateWebhookUrl } from '../../src/http/slack';
import { silentLogger } from '../../src/util/logger';
import { makeTempDir, startTestApp, type TestApp } from './fakes';

const HOOK = 'https://hooks.slack.com/services/T000/B000/abcdWXYZ';

interface Sent {
  url: string;
  init: RequestInit;
}

function fakeSlack(answer: () => Response | Promise<Response> = () => new Response('ok')): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return answer();
    }) as unknown as typeof fetch,
  };
}

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('webhook URL', () => {
  it('accepts https URLs only and keeps them as given', () => {
    expect(validateWebhookUrl(`  ${HOOK} `)).toBe(HOOK);
    for (const bad of ['', 'hooks.slack.com/services/x', 'http://hooks.slack.com/services/x', 'https://user:pw@hooks.slack.com/x', 'javascript:alert(1)', 42, null]) {
      expect(() => validateWebhookUrl(bad), String(bad)).toThrow(expect.objectContaining({ status: 400, code: 'slack.invalidUrl' }));
    }
  });

  it('hint names the host and the last characters only', () => {
    expect(slackHint(HOOK)).toBe('hooks.slack.com · …WXYZ');
    expect(slackHint('https://hooks.slack.com/')).toBe('hooks.slack.com');
  });
});

describe('SlackStore', () => {
  it('saves the webhook in its own 0600 file and never reports it back', async () => {
    const dir = await makeTempDir();
    const store = SlackStore.inDataDir(dir, silentLogger);
    expect(await store.status()).toEqual({ configured: false });
    const status = await store.update({ webhookUrl: HOOK, sender: '  Ayşe   Yılmaz ' });
    expect(status).toEqual({ configured: true, hint: 'hooks.slack.com · …WXYZ', sender: 'Ayşe Yılmaz' });
    expect(JSON.stringify(status)).not.toContain('abcd');
    const file = path.join(dir, SLACK_FILE_NAME);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ webhookUrl: HOOK, sender: 'Ayşe Yılmaz' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    // A new store (next launch) reads it back; a missing key keeps the value, null removes it.
    const again = SlackStore.inDataDir(dir, silentLogger);
    expect(await again.update({ sender: null })).toEqual({ configured: true, hint: 'hooks.slack.com · …WXYZ' });
    expect(await again.update({ webhookUrl: '' })).toEqual({ configured: false });
  });

  it('rejects a bad webhook without dropping the saved one', async () => {
    const store = SlackStore.inDataDir(await makeTempDir(), silentLogger);
    await store.update({ webhookUrl: HOOK });
    await expect(store.update({ webhookUrl: 'http://example.com/hook' })).rejects.toMatchObject({ code: 'slack.invalidUrl' });
    await expect(store.update('x')).rejects.toMatchObject({ code: 'slack.invalid' });
    expect((await store.status()).configured).toBe(true);
  });

  it('treats a broken file as not connected', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, SLACK_FILE_NAME), '{ nope');
    expect(await SlackStore.inDataDir(dir, silentLogger).status()).toEqual({ configured: false });
    await writeFile(path.join(dir, SLACK_FILE_NAME), JSON.stringify({ webhookUrl: 'http://plain.example/hook', sender: 'Can' }));
    expect(await SlackStore.inDataDir(dir, silentLogger).status()).toEqual({ configured: false, sender: 'Can' });
  });

  it('posts the text as JSON without link previews and refuses redirects', async () => {
    const slack = fakeSlack();
    const store = SlackStore.inDataDir(await makeTempDir(), silentLogger, slack.fetch);
    await store.update({ webhookUrl: HOOK });
    await store.send({ text: '*POST* https://api.example.com/login' });
    expect(slack.sent).toHaveLength(1);
    expect(slack.sent[0]!.url).toBe(HOOK);
    expect(slack.sent[0]!.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(slack.sent[0]!.init.body))).toEqual({ text: '*POST* https://api.example.com/login', unfurl_links: false, unfurl_media: false });
  });

  it('explains what went wrong', async () => {
    const dir = await makeTempDir();
    await expect(SlackStore.inDataDir(dir, silentLogger).send({ text: 'x' })).rejects.toMatchObject({ status: 409, code: 'slack.notConfigured' });

    const refused = SlackStore.inDataDir(dir, silentLogger, fakeSlack(() => new Response('invalid_token', { status: 403 })).fetch);
    await refused.update({ webhookUrl: HOOK });
    await expect(refused.send({ text: 'x' })).rejects.toMatchObject({ status: 502, code: 'slack.rejected', message: 'Slack refused the message: invalid_token' });

    const offline = SlackStore.inDataDir(
      dir,
      silentLogger,
      fakeSlack(() => {
        throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND hooks.slack.com') });
      }).fetch,
    );
    await expect(offline.send({ text: 'x' })).rejects.toMatchObject({ code: 'slack.unreachable', message: 'Could not reach Slack: getaddrinfo ENOTFOUND hooks.slack.com' });

    for (const text of ['', '   ', 'x'.repeat(MAX_SLACK_TEXT_CHARS + 1)]) {
      await expect(refused.send({ text })).rejects.toMatchObject({ status: 400, code: 'slack.invalid' });
    }
  });
});

describe('REST /api/slack', () => {
  it('connects, sends and disconnects', async () => {
    const slack = fakeSlack();
    t = await startTestApp({ fetchImpl: slack.fetch });
    const json = { 'Content-Type': 'application/json' };

    expect(await (await fetch(`${t.base}/api/slack`)).json()).toEqual({ configured: false });
    const notYet = await fetch(`${t.base}/api/slack/send`, { method: 'POST', headers: json, body: JSON.stringify({ text: 'hi' }) });
    expect(notYet.status).toBe(409);
    expect(await notYet.json()).toMatchObject({ code: 'slack.notConfigured' });

    const bad = await fetch(`${t.base}/api/slack`, { method: 'PUT', headers: json, body: JSON.stringify({ webhookUrl: 'nope' }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'slack.invalidUrl' });

    const put = await fetch(`${t.base}/api/slack`, { method: 'PUT', headers: json, body: JSON.stringify({ webhookUrl: HOOK, sender: 'Ayşe' }) });
    expect(await put.json()).toEqual({ configured: true, hint: 'hooks.slack.com · …WXYZ', sender: 'Ayşe' });

    const send = await fetch(`${t.base}/api/slack/send`, { method: 'POST', headers: json, body: JSON.stringify({ text: 'hi' }) });
    expect(send.status).toBe(200);
    expect(await send.json()).toEqual({ ok: true });
    expect(slack.sent.map((s) => s.url)).toEqual([HOOK]);

    expect((await fetch(`${t.base}/api/slack/send`)).status).toBe(405);
    await fetch(`${t.base}/api/slack`, { method: 'PUT', headers: json, body: JSON.stringify({ webhookUrl: null }) });
    expect(await (await fetch(`${t.base}/api/slack`)).json()).toEqual({ configured: false, sender: 'Ayşe' });
  });
});
