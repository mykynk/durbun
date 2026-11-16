/**
 * "Pair over Wi-Fi": Android 11+ wireless debugging from the Device tab. What to open on the phone, the phones the
 * network shows (refreshed while open), address + code, then the result in plain words. A pairing that found no
 * connect service asks for the connection address (it differs from the pairing one).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { create } from 'zustand';
import { CheckCircle2, Link2, Smartphone, Wifi } from 'lucide-react';
import type { AdbWirelessResult, AdbWirelessService, AdbWirelessState } from '@durbun/protocol';
import { Button, Callout, Dialog, Field, Input, Spinner } from '../../../components';
import { ApiError } from '../../../data';
import { useT } from '../../../i18n';
import { codeText, describeError } from '../codes';
import './i18n';
import './wireless.css';

export const usePairDialog = create<{ open: boolean }>(() => ({ open: false }));
export const openPairDialog = () => usePairDialog.setState({ open: true });
const closePairDialog = () => usePairDialog.setState({ open: false });

/** How often the network list is read while the dialog is open. */
export const DISCOVERY_INTERVAL_MS = 3000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : 'Network error', 'network');
  }
  let body: Record<string, unknown> | undefined;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const e = new ApiError(res.status, typeof body?.error === 'string' ? body.error : `${res.status}`, typeof body?.code === 'string' ? body.code : undefined, body);
    throw e;
  }
  return body as T;
}

const post = <T,>(path: string, body: unknown) => request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** "192.168.1.20:37099" / "[fe80::1]:37099" → host + port (what the server accepts, checked again there). */
export function parseAddress(text: string): { host: string; port: number } | undefined {
  const s = text.trim();
  const m = /^\[([0-9A-Fa-f:.%a-zA-Z]+)\]:(\d{1,5})$/.exec(s) ?? /^([A-Za-z0-9][A-Za-z0-9.-]*):(\d{1,5})$/.exec(s);
  if (!m) return undefined;
  const port = Number(m[2]);
  return port > 0 && port <= 65535 ? { host: m[1]!, port } : undefined;
}

export const cleanCode = (text: string) => text.replace(/[\s-]/g, '');
const addressOf = (s: Pick<AdbWirelessService, 'host' | 'port'>) => (s.host.includes(':') ? `[${s.host}]:${s.port}` : `${s.host}:${s.port}`);

type Outcome =
  | { kind: 'done'; address: string }
  | { kind: 'paired'; host: string }
  | { kind: 'connected'; address: string }
  | { kind: 'error'; op: 'pair' | 'connect'; text: string; detail?: string };

/** The text of a refused pair / connect (HTTP 200 with ok: false, or an HTTP error). */
function failureText(r: { code?: string; params?: Record<string, string | number>; message?: string }): { text: string } {
  return { text: codeText(r.code, r.params) ?? r.message ?? r.code ?? '' };
}

export function PairDialogHost() {
  const open = usePairDialog((s) => s.open);
  return open ? <PairDialog /> : null;
}

