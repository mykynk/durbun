import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Binary, ChevronLeft, ChevronRight, Download, FileQuestion, ImageOff, Paperclip, Settings2 } from 'lucide-react';
import type { NetworkDetail, NetworkEntry } from '@durbun/protocol';
import { api, ui } from '../../../data';
import {
  Button,
  Callout,
  CodeView,
  CopyButton,
  EmptyState,
  IconButton,
  JsonTree,
  KeyValueTable,
  SegmentedControl,
  Spinner,
  formatBytes,
  formatNumber,
  usePersistentState,
  type CodeLanguage,
  type IconType,
} from '../../../components';
import { errorText, useT } from '../../../i18n';
import {
  boundaryOf,
  classifyBody,
  decodeBody,
  formatGraphql,
  graphqlErrors,
  hexDump,
  parseFormBody,
  parseGraphqlRequest,
  parseMultipart,
  prettyJsonText,
  sniffImage,
  type BodyKind,
  type DecodedBody,
  type GraphqlOperation,
} from '../model/body';
import { downloadBody } from '../actions';

export type BodyMode = 'preview' | 'code' | 'hex';

export interface BodyViewerProps {
  entry: NetworkEntry;
  which: 'request' | 'response';
  detail: NetworkDetail | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}

const HEX_PAGE = 64 * 1024;

/** Spinner shaped like an icon (EmptyState's icon slot). */
const WaitingIcon: IconType = ({ size }) => <Spinner size={Number(size) || 18} />;

const CODE_LANG: Partial<Record<BodyKind, CodeLanguage>> = {
  json: 'json',
  html: 'html',
  xml: 'xml',
  svg: 'xml',
  javascript: 'javascript',
  css: 'css',
  text: 'plain',
  form: 'plain',
};

function modesFor(kind: BodyKind, hasText: boolean): BodyMode[] {
  switch (kind) {
    case 'image':
    case 'binary':
      return ['preview', 'hex'];
    case 'multipart':
      return hasText ? ['preview', 'code', 'hex'] : ['preview', 'hex'];
    default:
      return ['preview', 'code', 'hex'];
  }
}

/** Body of a request or response: preview (JSON tree, image, form, multipart, GraphQL…), code and hex. */
export function BodyViewer({ entry, which, detail, loading, error, onRetry }: BodyViewerProps) {
  const t = useT();
  const wire = which === 'request' ? detail?.requestBody : detail?.responseBody;
  const contentType = which === 'request' ? entry.requestContentType : entry.responseContentType;
  const declared = which === 'request' ? entry.requestBodySize : entry.responseBodySize;
  const hasBody = which === 'request' ? entry.hasRequestBody : entry.hasResponseBody;
  const body = useMemo(() => decodeBody(wire), [wire]);

  if (which === 'response' && entry.state === 'pending') {
    return <EmptyState size="sm" icon={WaitingIcon} title={t('network.body.waiting')} description={t('network.body.waitingHint')} />;
  }
  if (which === 'response' && (entry.state === 'failed' || entry.state === 'cancelled') && entry.status === undefined) {
    return (
      <EmptyState
        size="sm"
        tone={entry.state === 'failed' ? 'danger' : 'neutral'}
        icon={FileQuestion}
        title={entry.state === 'failed' ? t('network.body.noResponse') : t('network.body.cancelled')}
        description={entry.error}
      />
    );
  }
  if (!detail) {
    if (error) {
      return (
        <div className="net-pad">
          <Callout tone="danger" title={t('network.body.loadFailed')} actions={<Button size="sm" onClick={onRetry}>{t('network.body.retry')}</Button>}>
            {errorText(error)}
          </Callout>
        </div>
      );
    }
    if (loading) {
      return (
        <div className="net-loading" role="status">
          <Spinner size={16} /> {t('network.body.loading')}
        </div>
      );
    }
  }
  if (!body || body.empty) {
    if (entry.bodyEvicted && (hasBody || (declared ?? 0) > 0)) {
      return <EmptyState size="sm" icon={FileQuestion} title={t('network.body.evicted')} description={t('network.body.evictedHint')} />;
    }
    if (hasBody || (declared ?? 0) > 0) return <NotCaptured size={declared} />;
    return <EmptyState size="sm" icon={FileQuestion} title={which === 'request' ? t('network.body.noRequestBody') : t('network.body.noResponseBody')} />;
  }
  if (body.notCaptured) return <NotCaptured size={body.size} />;
  return <LoadedBody key={`${entry.id}:${which}`} entry={entry} which={which} body={body} contentType={contentType} />;
}

