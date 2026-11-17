/**
 * "Send to Slack": the desktop keeps one Slack connection (and an optional sender name) in `<dataDir>/slack.json`,
 * mode 0600 and outside settings.json (which every UI receives), and posts what the UI built — only when someone
 * clicks Send. A connection is an incoming webhook; when it comes from the Add to Slack page, Dürbün's bot token and
 * the webhook's channel follow after a `#`:
 *
 *   https://hooks.slack.com/services/T…/B…/…#token=xoxb-…&channel=C…&channel_name=%23qa
 *
 * The text always goes to the webhook. The token only uploads a bug report's screenshot to that same channel (scopes
 * files:write and channels:join: it cannot read messages, files, channels or members). Older versions take the same
 * URL and post the text only: fetch never sends a fragment. Webhook and token are secrets: they never go back to the
 * UI (GET /api/slack answers with a masked hint) and never into a log line.
 *
 *   GET  /api/slack        SlackStatus
 *   PUT  /api/slack        { webhookUrl?: string | null, sender?: string | null } → SlackStatus
 *   POST /api/slack/send   { text, screenshot?: "/api/files/<name>", screenshotTitle?: string } → SlackSendResult
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { isPlainObject, writeFileAtomic } from '../config';
import type { Logger } from '../types';
import { errorMessage, HttpError } from './util';

export const SLACK_FILE_NAME = 'slack.json';
export const SLACK_TIMEOUT_MS = 15_000;
/** Uploading a screenshot's bytes can take longer than a message on a slow link. */
export const SLACK_UPLOAD_TIMEOUT_MS = 60_000;
/** Slack cuts a message's text after 40,000 characters; the UI shortens its text to this. */
export const MAX_SLACK_TEXT_CHARS = 40_000;
export const MAX_SLACK_SENDER_CHARS = 80;
/** A phone screenshot is a few MB; anything this large is not one. */
export const MAX_SLACK_SCREENSHOT_BYTES = 50 * 1024 * 1024;
const MAX_WEBHOOK_URL_CHARS = 2_048;
const MAX_CONNECTION_URL_CHARS = 4_096;
const MAX_CHANNEL_NAME_CHARS = 80;
const MAX_TITLE_CHARS = 200;
/** Slack's answer (an error word such as `invalid_token`), as much as an error message shows. */
const MAX_ANSWER_CHARS = 200;
const SLACK_API = 'https://slack.com/api/';
const TOKEN_RE = /^xoxb-[A-Za-z0-9-]{8,250}$/;
/** A channel (C…) or an older private channel (G…); a DM (D…) gets no key from the Add to Slack page. */
const CHANNEL_RE = /^[CG][A-Z0-9]{2,30}$/;
const FILE_ID_RE = /^F[A-Z0-9]{2,30}$/;
const IMAGE_RE = /\.(png|jpe?g|heic|webp)$/i;
/**
 * Slack holds at most 12,000 characters of `markdown` blocks in one message; a part stays under that with room for
 * the code fence a split closes and reopens.
 */
export const MAX_SLACK_MARKDOWN_PART_CHARS = 11_000;
/** Between the parts of a long report: Slack takes about one message a second per webhook. */
export const SLACK_PART_GAP_MS = 1_100;
/** A webhook's answer when the workspace does not take the `markdown` block: the report then goes as plain text. */
const BLOCKS_REFUSED = /invalid_blocks|invalid_payload|no_text|invalid_attachments|msg_too_long|msg_blocks_too_long|too_many_blocks/;
const NOTIFICATION_CHARS = 150;

export interface SlackStatus {
  configured: boolean;
  /** "hooks.slack.com · …wxyz": enough to recognize the webhook, too little to use it. */
  hint?: string;
  /** Name shown under each message ("Dürbün · Ayşe"). */
  sender?: string;
  /** A bug report's screenshot can go too: the connection carries Dürbün's bot token. */
  uploads?: boolean;
  /** "#qa": the connection's channel, when Slack named it. */
  channel?: string;
}