function PairDialog() {
  const t = useT();
  const [list, setList] = useState<{ status: 'loading' | 'ready' | 'error'; data?: AdbWirelessState; error?: string }>({ status: 'loading' });
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [connectAddress, setConnectAddress] = useState('');
  const [busy, setBusy] = useState<null | 'pair' | 'connect'>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [touched, setTouched] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const connectRef = useRef<HTMLInputElement>(null);

  // Read the network list now and every few seconds while open.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const data = await request<AdbWirelessState>('/api/android/wireless');
        if (alive) setList({ status: 'ready', data });
      } catch (err) {
        if (alive) setList((l) => (l.data ? l : { status: 'error', error: describeError(err).text }));
      }
      if (alive) timer = setTimeout(() => void read(), DISCOVERY_INTERVAL_MS);
    };
    void read();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const parsed = parseAddress(address);
  const codeOk = /^\d{6}$/.test(cleanCode(code));
  const noAdb = list.data?.adb === false;

  const use = (s: AdbWirelessService) => {
    setAddress(addressOf(s));
    setOutcome(null);
    requestAnimationFrame(() => codeRef.current?.focus());
  };

  const pair = async (e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (!parsed || !codeOk || busy) return;
    setBusy('pair');
    setOutcome(null);
    try {
      const r = await post<AdbWirelessResult>('/api/android/wireless/pair', { host: parsed.host, port: parsed.port, code: cleanCode(code) });
      if (!r.ok) setOutcome({ kind: 'error', op: 'pair', ...failureText(r) });
      else if (r.connected?.ok) setOutcome({ kind: 'done', address: r.connected.address });
      else {
        setOutcome({ kind: 'paired', host: parsed.host });
        setConnectAddress(parsed.host.includes(':') ? `[${parsed.host}]:` : `${parsed.host}:`);
        requestAnimationFrame(() => connectRef.current?.focus());
      }
      // A code works once: the next try needs a new one from the phone.
      setCode('');
      setTouched(false);
    } catch (err) {
      const d = describeError(err);
      setOutcome({ kind: 'error', op: 'pair', text: d.text, detail: d.detail });
    } finally {
      setBusy(null);
    }
  };

  const connect = async (target: string) => {
    const a = parseAddress(target);
    if (!a || busy) return;
    setBusy('connect');
    try {
      const r = await post<AdbWirelessResult>('/api/android/wireless/connect', { host: a.host, port: a.port });
      setOutcome(r.ok ? { kind: 'connected', address: r.address ?? target } : { kind: 'error', op: 'connect', ...failureText(r) });
    } catch (err) {
      const d = describeError(err);
      setOutcome({ kind: 'error', op: 'connect', text: d.text, detail: d.detail });
    } finally {
      setBusy(null);
    }
  };

  const services = list.data?.services ?? [];
  const finished = outcome?.kind === 'done' || outcome?.kind === 'connected';

  return (
    <Dialog
      open
      onClose={closePairDialog}
      size="lg"
      icon={Wifi}
      title={t('device.wireless.title')}
      description={t('device.wireless.desc')}
      footer={
        finished || outcome?.kind === 'paired' ? (
          <Button variant={finished ? 'primary' : 'ghost'} onClick={closePairDialog}>
            {t('common.close')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={closePairDialog}>
              {t('common.close')}
            </Button>
            <Button variant="primary" icon={Link2} loading={busy === 'pair'} disabled={noAdb || (busy !== null && busy !== 'pair')} onClick={() => void pair()}>
              {t('device.wireless.pair')}
            </Button>
          </>
        )
      }
    >
      <div className="wl">
        {noAdb ? (
          <Callout tone="warn" compact>
            {codeText('action.toolMissing', { tool: 'adb' })}
          </Callout>
        ) : null}

        <section className="wl__section" aria-labelledby="wl-phone">
          <h3 id="wl-phone" className="wl__head">
            {t('device.wireless.onPhone')}
          </h3>
          <ol className="dv-steps">
            <li>{t('device.wireless.step1')}</li>
            <li>{t('device.wireless.step2')}</li>
          </ol>
        </section>

        {!noAdb ? (
          <section className="wl__section" aria-labelledby="wl-found" aria-live="polite">
            <h3 id="wl-found" className="wl__head">
              {t('device.wireless.found')}
            </h3>
            {list.status === 'loading' ? (
              <span className="dv-loading">
                <Spinner size={12} /> {t('device.wireless.searching')}
              </span>
            ) : list.status === 'error' ? (
              <p className="dv-hint">
                {t('device.wireless.listFailed')}: {list.error}
              </p>
            ) : list.data?.discovery === 'unavailable' ? (
              <p className="dv-hint">{t('device.wireless.noDiscovery')}</p>
            ) : services.length === 0 ? (
              <p className="dv-hint">{t('device.wireless.none')}</p>
            ) : (
              <ul className="wl__list">
                {services.map((s) => (
                  <li key={`${s.kind}|${s.name}|${s.port}`} className="dv-action-row wl__row">
                    <Smartphone size={16} aria-hidden className="wl__icon" />
                    <div className="dv-action-row__text">
                      <span className="dv-action-row__title">
                        <span className="mono">{s.serial ?? s.name}</span>
                        <span className="subtle"> · {addressOf(s)}</span>
                      </span>
                      <span className="dv-hint">{t(s.kind === 'pairing' ? 'device.wireless.kindPairing' : 'device.wireless.kindConnect')}</span>
                    </div>
                    {s.connected ? (
                      <span className="dv-badge dv-badge--live">
                        <CheckCircle2 size={12} aria-hidden /> {t('device.wireless.connectedBadge')}
                      </span>
                    ) : s.kind === 'pairing' ? (
                      <Button size="sm" variant="secondary" onClick={() => use(s)}>
                        {t('device.wireless.use')}
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" loading={busy === 'connect'} disabled={busy !== null} onClick={() => void connect(addressOf(s))}>
                        {t('device.wireless.connect')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {outcome?.kind === 'done' || outcome?.kind === 'connected' ? (
          <Callout tone="success" title={t(outcome.kind === 'done' ? 'device.wireless.doneTitle' : 'device.wireless.connectedTitle')}>
            {t(outcome.kind === 'done' ? 'device.wireless.doneBody' : 'device.wireless.connectedBody', { address: outcome.address })} {t('device.wireless.later')}
          </Callout>
        ) : outcome?.kind === 'error' ? (
          <Callout tone="danger" compact title={t(outcome.op === 'pair' ? 'device.wireless.failedPair' : 'device.wireless.failedConnect')}>
            {outcome.text}
            {outcome.detail ? <span className="dv-error__detail mono">{outcome.detail}</span> : null}
          </Callout>
        ) : null}

        {outcome?.kind === 'paired' ? (
          <section className="wl__section">
            <Callout tone="success" compact title={t('device.wireless.pairedTitle')}>
              {t('device.wireless.pairedBody')}
            </Callout>
            <form
              className="wl__form"
              onSubmit={(e) => {
                e.preventDefault();
                void connect(connectAddress);
              }}
            >
              <Field label={t('device.wireless.connectAddress')} hint={t('device.wireless.connectAddressHint')} className="wl__grow">
                <Input ref={connectRef} mono value={connectAddress} onChange={(e) => setConnectAddress(e.target.value)} placeholder="192.168.1.20:41235" spellCheck={false} autoComplete="off" />
              </Field>
              <Button type="submit" variant="primary" icon={Link2} loading={busy === 'connect'} disabled={!parseAddress(connectAddress) || busy !== null}>
                {t('device.wireless.connect')}
              </Button>
            </form>
          </section>
        ) : !finished && !noAdb ? (
          <form className="wl__form" onSubmit={(e) => void pair(e)}>
            <Field label={t('device.wireless.address')} hint={t('device.wireless.addressHint')} error={touched && !parsed ? t('device.wireless.addressInvalid') : undefined} className="wl__grow">
              <Input mono value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.20:37099" spellCheck={false} autoComplete="off" invalid={touched && !parsed} />
            </Field>
            <Field label={t('device.wireless.code')} hint={t('device.wireless.codeHint')} error={touched && !codeOk ? t('device.wireless.codeInvalid') : undefined} className="wl__code">
              <Input ref={codeRef} mono value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" inputMode="numeric" maxLength={9} autoComplete="one-time-code" invalid={touched && !codeOk} />
            </Field>
            <button type="submit" hidden aria-hidden tabIndex={-1} />
          </form>
        ) : null}
      </div>
    </Dialog>
  );
}
