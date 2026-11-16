import { clsx } from 'clsx';
import { CircleStop, Radio, Unplug } from 'lucide-react';
import type { StreamInfo } from '@durbun/protocol';
import { formatNumber } from '../../../components';
import { t } from '../../../i18n';
import { streamKindLabel } from '../model/streams';

/** The state of a stream by shape, not by color alone: broadcasting (open), stop (closed), unplugged (broke). */
export function StreamStateIcon({ state, size = 12, className }: { state: StreamInfo['state']; size?: number; className?: string }) {
  const Icon = state === 'open' ? Radio : state === 'failed' ? Unplug : CircleStop;
  return <Icon size={size} aria-hidden className={className} />;
}

/** "WebSocket · open · 128 messages" (tooltip and accessible name of the chips). */
export function streamChipTitle(stream: StreamInfo): string {
  return t('network.streams.chipTitle', { kind: streamKindLabel(stream.kind), state: t(`network.streams.state.${stream.state}`), count: stream.count });
}

/** List cell chip: state icon, kind (WS / SSE) and the message count, which grows while the connection is open. */
export function StreamChip({ stream }: { stream: StreamInfo }) {
  const title = streamChipTitle(stream);
  return (
    <span className={clsx('net-strm', `net-strm--${stream.state}`)} title={title} aria-label={title} role="img">
      <StreamStateIcon state={stream.state} size={11} />
      <span className="net-strm__kind">{streamKindLabel(stream.kind, true)}</span>
      <span className="net-strm__count tnum">{formatNumber(stream.count)}</span>
    </span>
  );
}

/** Detail header: "WebSocket · open" with the state icon. */
export function StreamStateLabel({ stream }: { stream: StreamInfo }) {
  return (
    <span className={clsx('net-strm net-strm--label', `net-strm--${stream.state}`)} title={t(`network.streams.stateTitle.${stream.state}`)}>
      <StreamStateIcon state={stream.state} size={12} />
      <span>
        {streamKindLabel(stream.kind)} · {t(`network.streams.state.${stream.state}`)}
      </span>
    </span>
  );
}
