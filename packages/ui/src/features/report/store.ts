// Every entry point imports this store: the texts of its "Report a bug" button come with it.
import './i18n';
import { create } from 'zustand';
import type { BugAnchor } from './model';

/** The open "Report a bug" dialog: where it started and when (`openedAt` is the moment of a "now" report). */
export interface BugReportState {
  open: (BugAnchor & { openedAt: number; seq: number }) | null;
  /**
   * The note being written. It outlives the dialog until the report is saved, copied or sent: "Connect Slack" and
   * an accidental Esc close the dialog, and the next one starts with the note again.
   */
  draft: string;
}

export const useBugReport = create<BugReportState>()(() => ({ open: null, draft: '' }));

let seq = 0;

/**
 * Every entry point (crash banner and notification, a log line, a request, the palette, the top bar) opens the
 * same dialog through here, anchored to its moment.
 */
export const bugReport = {
  open(anchor: BugAnchor = { kind: 'now' }): void {
    useBugReport.setState({ open: { ...anchor, openedAt: Date.now(), seq: ++seq } });
  },
  close(): void {
    useBugReport.setState({ open: null });
  },
  setDraft(draft: string): void {
    useBugReport.setState({ draft });
  },
  /** The report left the dialog (saved, copied, sent): the next one starts empty. */
  done(): void {
    useBugReport.setState({ open: null, draft: '' });
  },
};
