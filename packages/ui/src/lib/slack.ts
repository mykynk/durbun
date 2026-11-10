/**
 * Send to Slack: Slack reads "mrkdwn", not Markdown. The share reports are light Markdown (plain lines,
 * `- ` bullets, fenced blocks), so the text needs only a few changes:
 *  - `&`, `<` and `>` escaped: Slack reads `<…>` as a link or an @channel mention;
 *  - every fence becomes plain ``` (Slack knows no longer fences and shows a language name as code), and a
 *    run of backticks inside a block is broken up so it cannot close the block early;
 *  - the text is cut below Slack's 40,000-character limit, an open block closed, and a note added.
 * The Flutter in-app panel does the same (`slack.dart` in `sdks/flutter/durbun`); `slack.test.ts` and
 * `slack_test.dart` pin the same output.
 */

/** Slack cuts a message's text after 40,000 characters (the server refuses longer texts). */
export const SLACK_MAX_CHARS = 40_000;

/**
 * "Add to Slack": adds the Dürbün Slack app to a channel and shows that channel's webhook URL. The page
 * trades Slack's code for the URL in the person's own browser (PKCE, no server); the app's settings are
 * in docs/slack-app/manifest.yml.
 */
export const SLACK_ADD_URL = 'https://appnify.dev/durbun/slack/';

const FENCE_OPEN = /^(`{3,})[\w+#.-]*$/;
const ZWSP = '​';

export interface SlackTextOptions {
  /** Last line, e.g. "Sent with Dürbün · Ayşe". */
  footer?: string;
  /** Line added when the text had to be cut. */
  cutNote: string;
  /** Limit (tests). */
  maxChars?: number;
}

function escape(line: string): string {
  return line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** [line] cut to [max] characters without splitting a surrogate pair or an `&amp;` entity. */
function cutLine(line: string, max: number): string {
  let cut = Math.max(0, max);
  const code = line.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  let out = line.slice(0, cut);
  const amp = out.lastIndexOf('&');
  if (amp >= 0 && amp > out.length - 5 && !out.slice(amp).includes(';')) out = out.slice(0, amp);
  return out;
}

export function toSlackText(report: string, options: SlackTextOptions): string {
  const max = options.maxChars ?? SLACK_MAX_CHARS;
  const footer = options.footer ? ['', escape(options.footer)] : [];
  // Room for the closing fence, the note and the footer.
  const budget = max - (footer.join('\n').length + escape(options.cutNote).length + 8);
  const out: string[] = [];
  let size = 0;
  let fence: string | null = null;
  let cut = false;
  for (const raw of report.split('\n')) {
    let line: string;
    let next: string | null = fence;
    if (fence === null) {
      const open = FENCE_OPEN.exec(raw);
      if (open) next = open[1]!;
      line = open ? '```' : escape(raw);
    } else if (raw === fence) {
      next = null;
      line = '```';
    } else {
      line = escape(raw).replace(/`{3,}/g, (run) => run.split('').join(ZWSP));
    }
    const add = (out.length > 0 ? 1 : 0) + line.length;
    if (size + add > budget) {
      // A fence line is never cut: the block state stays as it was before it.
      const room = budget - size - (out.length > 0 ? 1 : 0);
      if (room > 0 && next === fence) out.push(cutLine(line, room));
      cut = true;
      break;
    }
    out.push(line);
    size += add;
    fence = next;
  }
  if (cut) {
    if (fence !== null) out.push('```');
    out.push(escape(options.cutNote));
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
  return [...out, ...footer].join('\n');
}
