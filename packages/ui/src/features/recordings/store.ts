// Every entry point imports this store: the texts of the recordings come with it.
import './i18n';
import { create } from 'zustand';
import type { LogEntry, SessionRecording, SessionRecordingList, SessionRecordingOpen } from '@durbun/protocol';
import { api, getScope, onResync, onServerMessage, reconnectFresh, setScope, ui, useUi, ALL_SCOPE, type Scope } from '../../data';
import { validateScope } from '../../data/dispatch';
import { currentView, setCurrentView } from '../../data/view';
import { clearDetailCache } from '../network/detailCache';
import { toast } from '../../components/Toast';
import { errorText, t } from '../../i18n';
import { markOfferSeen } from './model';

/**
 * Session recordings in this window (SPEC §13): the list and the recorder's status (GET /api/recordings, refreshed
 * when the dialog or the Settings section shows it and whenever the recorder says something), the open dialog, and
 * which recording this window shows instead of the live data.
 *
 * Showing a recording: POST /api/recordings/:id/open loads it on the server, then the socket reconnects with
 * `view=<id>` (data/view.ts) and the stores fill from the recording's own snapshot. Nothing of it is mixed into the
 * live data, which goes on being captured (and recorded) meanwhile; "Back to live" reconnects without `view` and
 * puts back the scope the window had.
 */
export interface RecordingsState {
  list: SessionRecordingList | null;
  loading: boolean;
  error: string | null;
  dialog: boolean;
  /** The recording being opened (its row shows a spinner). */
  opening: string | null;
  /** The recording this window shows (null: the live data). */
  viewing: { recording: SessionRecording; opened: SessionRecordingOpen } | null;
  /** The launch offer was closed in this window (also remembered per recording, model.ts). */
  offerClosed: boolean;
}

export const useRecordings = create<RecordingsState>()(() => ({
  list: null,
  loading: false,
  error: null,
  dialog: false,
  opening: null,
  viewing: null,
  offerClosed: false,
}));

let inflight: Promise<void> | null = null;
let again = false;
/** The live scope while a recording is shown; put back once the live snapshot arrived. */
let liveScope: Scope | null = null;
let restoreScope = false;

/** Tabs that act on live devices: opening a recording from there shows its logs instead. */
const LIVE_ONLY_TABS = new Set(['device', 'flows']);

async function load(): Promise<void> {
  useRecordings.setState({ loading: true });
  try {
    const list = await api.listRecordings();
    useRecordings.setState({ list, loading: false, error: null });
  } catch (err) {
    useRecordings.setState({ loading: false, error: errorText(err) });
  }
}