function NotCaptured({ size }: { size: number | undefined }) {
  const t = useT();
  return (
    <EmptyState
      size="sm"
      icon={FileQuestion}
      title={size ? t('network.body.notCapturedSize', { size: formatBytes(size) }) : t('network.body.notCaptured')}
      description={t('network.body.notCapturedHint')}
      actions={
        <Button size="sm" variant="ghost" icon={Settings2} onClick={() => ui.openSettings('network')}>
          {t('network.body.captureSettings')}
        </Button>
      }
    />
  );
}

function LoadedBody({ entry, which, body, contentType }: { entry: NetworkEntry; which: 'request' | 'response'; body: DecodedBody; contentType?: string }) {
  const t = useT();
  const kind = useMemo(() => classifyBody(contentType, body), [contentType, body]);
  const text = kind === 'image' || kind === 'binary' ? null : body.text;
  const gqlOps = useMemo(
    () => (which === 'request' && entry.graphql ? parseGraphqlRequest({ method: entry.method, url: entry.url, contentType, text }) : null),
    [which, entry.graphql, entry.method, entry.url, contentType, text],
  );
  const modes = modesFor(kind, text !== null);
  const [savedMode, setSavedMode] = usePersistentState<BodyMode>(`network.bodyMode.${which}`, 'preview');
  const mode: BodyMode = modes.includes(savedMode) ? savedMode : 'preview';
  const [pretty, setPretty] = usePersistentState('network.prettyCode', true);

  const prettyText = useMemo(() => {
    if (text === null) return null;
    if (kind === 'json') return prettyJsonText(text);
    if (gqlOps && gqlOps[0]?.query && !text.trim().startsWith('{')) return formatGraphql(text);
    return null;
  }, [text, kind, gqlOps]);

  const modeLabel: Record<BodyMode, string> = { preview: t('network.body.modes.preview'), code: t('network.body.modes.code'), hex: t('network.body.modes.hex') };
  const kindLabel = gqlOps ? 'GraphQL' : t(`network.body.kinds.${kind}`);

  return (
    <div className="net-body">
      <div className="net-body__bar">
        <SegmentedControl size="sm" value={mode} onChange={setSavedMode} options={modes.map((m) => ({ value: m, label: modeLabel[m] }))} aria-label={t('network.body.modeLabel')} />
        <span className="net-body__info">
          <span>{kindLabel}</span>
          <span className="net-dot">·</span>
          <span className="tnum" title={t('network.body.bytes', { count: formatNumber(body.size) })}>
            {formatBytes(body.size)}
          </span>
          {contentType ? (
            <>
              <span className="net-dot">·</span>
              <span className="mono truncate net-body__ct" title={contentType}>
                {contentType.split(';')[0]}
              </span>
            </>
          ) : null}
        </span>
        <span className="grow" />
        {text !== null ? (
          <CopyButton size="sm" value={() => text} label={t('network.body.copy')} />
        ) : (
          <CopyButton size="sm" value={() => body.wire.data} label={t('network.body.copyBase64')} />
        )}
        <IconButton icon={Download} size="sm" label={t('network.body.download')} onClick={() => downloadBody(entry, which)} />
      </div>
      {body.truncated ? (
        <div className="net-body__notice">
          <Callout tone="warn" compact>
            {t('network.body.truncated', { shown: formatBytes(body.capturedBytes), total: formatBytes(body.size) })}
          </Callout>
        </div>
      ) : null}
      <div className="net-body__content">
        {mode === 'hex' ? (
          <HexView bytes={body.bytes} />
        ) : mode === 'code' ? (
          <CodeView
            code={(pretty && prettyText) || text || ''}
            language={CODE_LANG[kind] ?? 'auto'}
            contentType={contentType}
            defaultWrap={kind === 'text'}
            aria-label={t('network.body.codeLabel')}
            toolbar={
              prettyText ? (
                <SegmentedControl
                  size="sm"
                  value={pretty ? 'pretty' : 'raw'}
                  onChange={(v) => setPretty(v === 'pretty')}
                  options={[
                    { value: 'pretty', label: t('network.body.pretty') },
                    { value: 'raw', label: t('network.body.raw') },
                  ]}
                  aria-label={t('network.body.format')}
                />
              ) : (
                true
              )
            }
          />
        ) : (
          <Preview entry={entry} which={which} kind={kind} body={body} text={text} contentType={contentType} gqlOps={gqlOps} onHex={() => setSavedMode('hex')} />
        )}
      </div>
    </div>
  );
}