export interface SlackPatch {
  webhookUrl?: string | null;
  sender?: string | null;
}

/** A webhook, plus Dürbün's bot token and the webhook's channel when the URL carried them after `#`. */
export interface SlackConnection {
  webhookUrl: string;
  token?: string;
  channelId?: string;
  channelName?: string;
}

/** A screenshot to upload after the text; `data` is undefined when the file is gone (temp-dir cleanup). */
export interface SlackScreenshot {
  /** The file's name, for its type ("…png"). */
  name: string;
  data?: Buffer;
  /** Its size on disk when it was too large to read. */
  size?: number;
  /** The title Slack shows above the image. */
  title?: string;
}

/** What POST /api/slack/send answers: the text went; `screenshot` only when one was asked for. */
export interface SlackSendResult {
  ok: true;
  screenshot?: 'sent' | 'failed';
  /** Why the screenshot did not go (the text did), as an error body: code + English message. */
  screenshotError?: { code: string; message: string };
}

interface SlackFile extends Partial<SlackConnection> {
  sender?: string;
}

export function slackHint(url: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname.replace(/\/+$/, '').slice(-4);
    return tail ? `${u.host} · …${tail}` : u.host;
  } catch {
    return '…';
  }
}

/** A webhook URL the desktop may post to, or an HttpError ('slack.invalidUrl'). */
export function validateWebhookUrl(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  let url: URL | undefined;
  try {
    url = text.length <= MAX_WEBHOOK_URL_CHARS ? new URL(text) : undefined;
  } catch {
    url = undefined;
  }
  // https only: the URL is the secret, plain http would send it in the clear.
  if (!url || url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new HttpError(400, 'The webhook URL must start with https://', 'slack.invalidUrl');
  }
  return url.toString();
}

/**
 * A connection URL (a webhook, optionally followed by `#token=…&channel=…&channel_name=…`) or an HttpError:
 * 'slack.invalidUrl' for the webhook, 'slack.invalidKey' for a key after `#` that is cut or altered. A fragment
 * without a token or channel is not a key and is dropped.
 */
export function parseConnection(raw: unknown): SlackConnection {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const hash = text.indexOf('#');
  const webhookUrl = validateWebhookUrl(hash === -1 ? text : text.slice(0, hash));
  if (hash === -1) return { webhookUrl };
  if (text.length > MAX_CONNECTION_URL_CHARS) throw invalidKey();
  const params = new URLSearchParams(text.slice(hash + 1));
  const token = params.get('token');
  const channelId = params.get('channel');
  if (token === null && channelId === null) return { webhookUrl };
  if (!token || !TOKEN_RE.test(token) || !channelId || !CHANNEL_RE.test(channelId)) throw invalidKey();
  const channelName = cleanChannelName(params.get('channel_name'));
  return { webhookUrl, token, channelId, ...(channelName ? { channelName } : {}) };
}

/** The URL [parseConnection] reads back: the webhook, with the key after `#` when there is one. */
export function connectionUrl(c: SlackConnection): string {
  if (!c.token || !c.channelId) return c.webhookUrl;
  const params = new URLSearchParams({ token: c.token, channel: c.channelId, ...(c.channelName ? { channel_name: c.channelName } : {}) });
  return `${c.webhookUrl}#${params.toString()}`;
}

function invalidKey(): HttpError {
  return new HttpError(400, 'The part after # in the Slack URL is incomplete; copy the whole URL again', 'slack.invalidKey');
}

function oneLine(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return text || undefined;
}

function cleanSender(raw: unknown): string | undefined {
  return oneLine(raw, MAX_SLACK_SENDER_CHARS);
}

function cleanChannelName(raw: unknown): string | undefined {
  return oneLine(raw, MAX_CHANNEL_NAME_CHARS);
}

export type SlackFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Slack API error words that mean the key no longer works: the app was removed, or the key predates a scope. */
const RECONNECT_ERRORS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'missing_scope', 'not_allowed_token_type']);
/** …and the ones that mean the bot is not in the (private) channel. */
const NOT_IN_CHANNEL_ERRORS = new Set(['not_in_channel', 'channel_not_found', 'no_permission']);

