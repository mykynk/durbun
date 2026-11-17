import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectionUrl,
  markdownToRichText,
  MAX_SLACK_MARKDOWN_PART_CHARS,
  MAX_SLACK_TEXT_CHARS,
  notificationText,
  parseConnection,
  retryAfterSeconds,
  SLACK_FILE_NAME,
  SlackStore,
  slackHint,
  slackMarkdownChunks,
  validateWebhookUrl,
} from '../../src/http/slack';
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

    const limited = SlackStore.inDataDir(dir, silentLogger, fakeSlack(() => new Response('rate_limited', { status: 429, headers: { 'Retry-After': '30' } })).fetch);
    await expect(limited.send({ text: 'x' })).rejects.toMatchObject({ status: 429, code: 'slack.rateLimited', message: 'Slack is limiting messages: 30 s' });
    const limitedNoHint = SlackStore.inDataDir(dir, silentLogger, fakeSlack(() => new Response('', { status: 429 })).fetch);
    await expect(limitedNoHint.send({ text: 'x' })).rejects.toMatchObject({ status: 429, code: 'slack.rateLimited', message: 'Slack is limiting messages: 30 s' });

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

const TOKEN = 'xoxb-1111-2222-abcdefghijklmnop';
const KEYED = `${HOOK}#token=${TOKEN}&channel=C0123ABCD&channel_name=%23qa`;

/** A fake Slack that answers the webhook, the Web API methods and the upload URL. */
function fakeSlackApi(overrides: Record<string, () => Response> = {}): { fetch: typeof fetch; sent: Sent[]; calls(): string[] } {
  const sent: Sent[] = [];
  const api = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  const answers: Record<string, () => Response> = {
    'conversations.join': () => api({ ok: true, channel: { id: 'C0123ABCD' } }),
    'files.getUploadURLExternal': () => api({ ok: true, upload_url: 'https://files.slack.com/upload/v1/ABC123', file_id: 'F0456EFGH' }),
    upload: () => new Response('OK - 4'),
    'files.completeUploadExternal': () => api({ ok: true, files: [{ id: 'F0456EFGH' }] }),
    webhook: () => new Response('ok'),
    ...overrides,
  };
  const key = (url: string) =>
    url.startsWith('https://slack.com/api/') ? url.slice('https://slack.com/api/'.length) : url.startsWith('https://files.slack.com/') ? 'upload' : 'webhook';
  return {
    sent,
    calls: () => sent.map((s) => key(s.url)),
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return answers[key(url)]!();
    }) as unknown as typeof fetch,
  };
}

const PNG = { name: 'shot-1.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), title: 'Screenshot · Pati · Galaxy A73' };

describe('connection URL', () => {
  it('reads the key after # and writes it back the same way', () => {
    const c = parseConnection(` ${KEYED} `);
    expect(c).toEqual({ webhookUrl: HOOK, token: TOKEN, channelId: 'C0123ABCD', channelName: '#qa' });
    expect(parseConnection(connectionUrl(c))).toEqual(c);
    expect(parseConnection(HOOK)).toEqual({ webhookUrl: HOOK });
    // A fragment that is not a key is dropped; the webhook stays.
    expect(parseConnection(`${HOOK}#anything`)).toEqual({ webhookUrl: HOOK });
  });

  it('refuses a cut or altered key, and an http webhook', () => {
    for (const bad of [`${HOOK}#token=${TOKEN}`, `${HOOK}#channel=C0123ABCD`, `${HOOK}#token=xoxp-123456789&channel=C0123ABCD`, `${HOOK}#token=${TOKEN}&channel=D0123ABCD`]) {
      expect(() => parseConnection(bad), bad).toThrow(expect.objectContaining({ status: 400, code: 'slack.invalidKey' }));
    }
    expect(() => parseConnection(`http://hooks.slack.com/x#token=${TOKEN}&channel=C0123ABCD`)).toThrow(expect.objectContaining({ code: 'slack.invalidUrl' }));
  });

  it('keeps the key in the 0600 file, says screenshots can go, and never reports the token', async () => {
    const dir = await makeTempDir();
    const store = SlackStore.inDataDir(dir, silentLogger);
    const status = await store.update({ webhookUrl: KEYED });
    expect(status).toEqual({ configured: true, hint: 'hooks.slack.com · …WXYZ', uploads: true, channel: '#qa' });
    expect(JSON.stringify(status)).not.toContain('xoxb');
    expect(JSON.parse(await readFile(path.join(dir, SLACK_FILE_NAME), 'utf8'))).toEqual({ webhookUrl: HOOK, token: TOKEN, channelId: 'C0123ABCD', channelName: '#qa' });
    // The backup gets the whole connection URL, which update() reads back.
    expect(await store.secrets()).toEqual({ webhookUrl: KEYED });
    // A plain webhook replaces the whole connection: the key goes with it.
    expect(await store.update({ webhookUrl: HOOK })).toEqual({ configured: true, hint: 'hooks.slack.com · …WXYZ' });
    expect(JSON.parse(await readFile(path.join(dir, SLACK_FILE_NAME), 'utf8'))).toEqual({ webhookUrl: HOOK });
  });

  it('reads a key an older version saved inside the URL', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, SLACK_FILE_NAME), JSON.stringify({ webhookUrl: KEYED }));
    expect(await SlackStore.inDataDir(dir, silentLogger).status()).toMatchObject({ configured: true, uploads: true, channel: '#qa' });
  });
});

