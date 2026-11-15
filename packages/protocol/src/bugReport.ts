/**
 * "Report a bug": one file a developer can act on without asking back. The UI writes the report (Markdown, in the
 * user's language) and the readable log lines; the server packs them with the requests (HAR), the screenshot, an
 * iOS crash report and a Dürbün recording of the same time window into a .zip.
 *
 *   POST /api/bug-report   BugReportRequest → application/zip
 *     response header X-Durbun-Skipped: comma-separated parts that could not be added (screenshot, crashReport)
 */

/** The window around the moment: at most this long (a longer one is cut to the end of the window). */
export const BUG_REPORT_MAX_WINDOW_MS = 10 * 60_000;
/** At most this many log lines go into the report (the newest ones of the window). */
export const BUG_REPORT_MAX_LOG_LINES = 5_000;
/** At most this many requests go into the HAR (the newest ones). */
export const BUG_REPORT_MAX_REQUESTS = 500;

export interface BugReportRequest {
  /** The report (`report.md`), written by the UI in the user's language. Already masked when `mask` is on. */
  report: string;
  /** The log lines as text (`logs.txt`), as the report counted them. Already masked when `mask` is on. */
  logs?: string;
  /** Requests for `requests.har` (masked by the server unless `mask` is false). */
  requestIds?: string[];
  /** A screenshot taken for the report: the `file` of the `screenshot` action's reply (a file in the temp dir). */
  screenshot?: string;
  /** The iOS crash report the moment's line points to: its `/api/files/crash/<udid>/<name>` URL. */
  crashReport?: string;
  /** A Dürbün recording of the window (`recording.durbun.json`), scoped like GET /api/export. */
  recording?: { deviceId?: string; appId?: string; bundleId?: string; fromTs: number; toTs: number };
  /** Mask secret values in the HAR and the recording (default true). */
  mask?: boolean;
  /** File name without extension (letters, digits, "-", "_", "."); default `durbun-bug-<time>`. */
  name?: string;
}