function Preview({
  entry,
  which,
  kind,
  body,
  text,
  contentType,
  gqlOps,
  onHex,
}: {
  entry: NetworkEntry;
  which: 'request' | 'response';
  kind: BodyKind;
  body: DecodedBody;
  text: string | null;
  contentType?: string;
  gqlOps: GraphqlOperation[] | null;
  onHex: () => void;
}) {
  const t = useT();
  if (gqlOps) return <GraphqlRequestPreview ops={gqlOps} />;
  switch (kind) {
    case 'json':
      return <JsonPreview text={text ?? ''} graphql={which === 'response' && !!entry.graphql} truncated={body.truncated} />;
    case 'image':
    case 'svg':
      return <ImagePreview entry={entry} which={which} body={body} contentType={contentType} />;
    case 'form':
      return (
        <div className="net-pad net-scroll">
          <KeyValueTable rows={parseFormBody(text ?? '').map((p) => ({ key: p.name, value: p.value, copyValue: p.value }))} filterable copyAll aria-label={t('network.body.formFields')} />
        </div>
      );
    case 'multipart':
      return <MultipartPreview body={body} contentType={contentType} />;
    case 'binary':
      return (
        <EmptyState
          size="sm"
          icon={Binary}
          title={t('network.body.binaryTitle', { size: formatBytes(body.size) })}
          description={contentType ?? t('network.body.binaryHint')}
          actions={
            <>
              <Button size="sm" onClick={onHex}>
                {t('network.body.showHex')}
              </Button>
              <Button size="sm" variant="ghost" icon={Download} onClick={() => downloadBody(entry, which)}>
                {t('network.body.download')}
              </Button>
            </>
          }
        />
      );
    default:
      return <CodeView code={text ?? ''} language={CODE_LANG[kind] ?? 'auto'} contentType={contentType} defaultWrap lineNumbers={false} aria-label={t('network.body.previewLabel')} />;
  }
}

function JsonPreview({ text, graphql, truncated }: { text: string; graphql: boolean; truncated: boolean }) {
  const t = useT();
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(text) as unknown };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [text]);
  const errors = useMemo(() => (graphql && parsed.ok ? graphqlErrors(parsed.value) : []), [graphql, parsed]);
  if (!parsed.ok) {
    return (
      <div className="net-col">
        <div className="net-body__notice">
          <Callout tone={truncated ? 'warn' : 'danger'} compact>
            {truncated ? t('network.body.jsonTruncated') : t('network.body.jsonInvalid', { message: parsed.error })}
          </Callout>
        </div>
        <CodeView code={text} language="plain" defaultWrap aria-label={t('network.body.codeLabel')} />
      </div>
    );
  }
  return (
    <div className="net-col net-scroll">
      {errors.length > 0 ? (
        <div className="net-pad net-pad--b0">
          <Callout tone="danger" title={t('network.body.graphqlErrors', { count: errors.length })}>
            <ul className="net-gqlerrors">
              {errors.slice(0, 20).map((e, i) => (
                <li key={i}>
                  <span className="net-gqlerrors__msg">{e.message}</span>
                  {e.path ? <span className="mono net-dim"> · {e.path}</span> : null}
                  {e.code ? <span className="net-gqlerrors__code mono">{e.code}</span> : null}
                  {e.locations ? <span className="net-dim"> · {t('network.body.gqlLocation', { at: e.locations })}</span> : null}
                </li>
              ))}
            </ul>
          </Callout>
        </div>
      ) : null}
      <div className="net-pad net-json">
        <JsonTree data={parsed.value} toolbar defaultExpandDepth={2} rootLabel="body" aria-label={t('network.body.jsonLabel')} />
      </div>
    </div>
  );
}