export const recordings = {
  /** Fetch the list again (coalesced: a call while one runs fetches once more afterwards). */
  refresh(): Promise<void> {
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = load().finally(() => {
      inflight = null;
      if (again) {
        again = false;
        void recordings.refresh();
      }
    });
    return inflight;
  },

  openDialog(): void {
    useRecordings.setState({ dialog: true });
    useUi.setState({ palette: false });
    void recordings.refresh();
  },

  closeDialog(): void {
    useRecordings.setState({ dialog: false });
  },

  closeOffer(id?: string): void {
    if (id) markOfferSeen(id);
    useRecordings.setState({ offerClosed: true });
  },

  /** Show a recording in this window instead of the live data. */
  async open(id: string): Promise<boolean> {
    if (useRecordings.getState().opening) return false;
    useRecordings.setState({ opening: id });
    let opened: SessionRecordingOpen;
    try {
      opened = await api.openRecording(id);
    } catch (err) {
      useRecordings.setState({ opening: null });
      toast.error(t('recordings.openFailed'), { description: errorText(err) });
      void recordings.refresh();
      return false;
    }
    const wasLive = !currentView();
    if (wasLive) liveScope = getScope();
    const previous = currentView();
    setCurrentView(id);
    restoreScope = false;
    useRecordings.setState({ opening: null, dialog: false, offerClosed: true, viewing: { recording: opened.recording, opened } });
    markOfferSeen(id);
    if (previous && previous !== id) void api.releaseRecording(previous);
    clearDetailCache();
    setScope(ALL_SCOPE);
    if (LIVE_ONLY_TABS.has(useUi.getState().tab)) ui.setTab('logs');
    reconnectFresh();
    return true;
  },

  /** Back to the live data (the server frees the recording's memory). */
  backToLive(): void {
    const id = currentView();
    if (!id) return;
    setCurrentView(undefined);
    useRecordings.setState({ viewing: null });
    void api.releaseRecording(id);
    clearDetailCache();
    restoreScope = true;
    reconnectFresh();
  },

  /**
   * Back to live before a file is imported (imports land in the live data); resolves once the live data is in, so
   * the import's scope switch is not undone. The scope the window had before the recording is not put back.
   */
  leaveForImport(): Promise<void> {
    if (!currentView()) return Promise.resolve();
    return new Promise((resolve) => {
      let off = () => {};
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(done, 5000);
      off = onResync(done);
      recordings.backToLive();
      restoreScope = false;
      liveScope = null;
    });
  },

  async remove(id: string): Promise<boolean> {
    try {
      const list = await api.deleteRecording(id);
      useRecordings.setState({ list, error: null });
      if (currentView() === id) leaveGone();
      toast.success(t('recordings.deleted'));
      return true;
    } catch (err) {
      toast.error(t('recordings.deleteFailed'), { description: errorText(err) });
      void recordings.refresh();
      return false;
    }
  },

  async removeAll(): Promise<number> {
    const before = useRecordings.getState().list?.recordings.filter((r) => r.state !== 'recording').length ?? 0;
    try {
      const list = await api.deleteAllRecordings();
      useRecordings.setState({ list, error: null });
      if (currentView() && !list.recordings.some((r) => r.id === currentView())) leaveGone();
      const count = Math.max(0, before - list.recordings.filter((r) => r.state !== 'recording').length);
      toast.success(t('recordings.deletedAll', { count }));
      return count;
    } catch (err) {
      toast.error(t('recordings.deleteFailed'), { description: errorText(err) });
      void recordings.refresh();
      return 0;
    }
  },
};

/** The shown recording is gone (deleted here or elsewhere): the window is on the live data again. */
function leaveGone(): void {
  setCurrentView(undefined);
  useRecordings.setState({ viewing: null });
  clearDetailCache();
  restoreScope = true;
  toast.info(t('recordings.gone'));
}

/** Test hook: forget everything (the module keeps state between tests otherwise). */
export function resetRecordingsForTests(): void {
  setCurrentView(undefined);
  liveScope = null;
  restoreScope = false;
  inflight = null;
  again = false;
  useRecordings.setState({ list: null, loading: false, error: null, dialog: false, opening: null, viewing: null, offerClosed: false });
}

const RECORDER_LINE = /^recorder\./;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function refreshSoon(ms = 250): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void recordings.refresh();
  }, ms);
}

let wired = false;

/** Follow the server: hello (view kept or lost), the recorder's system lines, settings of the recorder. */
export function initRecordings(): () => void {
  if (wired) return () => undefined;
  wired = true;
  let lastSettings = '';
  const offMessages = onServerMessage((msg) => {
    if (msg.type === 'hello') {
      const asked = currentView();
      if (asked && msg.recording?.id !== asked) {
        // Deleted meanwhile, or unreadable: the server attached the live data instead.
        leaveGone();
      } else if (asked && msg.recording) {
        const viewing = useRecordings.getState().viewing;
        if (viewing) useRecordings.setState({ viewing: { ...viewing, recording: msg.recording } });
      }
      const s = msg.settings;
      lastSettings = s ? `${s.recordSessions !== false}|${s.recordingsMaxDays ?? ''}|${s.recordingsMaxMB ?? ''}` : '';
      refreshSoon(50);
      return;
    }
    if (msg.type === 'settings') {
      const s = msg.settings;
      const key = `${s.recordSessions !== false}|${s.recordingsMaxDays ?? ''}|${s.recordingsMaxMB ?? ''}`;
      if (key !== lastSettings) {
        lastSettings = key;
        refreshSoon(300);
      }
      return;
    }
    if (msg.type === 'batch' && !currentView() && msg.logs?.some((l: LogEntry) => l.source === 'system' && !!l.code && RECORDER_LINE.test(l.code))) refreshSoon();
  });
  const offResync = onResync(() => {
    if (!restoreScope || currentView()) return;
    restoreScope = false;
    const scope = liveScope;
    liveScope = null;
    if (scope) {
      setScope(scope);
      validateScope();
    }
  });
  return () => {
    wired = false;
    offMessages();
    offResync();
  };
}