describe('Markdown parts', () => {
  const block = (lang: string, lines: number, width = 60) => [`\`\`\`${lang}`, ...Array.from({ length: lines }, (_, i) => `${String(i).padStart(4, '0')} ${'x'.repeat(width)}`), '```'];
  const balanced = (part: string) => (part.match(/^```/gm) ?? []).length % 2 === 0;

  it('keeps a short report in one part, as it is', () => {
    const md = ['GET https://api.example.com/x', '→ 200 OK · 12 ms', '', '- Time: 10:55', '', ...block('http', 3)].join('\n');
    expect(slackMarkdownChunks(md)).toEqual([md]);
  });

  it('cuts a long report at line ends, closing and reopening the code block with its language', () => {
    const md = ['GET https://api.example.com/bank-list', '', 'Response body:', ...block('json', 600)].join('\n');
    const parts = slackMarkdownChunks(md);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_SLACK_MARKDOWN_PART_CHARS);
      expect(balanced(part)).toBe(true);
    }
    for (const part of parts.slice(1)) expect(part.startsWith('```json\n')).toBe(true);
    // Nothing is lost: without the added fences the parts are the report again.
    const joined = parts.map((p, i) => (i > 0 ? p.replace(/^```json\n/, '') : p)).map((p, i) => (i < parts.length - 1 ? p.replace(/\n```$/, '') : p));
    expect(joined.join('\n')).toBe(md);
  });

  it('cuts a line longer than a part (minified JSON) without splitting a surrogate pair', () => {
    const line = `${'a'.repeat(99)}😀${'b'.repeat(250)}`;
    const parts = slackMarkdownChunks(['```json', line, '```'].join('\n'), 100);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(100);
      expect(balanced(part)).toBe(true);
      expect(part).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    }
    expect(parts.map((p) => p.replace(/^```json\n/, '').replace(/\n```$/, '')).join('')).toBe(line);
  });

  it('starts the next part with a heading rather than ending one with it', () => {
    const parts = slackMarkdownChunks(['a'.repeat(50), '', '```http', 'h: 1', '```'].join('\n'), 60);
    expect(parts).toEqual(['a'.repeat(50), '```http\nh: 1\n```']);
  });

  it('turns the report into rich text: paragraphs, headings, quotes, lists and code with its language', () => {
    const md = [
      '## 1 failed request',
      'GET https://api.example.com/a?b=1 (see `x-id`)',
      '→ 500 · 12 ms',
      '',
      '> Tapped **Pay** twice.',
      '> Nothing happened.',
      '- Time: 10:55',
      '- Client: flow',
      '',
      'Response body (application/json):',
      '```json',
      '{ "a": "<b>" }',
      '```',
      '_Secret values are masked._ user_id_x stays',
    ].join('\n');
    expect(markdownToRichText(md)).toEqual({
      type: 'rich_text',
      elements: [
        { type: 'rich_text_section', elements: [{ type: 'text', text: '1 failed request', style: { bold: true } }] },
        {
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: 'GET ' },
            { type: 'link', url: 'https://api.example.com/a?b=1' },
            { type: 'text', text: ' (see ' },
            { type: 'text', text: 'x-id', style: { code: true } },
            { type: 'text', text: ')' },
            { type: 'text', text: '\n' },
            { type: 'text', text: '→ 500 · 12 ms' },
            { type: 'text', text: '\n' },
          ],
        },
        {
          type: 'rich_text_quote',
          elements: [
            { type: 'text', text: 'Tapped ' },
            { type: 'text', text: 'Pay', style: { bold: true } },
            { type: 'text', text: ' twice.' },
            { type: 'text', text: '\n' },
            { type: 'text', text: 'Nothing happened.' },
          ],
        },
        {
          type: 'rich_text_list',
          style: 'bullet',
          elements: [
            { type: 'rich_text_section', elements: [{ type: 'text', text: 'Time: 10:55' }] },
            { type: 'rich_text_section', elements: [{ type: 'text', text: 'Client: flow' }] },
          ],
        },
        { type: 'rich_text_section', elements: [{ type: 'text', text: 'Response body (application/json):' }] },
        { type: 'rich_text_preformatted', elements: [{ type: 'text', text: '{ "a": "<b>" }' }], language: 'json', border: 0 },
        { type: 'rich_text_section', elements: [{ type: 'text', text: 'Secret values are masked.', style: { italic: true } }, { type: 'text', text: ' user_id_x stays' }] },
      ],
    });
    // An 800-line body stays one block in one message.
    const big = ['```json', ...Array.from({ length: 800 }, (_, i) => `  "k${i}": ${i},`), '```'].join('\n');
    const block = markdownToRichText(big);
    expect(block.elements).toHaveLength(1);
    expect(block.elements[0]).toMatchObject({ type: 'rich_text_preformatted', language: 'json' });
  });

  it('makes a notification line from the first plain line', () => {
    expect(notificationText('## GET https://x.example/a?b=<c>&d\n```json\n{}\n```')).toBe('GET https://x.example/a?b=&lt;c&gt;&amp;d');
    expect(notificationText('```\ncode only\n```')).toBe('Dürbün');
    expect(notificationText(`- *${'y'.repeat(300)}*`)).toHaveLength(150);
    expect(notificationText(`${'y'.repeat(148)}😀${'z'.repeat(10)}`)).toBe(`${'y'.repeat(148)}…`);
  });
});