export class SlackStore {
  private config: SlackFile = {};
  private loaded: Promise<void> | undefined;
  private writes: Promise<void> = Promise.resolve();
  /** Channels the bot joined (or was already in) since launch: one conversations.join per channel is enough. */
  private readonly joined = new Set<string>();

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
    private readonly fetchImpl: SlackFetch = fetch,
    /** Pause between the parts of a long report (tests: 0). */
    private readonly partGapMs = SLACK_PART_GAP_MS,
  ) {}

  static inDataDir(dataDir: string, logger: Logger, fetchImpl?: SlackFetch, partGapMs?: number): SlackStore {
    return new SlackStore(path.join(dataDir, SLACK_FILE_NAME), logger, fetchImpl, partGapMs);
  }

  /** Reads the file once; a missing or broken file is an empty config (never throws). */
  private ready(): Promise<void> {
    this.loaded ??= fsp.readFile(this.file, 'utf8').then(
      (text) => {
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          this.logger.warn(`${SLACK_FILE_NAME} is not valid JSON; Slack is not connected`);
          return;
        }
        if (!isPlainObject(raw)) return;
        let conn: SlackConnection | undefined;
        if (raw.webhookUrl !== undefined) {
          // parseConnection, not validateWebhookUrl: an older version may have saved a URL with the key after #.
          try {
            conn = parseConnection(raw.webhookUrl);
          } catch {
            this.logger.warn(`${SLACK_FILE_NAME} has an unusable webhook URL; Slack is not connected`);
          }
        }
        if (conn && !conn.token && (raw.token !== undefined || raw.channelId !== undefined)) {
          const { token, channelId } = raw;
          if (typeof token === 'string' && TOKEN_RE.test(token) && typeof channelId === 'string' && CHANNEL_RE.test(channelId)) {
            const channelName = cleanChannelName(raw.channelName);
            conn = { ...conn, token, channelId, ...(channelName ? { channelName } : {}) };
          } else {
            this.logger.warn(`${SLACK_FILE_NAME} has an unusable Slack key; screenshots stay off`);
          }
        }
        this.config = { ...conn, sender: cleanSender(raw.sender) };
      },
      (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') this.logger.warn(`could not read ${SLACK_FILE_NAME}: ${err.message}`);
      },
    );
    return this.loaded;
  }

  async status(): Promise<SlackStatus> {
    await this.ready();
    const { webhookUrl, token, channelName, sender } = this.config;
    return {
      configured: !!webhookUrl,
      ...(webhookUrl ? { hint: slackHint(webhookUrl) } : {}),
      ...(sender ? { sender } : {}),
      ...(webhookUrl && token ? { uploads: true } : {}),
      ...(webhookUrl && channelName ? { channel: channelName } : {}),
    };
  }

  /** The stored connection (as one URL, key included) and sender, for an encrypted backup (never sent to the UI). */
  async secrets(): Promise<{ webhookUrl?: string; sender?: string }> {
    await this.ready();
    const { webhookUrl, sender } = this.config;
    return { ...(webhookUrl ? { webhookUrl: connectionUrl({ ...this.config, webhookUrl }) } : {}), ...(sender ? { sender } : {}) };
  }

  /** `null` (or an empty string) removes a value; a missing key keeps it. A new webhook replaces the whole connection. */
  async update(raw: unknown): Promise<SlackStatus> {
    await this.ready();
    if (!isPlainObject(raw)) throw new HttpError(400, 'Expected an object', 'slack.invalid');
    const next: SlackFile = { ...this.config };
    if ('webhookUrl' in raw) {
      const v = raw.webhookUrl;
      const conn = v === null || v === '' ? undefined : parseConnection(v);
      next.webhookUrl = conn?.webhookUrl;
      next.token = conn?.token;
      next.channelId = conn?.channelId;
      next.channelName = conn?.channelName;
      this.joined.clear();
    }
    if ('sender' in raw) next.sender = raw.sender === null ? undefined : cleanSender(raw.sender);
    this.config = next;
    const saved: SlackFile = { webhookUrl: next.webhookUrl, token: next.token, channelId: next.channelId, channelName: next.channelName, sender: next.sender };
    const data = JSON.stringify(saved, null, 2) + '\n';
    const write = this.writes.then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.file, data);
    });
    this.writes = write.catch(() => {});
    try {
      await write;
    } catch (err) {
      throw new HttpError(500, `Could not save the Slack settings: ${errorMessage(err)}`, 'slack.saveFailed');
    }
    return this.status();
  }

  /**
   * Posts the report to the webhook, then uploads [screenshot] to the same channel when one is given.
   *
   * `{ markdown }` goes as one message of Slack's rich text, as a report pasted into Slack shows: lists, quotes and
   * code blocks with their language, however long. When Slack refuses that block it goes as `markdown` blocks, split
   * into several messages when longer than one holds (every code block closed and reopened at a split), and when it
   * refuses those too, as `{ text }` (Slack mrkdwn), which is also the plain message on its own. Link previews stay
   * off: URLs in a report may be internal. A screenshot that does not go fails softly: the report is already in the
   * channel, so the answer says what happened to the image instead of throwing.
   */
  async send(raw: unknown, screenshot?: SlackScreenshot): Promise<SlackSendResult> {
    await this.ready();
    const body = isPlainObject(raw) ? raw : {};
    const text = typeof body.text === 'string' ? body.text : '';
    const markdown = typeof body.markdown === 'string' ? body.markdown : '';
    if ((!text.trim() && !markdown.trim()) || text.length > MAX_SLACK_TEXT_CHARS || markdown.length > MAX_SLACK_TEXT_CHARS) {
      throw new HttpError(400, 'The message to send is empty or too long', 'slack.invalid');
    }
    const url = this.config.webhookUrl;
    if (!url) throw new HttpError(409, 'Slack is not connected', 'slack.notConfigured');
    if (markdown.trim()) await this.postRichText(url, markdown, text);
    else await this.postText(url, text);
    if (!screenshot) return { ok: true };
    try {
      await this.sendScreenshot(screenshot);
      return { ok: true, screenshot: 'sent' };
    } catch (err) {
      const e = err instanceof HttpError ? err : new HttpError(502, `Slack refused the screenshot: ${errorMessage(err)}`, 'slack.uploadRejected');
      this.logger.warn(`Slack screenshot not sent: ${e.message}`);
      return { ok: true, screenshot: 'failed', screenshotError: { code: e.code ?? 'slack.uploadRejected', message: e.message } };
    }
  }

  private async postText(url: string, text: string): Promise<void> {
    const res = await this.postJson(url, { text, unfurl_links: false, unfurl_media: false });
    this.checkWebhook(res, '');
  }

  private async postRichText(url: string, markdown: string, fallbackText: string): Promise<void> {
    const res = await this.postJson(url, {
      // Notifications and clients without blocks show `text`; the message itself is the block.
      text: notificationText(markdown),
      blocks: [markdownToRichText(markdown)],
      unfurl_links: false,
      unfurl_media: false,
    });
    if (res.status === 400 && BLOCKS_REFUSED.test(res.answer)) {
      this.logger.warn(`Slack refused the rich text message (${res.answer}); sending it as Markdown`);
      return this.postMarkdown(url, markdown, fallbackText);
    }
    this.checkWebhook(res, '');
  }

  private async postMarkdown(url: string, markdown: string, fallbackText: string): Promise<void> {
    const parts = slackMarkdownChunks(markdown);
    const note = notificationText(markdown);
    for (let i = 0; i < parts.length; i++) {
      // About one message a second per webhook: the parts of a long report go just under that pace.
      if (i > 0 && this.partGapMs > 0) await new Promise((resolve) => setTimeout(resolve, this.partGapMs));
      const of = parts.length > 1 ? ` (${i + 1}/${parts.length})` : '';
      const res = await this.postJson(url, {
        text: `${note}${of}`,
        blocks: [{ type: 'markdown', text: parts[i] }],
        unfurl_links: false,
        unfurl_media: false,
      });
      if (i === 0 && res.status === 400 && fallbackText.trim() && BLOCKS_REFUSED.test(res.answer)) {
        this.logger.warn(`Slack refused the Markdown message (${res.answer}); sending it as plain text`);
        return this.postText(url, fallbackText);
      }
      this.checkWebhook(res, parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : '');
    }
  }

  private async postJson(url: string, payload: unknown): Promise<{ status: number; ok: boolean; answer: string; retryAfter: string | null }> {
    const res = await this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
    const answer = (await res.text().catch(() => '')).trim().slice(0, MAX_ANSWER_CHARS);
    return { status: res.status, ok: res.ok, answer, retryAfter: res.headers.get('retry-after') };
  }

  private checkWebhook(res: { status: number; ok: boolean; answer: string; retryAfter: string | null }, part: string): void {
    if (res.status === 429) throw this.rateLimited(res.retryAfter);
    if (!res.ok) {
      this.logger.warn(`Slack refused a message${part}: HTTP ${res.status} ${res.answer}`);
      throw new HttpError(502, `Slack refused the message: ${res.answer || `HTTP ${res.status}`}${part}`, 'slack.rejected');
    }
  }

  /** files.getUploadURLExternal → the bytes → files.completeUploadExternal into the connection's channel. */
  private async sendScreenshot(shot: SlackScreenshot): Promise<void> {
    const { token, channelId } = this.config;
    if (!token || !channelId) {
      throw new HttpError(409, 'This Slack connection sends text only; add Dürbün to Slack again to send screenshots', 'slack.uploadsOff');
    }
    if ((shot.size ?? shot.data?.length ?? 0) > MAX_SLACK_SCREENSHOT_BYTES) {
      throw new HttpError(413, `Slack refused the screenshot: larger than ${MAX_SLACK_SCREENSHOT_BYTES / 1024 / 1024} MB`, 'slack.uploadRejected');
    }
    const data = shot.data;
    if (!data?.length) throw new HttpError(410, 'The screenshot is no longer on this Mac', 'slack.screenshotGone');
    if (!IMAGE_RE.test(shot.name)) throw new HttpError(400, 'Slack refused the screenshot: only a PNG, JPEG, HEIC or WebP image can go', 'slack.uploadRejected');

    if (!this.joined.has(channelId)) {
      // A public channel: join it so the file can be shared there (channels:join; harmless when already in). A
      // private channel answers method_not_supported_for_channel_type: someone has to invite the bot, and
      // completeUploadExternal says so below.
      try {
        await this.callApi(token, 'conversations.join', { channel: channelId });
        this.joined.add(channelId);
      } catch (err) {
        const code = err instanceof HttpError ? err.code : undefined;
        if (code === 'slack.unreachable' || code === 'slack.rateLimited' || code === 'slack.reconnect') throw err;
      }
    }

    const ext = IMAGE_RE.exec(shot.name)?.[0]?.toLowerCase() ?? '.png';
    const got = await this.callApi(token, 'files.getUploadURLExternal', { filename: `screenshot${ext}`, length: String(data.length) });
    const uploadUrl = typeof got.upload_url === 'string' ? got.upload_url : '';
    const fileId = typeof got.file_id === 'string' ? got.file_id : '';
    if (!isSlackHost(uploadUrl) || !FILE_ID_RE.test(fileId)) {
      throw new HttpError(502, 'Slack refused the screenshot: unexpected upload answer', 'slack.uploadRejected');
    }
    const res = await this.request(
      uploadUrl,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) },
      SLACK_UPLOAD_TIMEOUT_MS,
    );
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 429) throw this.rateLimited(res.headers.get('retry-after'));
    if (!res.ok) throw new HttpError(502, `Slack refused the screenshot: HTTP ${res.status}`, 'slack.uploadRejected');
    const title = oneLine(shot.title, MAX_TITLE_CHARS) ?? 'Screenshot';
    await this.callApi(token, 'files.completeUploadExternal', { files: JSON.stringify([{ id: fileId, title }]), channel_id: channelId });
  }

  /** A Slack Web API method with the bot token; its `error` word becomes an HttpError the UI can explain. */
  private async callApi(token: string, method: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.request(SLACK_API + method, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: new URLSearchParams(form).toString(),
    });
    if (res.status === 429) throw this.rateLimited(res.headers.get('retry-after'));
    const body: unknown = await res.json().catch(() => undefined);
    if (isPlainObject(body) && body.ok === true) return body;
    const word = isPlainObject(body) && typeof body.error === 'string' ? body.error.slice(0, MAX_ANSWER_CHARS) : `HTTP ${res.status}`;
    if (RECONNECT_ERRORS.has(word)) {
      throw new HttpError(409, `Slack no longer accepts Dürbün's screenshot key: ${word}`, 'slack.reconnect');
    }
    if (NOT_IN_CHANNEL_ERRORS.has(word)) {
      throw new HttpError(409, `Dürbün is not in the Slack channel: ${word}`, 'slack.notInChannel');
    }
    throw new HttpError(502, `Slack refused the screenshot: ${word}`, 'slack.uploadRejected');
  }

  /** fetch with Slack's rules: no redirects (they would carry the message elsewhere), a timeout, readable errors. */
  private async request(url: string, init: RequestInit, timeoutMs = SLACK_TIMEOUT_MS): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const e = err as Error;
      const why = e.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} s` : causeText(e);
      this.logger.warn(`Slack send failed: ${why}`);
      throw new HttpError(502, `Could not reach Slack: ${why}`, 'slack.unreachable');
    }
  }

  /**
   * Slack allows about one message a second per webhook; Retry-After says how long to wait (half a minute when it is
   * missing). The UI shows the "30 s" after the colon.
   */
  private rateLimited(retryAfter: string | null): HttpError {
    const seconds = retryAfterSeconds(retryAfter) ?? 30;
    this.logger.warn(`Slack is rate limiting messages (retry after ${seconds} s)`);
    return new HttpError(429, `Slack is limiting messages: ${seconds} s`, 'slack.rateLimited');
  }
}

const FENCE_OPEN = /^```([\w+#.-]*)\s*$/;

/**
 * [markdown] in parts of at most [limit] characters, cut at line ends. A code block open at a cut is closed at the
 * end of one part and reopened, with its language, at the start of the next, so every part renders on its own. A
 * line longer than a part (a minified JSON body) is cut into pieces, never inside a surrogate pair.
 */
export function slackMarkdownChunks(markdown: string, limit = MAX_SLACK_MARKDOWN_PART_CHARS): string[] {
  const parts: string[] = [];
  /** The open block's fence line ("```json") where the part being built ends, or null outside one. */
  let open: string | null = null;
  let cur: string[] = [];
  let size = 0;
  /** Whether the part began by reopening the block the previous part closed. */
  let reopened = false;
  const add = (line: string) => {
    size += (cur.length ? 1 : 0) + line.length;
    cur.push(line);
  };
  /** Whether the part holds more than a reopened fence (or blank lines). */
  const hasContent = () => cur.slice(reopened ? 1 : 0).some((l) => l.trim());
  const trimEnd = () => {
    while (cur.length && !cur[cur.length - 1]!.trim()) cur.pop();
  };
  const finish = () => {
    trimEnd();
    let close = open !== null;
    // A block opened on the part's last line moves whole to the next part: no empty block at the end of this one.
    if (open !== null && cur.length > (reopened ? 1 : 0) && cur[cur.length - 1] === open && !(reopened && cur.length === 1)) {
      cur.pop();
      trimEnd();
      close = false;
    }
    if (hasContent()) parts.push(close ? `${cur.join('\n')}\n\`\`\`` : cur.join('\n'));
    reopened = open !== null;
    cur = open !== null ? [open] : [];
    size = open !== null ? open.length : 0;
  };
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const closes: boolean = open !== null && line.trim() === '```';
    const next: string | null = open === null ? (FENCE_OPEN.test(line) ? line.trim() : null) : closes ? null : open;
    // Inside a block a part keeps 4 characters for the closing fence; the closing fence itself may use them.
    const max = open !== null && !closes ? limit - 4 : limit;
    const fits = (text: string) => size + (cur.length ? 1 : 0) + text.length <= max;
    // No blank line opens a part.
    if (!line.trim() && !hasContent() && open === null) continue;
    if (!fits(line) && hasContent()) finish();
    if (fits(line)) {
      add(line);
    } else {
      // Longer than a whole part: cut it into pieces, each ending a part.
      let rest = line;
      while (rest.length) {
        const free = max - size - (cur.length ? 1 : 0);
        if (rest.length <= free) {
          add(rest);
          break;
        }
        let cut = Math.max(1, free);
        const code = rest.charCodeAt(cut - 1);
        if (cut > 1 && code >= 0xd800 && code <= 0xdbff) cut--;
        add(rest.slice(0, cut));
        rest = rest.slice(cut);
        finish();
      }
    }
    open = next;
  }
  // The UI closes its own blocks; one still open here gets its fence so the last part renders.
  finish();
  return parts;
}

/** The report's first line as a notification ("GET https://… → 200 OK"): no Markdown marks, mrkdwn-escaped. */
export function notificationText(markdown: string): string {
  let inBlock = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inBlock = !inBlock;
      continue;
    }
    if (inBlock || !line) continue;
    const plain = line.replace(/^(#{1,6}\s+|[-*+]\s+|>\s*)/, '').replace(/[*_`~]/g, '').trim();
    if (!plain) continue;
    let end = NOTIFICATION_CHARS - 1;
    // Never half an emoji: a cut after a high surrogate takes one character less.
    const code = plain.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
    const cut = plain.length > NOTIFICATION_CHARS ? `${plain.slice(0, end)}…` : plain;
    return cut.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  return 'Dürbün';
}

type RichStyle = { bold?: true; italic?: true; code?: true };
type RichInline = { type: 'text'; text: string; style?: RichStyle } | { type: 'link'; url: string; text?: string; style?: RichStyle };
type RichElement =
  | { type: 'rich_text_section'; elements: RichInline[] }
  | { type: 'rich_text_quote'; elements: RichInline[] }
  | { type: 'rich_text_list'; style: 'bullet' | 'ordered'; elements: { type: 'rich_text_section'; elements: RichInline[] }[] }
  | { type: 'rich_text_preformatted'; elements: { type: 'text'; text: string }[]; language?: string; border: 0 };
export interface RichTextBlock {
  type: 'rich_text';
  elements: RichElement[];
}

/** `code`, **bold**, a URL, _italic_ (a whole word or more). */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s<>`"]+)|((?<![\p{L}\p{N}_])_[^_\n]+_(?![\p{L}\p{N}_]))/gu;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

/** One line of report text as rich text runs: links stay links, the few marks the reports use become styles. */
export function richInline(line: string, base?: RichStyle): RichInline[] {
  const out: RichInline[] = [];
  const text = (t: string, style?: RichStyle) => {
    if (!t) return;
    const s = { ...base, ...style };
    out.push(Object.keys(s).length ? { type: 'text', text: t, style: s } : { type: 'text', text: t });
  };
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    const at = m.index ?? 0;
    text(line.slice(last, at));
    if (m[1]) text(m[1].slice(1, -1), { code: true });
    else if (m[2]) text(m[2].slice(2, -2), { bold: true });
    else if (m[4]) text(m[4].slice(1, -1), { italic: true });
    else if (m[3]) {
      // "(https://x.example/a)." — the closing punctuation is the sentence's, not the URL's.
      const url = m[3].replace(/[).,;:!?'\]]+$/, '');
      out.push(base ? { type: 'link', url, style: base } : { type: 'link', url });
      text(m[3].slice(url.length));
    }
    last = at + m[0].length;
  }
  text(line.slice(last));
  return out;
}

/**
 * The report's light Markdown as one rich text block, the way Slack shows a report pasted into it: paragraphs,
 * `##` headings (bold), `>` quotes, `-` / `1.` lists, and code blocks with their language (Slack highlights them). A
 * blank line ends a paragraph. Plain text runs need no escaping: rich text reads no `<…>` links or mentions.
 */
export function markdownToRichText(markdown: string): RichTextBlock {
  const elements: RichElement[] = [];
  const lines = markdown.split('\n').map((l) => l.replace(/\r$/, ''));
  /** Lines of the paragraph being gathered; a blank line after it becomes its trailing newline. */
  let para: string[] = [];
  const endPara = (blankAfter: boolean) => {
    if (!para.length) return;
    const runs: RichInline[] = [];
    para.forEach((l, i) => {
      runs.push(...richInline(l));
      if (i < para.length - 1) runs.push({ type: 'text', text: '\n' });
    });
    if (blankAfter) runs.push({ type: 'text', text: '\n' });
    if (runs.length) elements.push({ type: 'rich_text_section', elements: runs });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      endPara(false);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() !== '```') body.push(lines[j++]!);
      // Slack refuses an empty text run: an empty block keeps one space.
      const code = body.join('\n') || ' ';
      const language = fence[1]?.toLowerCase();
      elements.push({ type: 'rich_text_preformatted', elements: [{ type: 'text', text: code }], ...(language ? { language } : {}), border: 0 });
      i = j;
      continue;
    }
    if (!line.trim()) {
      endPara(true);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endPara(false);
      elements.push({ type: 'rich_text_section', elements: richInline(heading[1]!.trim(), { bold: true }) });
      continue;
    }
    if (QUOTE.test(line)) {
      endPara(false);
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(QUOTE.exec(lines[i++]!)![1]!);
      i--;
      const runs: RichInline[] = [];
      quoted.forEach((l, k) => {
        runs.push(...richInline(l));
        if (k < quoted.length - 1) runs.push({ type: 'text', text: '\n' });
      });
      if (runs.length) elements.push({ type: 'rich_text_quote', elements: runs });
      continue;
    }
    const item = BULLET.exec(line) ?? ORDERED.exec(line);
    if (item) {
      endPara(false);
      const style = BULLET.test(line) ? 'bullet' : 'ordered';
      const pattern = style === 'bullet' ? BULLET : ORDERED;
      const items: { type: 'rich_text_section'; elements: RichInline[] }[] = [];
      while (i < lines.length && pattern.test(lines[i]!)) {
        const runs = richInline(pattern.exec(lines[i++]!)![1]!);
        if (runs.length) items.push({ type: 'rich_text_section', elements: runs });
      }
      i--;
      if (items.length) elements.push({ type: 'rich_text_list', style, elements: items });
      continue;
    }
    para.push(line);
  }
  endPara(false);
  if (!elements.length) elements.push({ type: 'rich_text_section', elements: [{ type: 'text', text: ' ' }] });
  return { type: 'rich_text', elements };
}

/** Slack's own upload host (files.slack.com): the screenshot's bytes go nowhere else. */
function isSlackHost(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && (u.hostname === 'slack.com' || u.hostname.endsWith('.slack.com'));
  } catch {
    return false;
  }
}

/** Retry-After as whole seconds (delta seconds or an HTTP date); undefined when missing or unreadable. */
export function retryAfterSeconds(raw: string | null, now = Date.now()): number | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Math.min(Number(v), 3600) || 1;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(1, Math.ceil((at - now) / 1000)), 3600);
}

/** "getaddrinfo ENOTFOUND hooks.slack.com" rather than fetch's bare "fetch failed". */
function causeText(err: Error): string {
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return errorMessage(err);
}
