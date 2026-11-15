/**
 * Help → Copy Diagnostic Info and Report an Issue… (no Electron import, so it is unit-tested). Collects what
 * a bug report needs (versions, macOS, how the app runs, ports, the tool check, the last log lines) as plain
 * text for the clipboard, with secrets masked. Nothing is sent anywhere: the user pastes it.
 */
import { REPO_URL } from './updates';

export interface DiagnosticsInput {
  app: string;
  electron: string;
  chrome: string;
  node: string;
  /** The bundled server's version (attached: the version of the Dürbün the window shows). */
  server?: string;
  macos: string;
  /** process.arch, plus the Mac's own architecture when the app runs under Rosetta. */
  arch: string;
  translated: boolean;
  packaged: boolean;
  /** 'running' (own server), 'attached' (another Dürbün), 'starting', 'failed'. */
  mode: string;
  httpPort?: number;
  sdkPort?: number;
  lan?: boolean;
  signature?: string;
  location?: string;
  warnings: readonly string[];
  /** GET /api/doctor (ToolCheck[]), when the server answered. */
  doctor?: unknown;
  logTail: string;
}

/** Masks values that should never land in a public issue: tokens, passwords, cookies, URL query values. */
export function maskSecrets(text: string): string {
  return (
    text
      // Authorization: Bearer xyz, Cookie: a=b, x-api-key: …
      .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)(\s*[:=]\s*)("?)[^\n"]*/gi, '$1$2$3••••')
      .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 ••••')
      // token=…, "password": "…", secret: …
      .replace(/\b([\w-]*(?:token|secret|password|passwd|apikey|api_key|session|sig|signature))("?\s*[:=]\s*"?)([^\s"&,;}]+)/gi, '$1$2••••')
      // ?a=1&b=2 → ?a=••••&b=••••
      .replace(/([?&][\w.%-]+=)[^&\s#"')\]]+/g, '$1••••')
      // user:pass@host
      .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1••••@')
      // Slack webhooks
      .replace(/hooks\.slack\.com\/services\/[\w/]+/gi, 'hooks.slack.com/services/••••')
  );
}

/** The last `count` lines of a log text (the first, possibly cut line of a tail read is dropped). */
export function lastLines(text: string, count: number, cutStart = false): string {
  const lines = text.split('\n');
  if (cutStart && lines.length > 1) lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-count).join('\n');
}

/** One line per tool of the server's tool check: "✓ adb 35.0.2", "✖ idevicesyslog: not found". */
export function doctorLines(doctor: unknown): string[] {
  if (!Array.isArray(doctor)) return [];
  const mark: Record<string, string> = { ok: '✓', warn: '⚠', missing: '✖', error: '✖' };
  const out: string[] = [];
  for (const c of doctor.slice(0, 40)) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    const label = typeof r.label === 'string' ? r.label : typeof r.id === 'string' ? r.id : '?';
    const status = typeof r.status === 'string' ? r.status : '?';
    const version = typeof r.version === 'string' && r.version ? ` ${r.version}` : '';
    const detail = status !== 'ok' && typeof r.detail === 'string' && r.detail ? `: ${r.detail.slice(0, 160)}` : '';
    out.push(`${mark[status] ?? '?'} ${label}${version}${detail}`);
  }
  return out;
}

/** "macOS 15.1 · arm64" (Intel build on Apple silicon: "x64 under Rosetta on arm64"). */
export function environmentLine(i: Pick<DiagnosticsInput, 'macos' | 'arch' | 'translated'>): string {
  return `macOS ${i.macos} · ${i.translated ? `${i.arch} under Rosetta on arm64` : i.arch}`;
}

export function diagnosticsText(i: DiagnosticsInput): string {
  const lines = [
    '### Dürbün diagnostic info',
    `- Mac app: ${i.app} (${i.packaged ? 'packaged' : 'development'}${i.signature ? `, ${i.signature}` : ''})`,
    `- Server: ${i.server ?? '?'} · ${i.mode}${i.httpPort ? ` · HTTP ${i.httpPort}` : ''}${i.sdkPort ? ` · SDK ${i.sdkPort}` : ''}${i.lan === undefined ? '' : ` · LAN ${i.lan ? 'on' : 'off'}`}`,
    `- Electron ${i.electron} · Chromium ${i.chrome} · Node ${i.node}`,
    `- ${environmentLine(i)}`,
  ];
  if (i.location) lines.push(`- Runs from: ${i.location}`);
  if (i.warnings.length) lines.push('', 'Warnings:', ...i.warnings.map((w) => `- ${w}`));
  const tools = doctorLines(i.doctor);
  if (tools.length) lines.push('', 'Tool check:', ...tools.map((l) => `- ${l}`));
  if (i.logTail.trim()) lines.push('', 'Last log lines:', '```text', i.logTail, '```');
  return maskSecrets(lines.join('\n')) + '\n';
}

/**
 * The bug report form, prefilled with the version and the environment (short values only: the log goes
 * through the clipboard, a URL has no room for it).
 */
export function issueUrl(i: Pick<DiagnosticsInput, 'app' | 'macos' | 'arch' | 'translated'>): string {
  const q = new URLSearchParams({ template: 'bug_report.yml', area: 'Mac app', version: i.app, environment: environmentLine(i) });
  return `${REPO_URL}/issues/new?${q.toString()}`;
}

/** Where the app runs from, without the user's home folder name. */
export function shortLocation(bundle: string | undefined, home: string): string | undefined {
  if (!bundle) return undefined;
  if (bundle.includes('/AppTranslocation/')) return 'App Translocation (opened from Downloads or the disk image)';
  if (bundle.startsWith('/Volumes/')) return 'a disk image or external volume';
  return home && bundle.startsWith(`${home}/`) ? `~${bundle.slice(home.length)}` : bundle;
}
