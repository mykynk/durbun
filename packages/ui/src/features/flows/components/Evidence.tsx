import { useState } from 'react';
import { Download, FileText, Maximize2 } from 'lucide-react';
import type { FlowEvidence } from '@durbun/protocol';
import { Dialog } from '../../../components';
import { useT } from '../../../i18n';

/** Screenshots and recordings a step kept: thumbnails, full size on click, download. */
export function Evidence({ items }: { items: readonly FlowEvidence[] }) {
  const t = useT();
  const [open, setOpen] = useState<FlowEvidence | null>(null);
  return (
    <div className="fl-evidence">
      {items.map((e) => (
        <figure key={e.url} className="fl-evidence__item">
          {e.kind === 'screenshot' ? (
            <button type="button" className="fl-evidence__thumb" onClick={() => setOpen(e)} aria-label={t('flows.evidence.open', { name: e.name })}>
              <img src={e.url} alt={e.name} loading="lazy" />
              <Maximize2 size={13} className="fl-evidence__zoom" aria-hidden />
            </button>
          ) : e.kind === 'video' ? (
            <video className="fl-evidence__video" src={e.url} controls preload="metadata" aria-label={e.name} />
          ) : (
            <a className="fl-evidence__file" href={e.url} target="_blank" rel="noreferrer">
              <FileText size={14} aria-hidden />
              {e.name}
            </a>
          )}
          <figcaption>
            <span className="fl-evidence__name">{e.name}</span>
            <a href={`${e.url}?download=1`} download={e.name} className="fl-evidence__dl" aria-label={t('flows.evidence.download', { name: e.name })}>
              <Download size={12} aria-hidden />
            </a>
          </figcaption>
        </figure>
      ))}
      <Dialog open={!!open} onClose={() => setOpen(null)} title={open?.name} size="xl" bodyClassName="fl-evidence__dialog">
        {open ? <img src={open.url} alt={open.name} className="fl-evidence__full" /> : null}
        {open ? (
          <div className="fl-evidence__dialog-actions">
            <a className="btn btn--ghost btn--sm" href={`${open.url}?download=1`} download={open.name}>
              <Download size={14} aria-hidden />
              {t('flows.evidence.save')}
            </a>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