function GraphqlRequestPreview({ ops }: { ops: GraphqlOperation[] }) {
  const t = useT();
  return (
    <div className="net-col net-scroll net-pad net-gql-preview">
      {ops.map((op, i) => (
        <section key={i} className="net-gql-op">
          {ops.length > 1 ? <h4 className="net-section-title">{t('network.body.gqlBatchItem', { n: i + 1, total: ops.length })}</h4> : null}
          {op.operationName ? (
            <div className="net-gql-op__name">
              <span className="net-dim">{t('network.body.gqlOperation')}</span> <span className="mono">{op.operationName}</span>
            </div>
          ) : null}
          {op.query ? (
            <>
              <h4 className="net-section-title">{t('network.body.gqlQuery')}</h4>
              <CodeView code={formatGraphql(op.query)} language="plain" maxHeight={420} aria-label={t('network.body.gqlQuery')} />
            </>
          ) : (
            <Callout tone="info" compact>
              {t('network.body.gqlPersisted')}
            </Callout>
          )}
          {op.variables !== undefined ? (
            <>
              <h4 className="net-section-title">{t('network.body.gqlVariables')}</h4>
              <JsonTree data={op.variables} defaultExpandDepth={3} rootLabel="variables" aria-label={t('network.body.gqlVariables')} />
            </>
          ) : null}
          {op.extensions !== undefined ? (
            <>
              <h4 className="net-section-title">{t('network.body.gqlExtensions')}</h4>
              <JsonTree data={op.extensions} defaultExpandDepth={2} rootLabel="extensions" aria-label={t('network.body.gqlExtensions')} />
            </>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function ImagePreview({ entry, which, body, contentType }: { entry: NetworkEntry; which: 'request' | 'response'; body: DecodedBody; contentType?: string }) {
  const t = useT();
  const info = useMemo(() => sniffImage(body.bytes.subarray(0, 64 * 1024)), [body]);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const src = api.bodyUrl(entry.id, which);
  const w = info?.width ?? natural?.w;
  const h = info?.height ?? natural?.h;
  const format = info?.format?.toUpperCase() ?? (contentType ?? '').split(';')[0]!.split('/').pop()?.toUpperCase();
  return (
    <div className="net-col net-scroll">
      <div className="net-img__meta">
        {format ? <span className="mono">{format}</span> : null}
        {w && h ? (
          <>
            <span className="net-dot">·</span>
            <span className="tnum">
              {w} × {h} px
            </span>
          </>
        ) : null}
        <span className="net-dot">·</span>
        <span className="tnum">{formatBytes(body.size)}</span>
      </div>
      <div className="net-img__stage">
        {failed || body.truncated ? (
          <EmptyState size="sm" icon={ImageOff} title={body.truncated ? t('network.body.imageTruncated') : t('network.body.imageFailed')} />
        ) : (
          <img
            src={src}
            alt={t('network.body.imageAlt', { url: entry.url })}
            className="net-img"
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}

function MultipartPreview({ body, contentType }: { body: DecodedBody; contentType?: string }) {
  const t = useT();
  const boundary = boundaryOf(contentType);
  const parsed = useMemo(() => (boundary ? parseMultipart(body.bytes, boundary) : null), [body, boundary]);
  if (!parsed || parsed.parts.length === 0) {
    return (
      <div className="net-pad">
        <Callout tone="info" compact>
          {t('network.body.multipartUnreadable')}
        </Callout>
      </div>
    );
  }
  return (
    <div className="net-col net-scroll net-pad">
      <p className="net-dim net-mp__summary">{t('network.body.multipartParts', { count: parsed.parts.length })}</p>
      <ul className="net-mp" aria-label={t('network.body.multipartLabel')}>
        {parsed.parts.map((p, i) => (
          <li key={i} className="net-mp__part">
            <div className="net-mp__head">
              <Paperclip size={13} aria-hidden className="net-dim" />
              <span className="mono net-mp__name">{p.name ?? `#${i + 1}`}</span>
              {p.filename ? <span className="net-mp__file">{p.filename}</span> : null}
              <span className="grow" />
              {p.contentType ? <span className="mono net-dim">{p.contentType}</span> : null}
              <span className="tnum net-dim">{p.truncated ? t('network.body.atLeast', { size: formatBytes(p.size) }) : formatBytes(p.size)}</span>
            </div>
            {p.text !== undefined ? <pre className="net-mp__text mono selectable">{p.text || ' '}</pre> : null}
            {p.truncated ? <div className="net-mp__trunc">{t('network.body.partTruncated')}</div> : null}
          </li>
        ))}
      </ul>
      {!parsed.complete && !parsed.parts.some((p) => p.truncated) ? <p className="net-dim">{t('network.body.partTruncated')}</p> : null}
    </div>
  );
}

function HexView({ bytes }: { bytes: Uint8Array }) {
  const t = useT();
  const pages = Math.max(1, Math.ceil(bytes.length / HEX_PAGE));
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [bytes]);
  const p = Math.min(page, pages - 1);
  const dump = useMemo(() => hexDump(bytes, p * HEX_PAGE, Math.min(bytes.length, (p + 1) * HEX_PAGE)), [bytes, p]);
  const pager: ReactNode =
    pages > 1 ? (
      <span className="net-hex__pager">
        <IconButton icon={ChevronLeft} size="xs" label={t('network.body.hexPrev')} disabled={p === 0} onClick={() => setPage(p - 1)} />
        <span className="tnum net-dim">{t('network.body.hexPage', { from: formatBytes(p * HEX_PAGE), to: formatBytes(Math.min(bytes.length, (p + 1) * HEX_PAGE)), page: p + 1, pages })}</span>
        <IconButton icon={ChevronRight} size="xs" label={t('network.body.hexNext')} disabled={p >= pages - 1} onClick={() => setPage(p + 1)} />
      </span>
    ) : (
      true
    );
  return <CodeView code={dump} language="plain" lineNumbers={false} toolbar={pager} aria-label={t('network.body.hexLabel')} className={clsx('net-hex')} />;
}
