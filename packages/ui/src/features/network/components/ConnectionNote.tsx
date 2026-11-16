import { useMemo } from 'react';
import { Info, ScrollText, Settings2 } from 'lucide-react';
import type { NetworkEntry } from '@durbun/protocol';
import { logStore, ui, useApp, useLogVersion, useServerSettings } from '../../../data';
import { connectionKind, streamCaptureState } from '../../../data/explain';
import { Button } from '../../../components';
import { useT } from '../../../i18n';
import { sdkNoteOf } from '../../logs/model/sdkNotes';
import { streamKindLabel } from '../model/streams';

/**
 * The one line a WebSocket / SSE entry shows in place of the request actions (which do not apply to a connection;
 * the full reason is the tooltip). A handshake the server keeps without a stream (SPEC §6.1.1) says instead why it
 * has no messages: the app's SDK does not capture them, the capture is off (way to Settings), or the SDK captures
 * them but did not see this connection (`net.response.noStream`: e.g. an Android socket opened without
 * `DurbunWebSocketFactory`; the SDK's `noWebSocketFactory` line in Logs, when there is one, is a click away).
 * Null for an ordinary request.
 */
export function ConnectionNote({ entry }: { entry: NetworkEntry }) {
  const t = useT();
  const session = useApp(entry.appId);
  const captureStreams = useServerSettings((s) => s.settings.captureStreams);
  const kind = connectionKind(entry);
  const capture = kind && !entry.stream ? streamCaptureState({ deviceId: entry.deviceId, session, captureStreams }) : null;
  const unhooked = capture === 'ok';
  const logV = useLogVersion({ enabled: unhooked && !!entry.appId, throttleMs: 1000 });
  const noteLine = useMemo(
    () => (unhooked && entry.appId ? logStore.findLast((e) => e.appId === entry.appId && sdkNoteOf(e)?.kind === 'noWebSocketFactory') : undefined),
    [unhooked, entry.appId, logV],
  );
  if (!kind) return null;
  const why = t('network.unavailable.streamActions', { kind: streamKindLabel(kind) });
  let text = t('network.unavailable.streamActionsShort');
  /** The longer reason: the tooltip, and read out after the line. */
  let hint = why;
  if (capture === 'noCapability') text = t('network.streams.empty.noCapabilityTitle');
  else if (capture === 'captureOff') text = t('network.streams.empty.captureOffTitle');
  else if (capture === 'imported') text = t('network.streams.empty.importedNoneTitle');
  else if (capture === 'ok') {
    text = t('network.streams.noHook');
    hint = t(session?.sdk.platform === 'android' ? 'network.streams.noHookHintAndroid' : 'network.streams.noHookHint');
  }
  return (
    <div className="net-detail__actions net-detail__noactions" role="note">
      <Info size={13} aria-hidden />
      <span title={capture ? `${text}. ${hint}` : hint}>{text}</span>
      <span className="sr-only">{hint}</span>
      {capture === 'captureOff' ? (
        <Button size="sm" variant="ghost" icon={Settings2} onClick={() => ui.openSettings('network')}>
          {t('network.streams.notes.settings')}
        </Button>
      ) : null}
      {noteLine ? (
        <Button size="sm" variant="ghost" icon={ScrollText} onClick={() => ui.focusLog(noteLine.id)}>
          {t('network.streams.showInLogs')}
        </Button>
      ) : null}
    </div>
  );
}
