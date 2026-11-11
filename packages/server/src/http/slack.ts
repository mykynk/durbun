/**
 * "Send to Slack": the desktop keeps one Slack incoming webhook (and an optional sender name) in
 * `<dataDir>/slack.json`, mode 0600 and outside settings.json (which every UI receives), and posts the text
 * the UI built to it — only when someone clicks Send. The webhook URL is a secret: it never goes back to the
 * UI (GET /api/slack answers with a masked hint) and never into a log line.
 *
 *   GET  /api/slack        SlackStatus
 *   PUT  /api/slack        { webhookUrl?: string | null, sender?: string | null } → SlackStatus
 *   POST /api/slack/send   { text } → { ok: true }
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { isPlainObject, writeFileAtomic } from '../config';
import type { Logger } from '../types';
import { errorMessage, HttpError } from './util';

export const SLACK_FILE_NAME = 'slack.json';
export const SLACK_TIMEOUT_MS = 15_000;
/** Slack cuts a message's text after 40,000 characters; the UI shortens its text to this. */
export const MAX_SLACK_TEXT_CHARS = 40_000;
export const MAX_SLACK_SENDER_CHARS = 80;
const MAX_WEBHOOK_URL_CHARS = 2_048;
/** Slack's answer (an error word such as `invalid_token`), as much as an error message shows. */
const MAX_ANSWER_CHARS = 200;

export interface SlackStatus {
  configured: boolean;
  /** "hooks.slack.com · …wxyz": enough to recognize the webhook, too little to use it. */
  hint?: string;
  /** Name shown under each message ("Dürbün · Ayşe"). */
  sender?: string;
}

export interface SlackPatch {
  webhookUrl?: string | null;
  sender?: string | null;
}

interface SlackFile {
  webhookUrl?: string;
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

function cleanSender(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SLACK_SENDER_CHARS);
  return text || undefined;
}

export type SlackFetch = (url: string, init: RequestInit) => Promise<Response>;

export class SlackStore {
  private config: SlackFile = {};
  private loaded: Promise<void> | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
    private readonly fetchImpl: SlackFetch = fetch,
  ) {}

  static inDataDir(dataDir: string, logger: Logger, fetchImpl?: SlackFetch): SlackStore {
    return new SlackStore(path.join(dataDir, SLACK_FILE_NAME), logger, fetchImpl);
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
        let webhookUrl: string | undefined;
        try {
          webhookUrl = raw.webhookUrl === undefined ? undefined : validateWebhookUrl(raw.webhookUrl);
        } catch {
          this.logger.warn(`${SLACK_FILE_NAME} has an unusable webhook URL; Slack is not connected`);
        }
        this.config = { webhookUrl, sender: cleanSender(raw.sender) };
      },
      (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') this.logger.warn(`could not read ${SLACK_FILE_NAME}: ${err.message}`);
      },
    );
    return this.loaded;
  }

  async status(): Promise<SlackStatus> {
    await this.ready();
    const { webhookUrl, sender } = this.config;
    return { configured: !!webhookUrl, ...(webhookUrl ? { hint: slackHint(webhookUrl) } : {}), ...(sender ? { sender } : {}) };
  }

  /** The stored webhook and sender, for an encrypted backup (never sent to the UI). */
  async secrets(): Promise<{ webhookUrl?: string; sender?: string }> {
    await this.ready();
    return { ...this.config };
  }

  /** `null` (or an empty string) removes a value; a missing key keeps it. */
  async update(raw: unknown): Promise<SlackStatus> {
    await this.ready();
    if (!isPlainObject(raw)) throw new HttpError(400, 'Expected an object', 'slack.invalid');
    const next: SlackFile = { ...this.config };
    if ('webhookUrl' in raw) {
      const v = raw.webhookUrl;
      next.webhookUrl = v === null || v === '' ? undefined : validateWebhookUrl(v);
    }
    if ('sender' in raw) next.sender = raw.sender === null ? undefined : cleanSender(raw.sender);
    this.config = next;
    const data = JSON.stringify({ webhookUrl: next.webhookUrl, sender: next.sender }, null, 2) + '\n';
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

  /** Posts [text] (Slack mrkdwn) to the webhook. Link previews stay off: URLs in a report may be internal. */
  async send(raw: unknown): Promise<void> {
    await this.ready();
    const text = isPlainObject(raw) && typeof raw.text === 'string' ? raw.text : '';
    if (!text.trim() || text.length > MAX_SLACK_TEXT_CHARS) throw new HttpError(400, 'The message to send is empty or too long', 'slack.invalid');
    const url = this.config.webhookUrl;
    if (!url) throw new HttpError(409, 'Slack is not connected', 'slack.notConfigured');
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
        // A redirect would carry the message somewhere the user did not set.
        redirect: 'error',
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as Error;
      const why = e.name === 'TimeoutError' ? `no answer in ${SLACK_TIMEOUT_MS / 1000} s` : causeText(e);
      this.logger.warn(`Slack send failed: ${why}`);
      throw new HttpError(502, `Could not reach Slack: ${why}`, 'slack.unreachable');
    }
    const answer = (await res.text().catch(() => '')).trim().slice(0, MAX_ANSWER_CHARS);
    if (!res.ok) {
      this.logger.warn(`Slack refused a message: HTTP ${res.status} ${answer}`);
      throw new HttpError(502, `Slack refused the message: ${answer || `HTTP ${res.status}`}`, 'slack.rejected');
    }
  }
}

/** "getaddrinfo ENOTFOUND hooks.slack.com" rather than fetch's bare "fetch failed". */
function causeText(err: Error): string {
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return errorMessage(err);
}
