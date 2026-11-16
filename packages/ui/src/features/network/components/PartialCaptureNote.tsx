import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Info, X } from 'lucide-react';
import { useHub, type ExplainReason } from '../../../data';
import { Button, IconButton, usePersistentState } from '../../../components';
import { useT } from '../../../i18n';
import { ActionButtons, ReasonList, useScopeExplain, type ExplainedApp } from '../../../sources';

/** Reasons that mean "requests of this app you would expect are not in the list" (not the general caveats). */
const PARTIAL_REASONS: ReadonlySet<ExplainReason> = new Set<ExplainReason>(['nativeNetworkNeedsInterceptor']);

/**
 * A request list with rows can still miss part of an app's traffic (OkHttp without the interceptor, native
 * requests of an SDK-less Flutter app): say so above the list, once per app, with the way to fix it. Closing it
 * remembers that app (the note comes back when what is missing changes).
 */
export function PartialCaptureNote() {
  const t = useT();
  const scope = useScopeExplain();
  const devices = useHub((s) => s.devices);
  const [dismissed, setDismissed] = usePersistentState<string[]>('network.partialNote.dismissed', []);
  const [open, setOpen] = useState(false);

  const items = useMemo(() => {
    const out: { item: ExplainedApp; reasons: ExplainReason[]; sig: string }[] = [];
    for (const item of scope.items) {
      const row = item.result.rows.find((r) => r.capability === 'network');
      if (!row || (row.status !== 'yes' && row.status !== 'partial')) continue;
      const reasons = row.reasons.filter((r) => PARTIAL_REASONS.has(r));
      if (reasons.length === 0) continue;
      out.push({ item, reasons, sig: `${item.key}|${item.result.context?.transport ?? ''}|${reasons.join(',')}` });
    }
    return out;
  }, [scope]);
  const shown = items.filter((x) => !(Array.isArray(dismissed) && dismissed.includes(x.sig)));
  const first = shown[0];
  if (!first) return null;

  const appName = (x: ExplainedApp) => x.result.context?.appName || x.group.bundleId;
  const title = shown.length === 1 ? t('network.partial.title', { app: appName(first.item) }) : t('network.partial.titleMany', { count: shown.length });
  const dismiss = () => setDismissed((d) => [...new Set([...(Array.isArray(d) ? d : []), ...shown.map((x) => x.sig)])].slice(-50));

  return (
    <div className="net-banner net-banner--partial" role="note">
      <div className="net-partial__head">
        <Info size={13} aria-hidden />
        <span className="net-partial__title">{title}</span>
        <Button size="sm" variant="ghost" icon={open ? ChevronDown : ChevronRight} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {t('network.partial.why')}
        </Button>
        <IconButton size="sm" icon={X} label={t('network.partial.dismiss')} onClick={dismiss} />
      </div>
      {open ? (
        <div className="net-partial__body">
          {shown.map((x) => (
            <div key={x.sig} className="net-partial__app">
              {shown.length > 1 ? <strong>{appName(x.item)}</strong> : null}
              <ReasonList item={x.item} reasons={x.reasons} capability="network" device={devices[x.item.group.deviceId]} />
              <ActionButtons actions={x.item.result.rows.find((r) => r.capability === 'network')?.actions ?? []} item={x.item} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
