import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, Trash2 } from 'lucide-react';
import type { NetworkEntry, ReplayOverrides } from '@durbun/protocol';
import { sendCommand } from '../../../data';
import { Button, Callout, Dialog, Field, Input, Select, Spinner, formatBytes, formatDuration, toast, useShortcut } from '../../../components';
import { errorText, useT } from '../../../i18n';
import { headersFromRows, rowsFromHeaders, type HeaderRow } from '../../mocks/model/rules';
import { HeaderRowsEditor } from '../../mocks/components/HeaderRowsEditor';
import { BodyEditor } from '../../mocks/components/BodyEditor';
import { useNetworkDetail } from '../detailCache';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const MAX_EDITABLE_BINARY = 256 * 1024;
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

type BodyMode = { kind: 'edit'; text: string; encoding: 'utf8' | 'base64' } | { kind: 'keep'; size: number } | { kind: 'none' } | { kind: 'loading' };

export function ReplayDialog({ entry, onClose, onSent }: { entry: NetworkEntry; onClose: () => void; onSent: (e: NetworkEntry) => void }) {
  const t = useT();
  const { detail, loading, error } = useNetworkDetail(entry);
  const [method, setMethod] = useState(entry.method === '?' ? 'GET' : entry.method.toUpperCase());
  const [url, setUrl] = useState(entry.url);
  const [rows, setRows] = useState<HeaderRow[]>(() => rowsFromHeaders(entry.requestHeaders.filter(([n]) => !n.startsWith(':') && n.toLowerCase() !== 'content-length')));
  const [body, setBody] = useState<BodyMode>({ kind: 'loading' });
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    if (!detail && loading) return;
    initialized.current = true;
    const wire = detail?.requestBody;
    if (!wire || (wire.data === '' && !wire.truncated)) setBody(entry.hasRequestBody ? { kind: 'keep', size: entry.requestBodySize ?? 0 } : { kind: 'edit', text: '', encoding: 'utf8' });
    else if (wire.data === '') setBody({ kind: 'keep', size: wire.size });
    else if (wire.encoding === 'base64' && wire.data.length > (MAX_EDITABLE_BINARY * 4) / 3) setBody({ kind: 'keep', size: wire.size });
    else setBody({ kind: 'edit', text: wire.data, encoding: wire.encoding === 'base64' ? 'base64' : 'utf8' });
  }, [detail, loading, entry.hasRequestBody, entry.requestBodySize]);

  const urlError = useMemo(() => {
    try {
      const u = new URL(url.trim());
      return u.protocol === 'http:' || u.protocol === 'https:' ? null : t('network.replayDialog.urlScheme');
    } catch {
      return t('network.replayDialog.urlInvalid');
    }
  }, [url, t]);
  const methodError = TOKEN_RE.test(method.trim()) ? null : t('network.replayDialog.methodInvalid');
  const contentType = rows.find((r) => r.enabled && r.name.trim().toLowerCase() === 'content-type')?.value;
  const bodyless = method === 'GET' || method === 'HEAD';
  const hasBodyText = body.kind === 'edit' && body.text !== '';
  const truncated = !!detail?.requestBody?.truncated && detail.requestBody.data !== '';

  const send = async () => {
    if (urlError || methodError || sending) return;
    const overrides: ReplayOverrides = { method: method.trim().toUpperCase(), url: url.trim(), headers: headersFromRows(rows) };
    if (body.kind === 'edit') {
      overrides.body = body.text;
      overrides.bodyEncoding = body.encoding;
    } else if (body.kind === 'none') overrides.body = '';
    setSending(true);
    setSendError(null);
    try {
      const res = await sendCommand({ name: 'net.replay', id: entry.id, overrides });
      if (res.state === 'failed') toast.error(t('network.replay.failed'), { description: res.error });
      else toast.success(t('network.replay.done', { status: res.status ?? '—', duration: formatDuration(res.duration) }));
      onSent(res);
      onClose();
    } catch (err) {
      setSendError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  useShortcut('Mod+Enter', () => void send(), { allowInModal: true, allowInInputs: true });

  const methodOptions = METHODS.includes(method) ? METHODS : [method, ...METHODS];

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      icon={Send}
      title={t('network.replayDialog.title')}
      description={t('network.replayDialog.description')}
      footer={
        <>
          <span className="net-dim net-small grow">{t('network.replayDialog.desktopNote')}</span>
          <Button variant="ghost" onClick={onClose}>
            {t('network.replayDialog.cancel')}
          </Button>
          <Button variant="primary" icon={Send} loading={sending} disabled={!!urlError || !!methodError} onClick={() => void send()} kbd="Mod+Enter">
            {t('network.replayDialog.send')}
          </Button>
        </>
      }
    >
      <div className="net-replay">
        <div className="net-replay__line">
          <Field label={t('network.replayDialog.method')} error={methodError ?? undefined} className="net-replay__method">
            <Select size="sm" value={method} onChange={(e) => setMethod(e.target.value)} options={methodOptions.map((m) => ({ value: m, label: m }))} aria-label={t('network.replayDialog.method')} />
          </Field>
          <Field label={t('network.replayDialog.url')} error={urlError ?? undefined} className="grow">
            <Input size="sm" mono value={url} onChange={(e) => setUrl(e.target.value)} invalid={!!urlError} spellCheck={false} aria-label={t('network.replayDialog.url')} />
          </Field>
        </div>
        <Field label={t('network.replayDialog.headers')}>
          <HeaderRowsEditor rows={rows} onChange={setRows} toggleable aria-label={t('network.replayDialog.headers')} />
        </Field>
        <Field label={t('network.replayDialog.body')}>
          {body.kind === 'loading' ? (
            <div className="net-loading">
              <Spinner size={14} /> {t('network.body.loading')}
            </div>
          ) : body.kind === 'keep' ? (
            <Callout
              tone="info"
              compact
              actions={
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setBody({ kind: 'none' })}>
                  {t('network.replayDialog.removeBody')}
                </Button>
              }
            >
              {body.size > 0 ? t('network.replayDialog.keepBody', { size: formatBytes(body.size) }) : t('network.replayDialog.keepBodyUnknown')}
            </Callout>
          ) : body.kind === 'none' ? (
            <Callout tone="info" compact actions={<Button size="sm" variant="ghost" onClick={() => setBody({ kind: 'edit', text: '', encoding: 'utf8' })}>{t('network.replayDialog.addBody')}</Button>}>
              {t('network.replayDialog.noBody')}
            </Callout>
          ) : (
            <BodyEditor
              value={body.text}
              encoding={body.encoding}
              onEncodingChange={(enc) => setBody({ kind: 'edit', text: body.text, encoding: enc })}
              onChange={(text) => setBody({ kind: 'edit', text, encoding: body.encoding })}
              contentType={contentType}
              rows={8}
              aria-label={t('network.replayDialog.body')}
            />
          )}
        </Field>
        {error && !detail ? (
          <Callout tone="warn" compact>
            {t('network.replayDialog.bodyLoadFailed', { error: errorText(error) })}
          </Callout>
        ) : null}
        {truncated && body.kind === 'edit' ? (
          <Callout tone="warn" compact>
            {t('network.replayDialog.truncated')}
          </Callout>
        ) : null}
        {bodyless && (hasBodyText || body.kind === 'keep') ? (
          <Callout tone="warn" compact>
            {t('network.replayDialog.bodyless', { method })}
          </Callout>
        ) : null}
        {sendError ? (
          <Callout tone="danger" title={t('network.replay.error')}>
            {sendError}
          </Callout>
        ) : null}
      </div>
    </Dialog>
  );
}