describe('Markdown and screenshots', () => {
  it('posts the report as one rich text message, as a pasted report shows', async () => {
    const slack = fakeSlackApi();
    const store = new SlackStore(path.join(await makeTempDir(), SLACK_FILE_NAME), silentLogger, slack.fetch, 0);
    await store.update({ webhookUrl: HOOK });
    expect(await store.send({ markdown: 'GET https://a.example/x\n\n- one\n\n```json\n{}\n```', text: 'fallback' })).toEqual({ ok: true });
    expect(slack.sent).toHaveLength(1);
    const body = JSON.parse(String(slack.sent[0]!.init.body));
    expect(body).toMatchObject({ text: 'GET https://a.example/x', unfurl_links: false, unfurl_media: false });
    expect(body.blocks).toEqual([markdownToRichText('GET https://a.example/x\n\n- one\n\n```json\n{}\n```')]);
  });

  /** A webhook that refuses the block types in [refused] (400 invalid_blocks) and takes the rest. */
  const refusing = (...refused: string[]) => {
    const sent: Sent[] = [];
    const typeOf = (init: RequestInit) => (JSON.parse(String(init.body)) as { blocks?: { type: string }[] }).blocks?.[0]?.type ?? 'text';
    const f = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return refused.includes(typeOf(init)) ? new Response('invalid_blocks', { status: 400 }) : new Response('ok');
    }) as unknown as typeof fetch;
    return { fetch: f, sent, types: () => sent.map((x) => typeOf(x.init)) };
  };

  it('sends a long report as numbered Markdown parts when Slack refuses the rich text', async () => {
    const slack = refusing('rich_text');
    const store = new SlackStore(path.join(await makeTempDir(), SLACK_FILE_NAME), silentLogger, slack.fetch, 0);
    await store.update({ webhookUrl: HOOK });
    const md = ['GET https://a.example/x', '```json', ...Array.from({ length: 500 }, (_, i) => `"k${i}": "${'v'.repeat(50)}",`), '```'].join('\n');
    await store.send({ markdown: md });
    const types = slack.types();
    expect(types[0]).toBe('rich_text');
    expect(types.length).toBeGreaterThan(2);
    expect(types.slice(1).every((t) => t === 'markdown')).toBe(true);
    const parts = slack.sent.slice(1).map((s) => JSON.parse(String(s.init.body)) as { text: string });
    expect(parts.map((b) => b.text)).toEqual(parts.map((_, i) => `GET https://a.example/x (${i + 1}/${parts.length})`));
  });

  it('falls back to the plain text when the workspace refuses both block kinds', async () => {
    const slack = refusing('rich_text', 'markdown');
    const store = new SlackStore(path.join(await makeTempDir(), SLACK_FILE_NAME), silentLogger, slack.fetch, 0);
    await store.update({ webhookUrl: HOOK });
    await store.send({ markdown: '# x', text: '*x*' });
    expect(slack.types()).toEqual(['rich_text', 'markdown', 'text']);
    expect(JSON.parse(String(slack.sent[2]!.init.body))).toEqual({ text: '*x*', unfurl_links: false, unfurl_media: false });
    // Any other refusal is an error, not a fallback.
    const broken = SlackStore.inDataDir(await makeTempDir(), silentLogger, fakeSlackApi({ webhook: () => new Response('channel_is_archived', { status: 410 }) }).fetch, 0);
    await broken.update({ webhookUrl: HOOK });
    await expect(broken.send({ markdown: '# x' })).rejects.toMatchObject({ code: 'slack.rejected', message: 'Slack refused the message: channel_is_archived' });
  });

  it('uploads the screenshot to the channel after the report', async () => {
    const slack = fakeSlackApi();
    const store = new SlackStore(path.join(await makeTempDir(), SLACK_FILE_NAME), silentLogger, slack.fetch, 0);
    await store.update({ webhookUrl: KEYED });
    expect(await store.send({ markdown: 'bug' }, PNG)).toEqual({ ok: true, screenshot: 'sent' });
    expect(slack.calls()).toEqual(['webhook', 'conversations.join', 'files.getUploadURLExternal', 'upload', 'files.completeUploadExternal']);
    const [, join, getUrl, upload, complete] = slack.sent;
    for (const call of [join!, getUrl!, complete!]) {
      expect(call.init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
      expect(call.init.redirect).toBe('error');
    }
    expect(String(join!.init.body)).toBe('channel=C0123ABCD');
    expect(Object.fromEntries(new URLSearchParams(String(getUrl!.init.body)))).toEqual({ filename: 'screenshot.png', length: '4' });
    // The bytes go to Slack's upload host only, without the token.
    expect(upload!.url).toBe('https://files.slack.com/upload/v1/ABC123');
    expect(JSON.stringify(upload!.init.headers)).not.toContain('xoxb');
    expect(Buffer.from(upload!.init.body as Uint8Array)).toEqual(PNG.data);
    expect(Object.fromEntries(new URLSearchParams(String(complete!.init.body)))).toEqual({
      files: JSON.stringify([{ id: 'F0456EFGH', title: PNG.title }]),
      channel_id: 'C0123ABCD',
    });
    // The channel is joined once per launch.
    await store.send({ markdown: 'bug 2' }, PNG);
    expect(slack.calls().filter((c) => c === 'conversations.join')).toHaveLength(1);
  });

  it('says why a screenshot did not go while the report did', async () => {
    const text = SlackStore.inDataDir(await makeTempDir(), silentLogger, fakeSlackApi().fetch, 0);
    await text.update({ webhookUrl: HOOK });
    expect(await text.send({ markdown: 'bug' }, PNG)).toMatchObject({ ok: true, screenshot: 'failed', screenshotError: { code: 'slack.uploadsOff' } });

    const cases: [Record<string, () => Response>, string][] = [
      [{ 'files.completeUploadExternal': () => Response.json({ ok: false, error: 'not_in_channel' }) }, 'slack.notInChannel'],
      [{ 'files.getUploadURLExternal': () => Response.json({ ok: false, error: 'token_revoked' }) }, 'slack.reconnect'],
      [{ 'conversations.join': () => Response.json({ ok: false, error: 'invalid_auth' }) }, 'slack.reconnect'],
      [{ 'files.getUploadURLExternal': () => Response.json({ ok: true, upload_url: 'https://evil.example/up', file_id: 'F0456EFGH' }) }, 'slack.uploadRejected'],
      [{ upload: () => new Response('no', { status: 500 }) }, 'slack.uploadRejected'],
      [{ 'files.completeUploadExternal': () => new Response('', { status: 429, headers: { 'Retry-After': '5' } }) }, 'slack.rateLimited'],
    ];
    for (const [answers, code] of cases) {
      const slack = fakeSlackApi(answers);
      const store = SlackStore.inDataDir(await makeTempDir(), silentLogger, slack.fetch, 0);
      await store.update({ webhookUrl: KEYED });
      expect(await store.send({ markdown: 'bug' }, PNG), code).toMatchObject({ ok: true, screenshot: 'failed', screenshotError: { code } });
      expect(slack.calls()[0]).toBe('webhook');
      expect(slack.calls()).not.toContain(code === 'slack.uploadRejected' && answers.upload ? 'files.completeUploadExternal' : 'nothing');
    }
    // A private channel refuses the join; the upload still goes when the bot was invited.
    const priv = fakeSlackApi({ 'conversations.join': () => Response.json({ ok: false, error: 'method_not_supported_for_channel_type' }) });
    const store = SlackStore.inDataDir(await makeTempDir(), silentLogger, priv.fetch, 0);
    await store.update({ webhookUrl: KEYED });
    expect(await store.send({ markdown: 'bug' }, PNG)).toEqual({ ok: true, screenshot: 'sent' });

    const gone = SlackStore.inDataDir(await makeTempDir(), silentLogger, fakeSlackApi().fetch, 0);
    await gone.update({ webhookUrl: KEYED });
    expect(await gone.send({ markdown: 'bug' }, { name: 'shot-1.png' })).toMatchObject({ screenshot: 'failed', screenshotError: { code: 'slack.screenshotGone' } });
    expect(await gone.send({ markdown: 'bug' }, { name: 'clip.mp4', data: PNG.data })).toMatchObject({ screenshot: 'failed', screenshotError: { code: 'slack.uploadRejected' } });
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

    // A screenshot named by its /api/files URL goes after the report; a missing one is reported, not thrown.
    await fetch(`${t.base}/api/slack`, { method: 'PUT', headers: json, body: JSON.stringify({ webhookUrl: KEYED }) });
    await writeFile(path.join(t.config.tempDir, 'shot-1.png'), PNG.data);
    const withShot = await fetch(`${t.base}/api/slack/send`, { method: 'POST', headers: json, body: JSON.stringify({ markdown: 'bug', screenshot: '/api/files/shot-1.png?t=1794906442164', screenshotTitle: 'Shot' }) });
    expect(await withShot.json()).toEqual({ ok: true, screenshot: 'failed', screenshotError: expect.objectContaining({ code: 'slack.uploadRejected' }) });
    const missing = await fetch(`${t.base}/api/slack/send`, { method: 'POST', headers: json, body: JSON.stringify({ markdown: 'bug', screenshot: '/api/files/gone.png' }) });
    expect(await missing.json()).toMatchObject({ ok: true, screenshot: 'failed', screenshotError: { code: 'slack.screenshotGone' } });
    const escape = await fetch(`${t.base}/api/slack/send`, { method: 'POST', headers: json, body: JSON.stringify({ markdown: 'bug', screenshot: '/api/files/..%2F..%2Fslack.json' }) });
    expect(await escape.json()).toMatchObject({ screenshot: 'failed', screenshotError: { code: 'slack.screenshotGone' } });
    await fetch(`${t.base}/api/slack`, { method: 'PUT', headers: json, body: JSON.stringify({ webhookUrl: HOOK }) });

    expect((await fetch(`${t.base}/api/slack/send`)).status).toBe(405);
    await fetch(`${t.base}/api/slack`, { method: 'PUT', headers: json, body: JSON.stringify({ webhookUrl: null }) });
    expect(await (await fetch(`${t.base}/api/slack`)).json()).toEqual({ configured: false, sender: 'Ayşe' });
  });
});

describe('retryAfterSeconds', () => {
  it('reads delta seconds and HTTP dates, capped at an hour', () => {
    expect(retryAfterSeconds('30')).toBe(30);
    expect(retryAfterSeconds('0')).toBe(1);
    expect(retryAfterSeconds('999999')).toBe(3600);
    expect(retryAfterSeconds(new Date(1_000_000 + 12_500).toUTCString(), 1_000_000)).toBe(12);
    expect(retryAfterSeconds(null)).toBeUndefined();
    expect(retryAfterSeconds('soon')).toBeUndefined();
  });
});
