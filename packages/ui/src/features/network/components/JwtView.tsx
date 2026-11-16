import { useMemo, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button, Chip, JsonTree, KeyValueTable, formatDateTime, formatRelative, type KeyValueRow, type Tone } from '../../../components';
import { useLanguage, useT } from '../../../i18n';
import { claimText, findJwts, jwtStateAt, JWT_TIME_CLAIMS, type DecodedJwt, type JwtState } from '../model/jwt';

const STATE_TONE: Record<JwtState, Tone> = { expired: 'danger', notYet: 'warn', valid: 'success', noExpiry: 'neutral' };
const TEXT_CLAIMS = ['sub', 'iss', 'aud'] as const;

/**
 * JWTs found in a section's values (Authorization header, cookies, query values): one line each with whether the
 * token was valid when the request was sent, and "Decode" for the header, the claims and their times. Decoded
 * locally; nothing is sent. Renders nothing when there is no token.
 */
export function JwtNotes({ values, at }: { values: ReadonlyArray<{ name: string; value: string }>; at: number }) {
  const t = useT();
  const jwts = useMemo(() => findJwts(values), [values]);
  if (jwts.length === 0) return null;
  return (
    <section className="net-jwt" aria-label={t('network.jwt.label')}>
      {jwts.map((jwt) => (
        <JwtItem key={jwt.token} jwt={jwt} at={at} />
      ))}
    </section>
  );
}

function JwtItem({ jwt, at }: { jwt: DecodedJwt; at: number }) {
  const t = useT();
  const lang = useLanguage();
  const [open, setOpen] = useState(false);
  const state = jwtStateAt(jwt, at);
  const now = Date.now();
  const { exp, nbf } = jwt.times;
  const alg = typeof jwt.header.alg === 'string' ? jwt.header.alg : undefined;
  let line: string;
  if (state === 'expired' && exp !== undefined) line = t('network.jwt.line.expired', { rel: formatRelative(exp, at, { lang }) });
  else if (state === 'notYet' && nbf !== undefined) line = t('network.jwt.line.notYet', { date: formatDateTime(nbf, { lang }) });
  else if (state === 'valid' && exp !== undefined) line = t('network.jwt.line.valid', { rel: formatRelative(exp, at, { lang }) });
  else line = t('network.jwt.line.noExpiry');
  const nowExpired = state !== 'expired' && exp !== undefined && exp <= now ? t('network.jwt.line.nowExpired', { rel: formatRelative(exp, now, { lang }) }) : '';

  const rows = useMemo<KeyValueRow[]>(() => {
    const out: KeyValueRow[] = [];
    for (const k of JWT_TIME_CLAIMS) {
      const ms = jwt.times[k];
      if (ms !== undefined) out.push({ key: t(`network.jwt.claims.${k}`), value: `${formatDateTime(ms, { lang })} · ${formatRelative(ms, now, { lang })}` });
    }
    for (const k of TEXT_CLAIMS) {
      const v = claimText(jwt, k);
      if (v) out.push({ key: t(`network.jwt.claims.${k}`), value: v });
    }
    return out;
    // `now` only refreshes when the item opens again; times are coarse anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jwt, lang, t, open]);

  const bodyId = `net-jwt-${jwt.token.slice(-12)}`;
  return (
    <div className="net-jwt__item">
      <div className="net-jwt__head">
        <KeyRound size={14} aria-hidden className="net-jwt__icon" />
        <span className="net-jwt__name mono truncate">{jwt.name || t('network.jwt.kind')}</span>
        <span className="net-dim mono">{alg ? `${t('network.jwt.kind')} · ${alg}` : t('network.jwt.kind')}</span>
        <Chip size="sm" tone={STATE_TONE[state]}>
          {t(`network.jwt.state.${state}`)}
        </Chip>
        <span className="net-jwt__spacer" />
        <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={bodyId} aria-label={open ? undefined : t('network.jwt.decodeLabel', { name: jwt.name || t('network.jwt.kind') })} onClick={() => setOpen((v) => !v)}>
          {open ? t('network.jwt.hide') : t('network.jwt.decode')}
        </Button>
      </div>
      <p className="net-jwt__line">
        {line}
        {nowExpired ? ` ${nowExpired}` : ''}
      </p>
      {open ? (
        <div className="net-jwt__body" id={bodyId}>
          {rows.length > 0 ? (
            <>
              <h4 className="net-section-title">{t('network.jwt.summary')}</h4>
              <KeyValueTable rows={rows} mono={false} keyWidth="190px" aria-label={t('network.jwt.summary')} />
            </>
          ) : null}
          <h4 className="net-section-title">{t('network.jwt.payload')}</h4>
          <JsonTree data={jwt.claims} defaultExpandDepth={2} rootLabel="claims" aria-label={t('network.jwt.payload')} />
          <h4 className="net-section-title">{t('network.jwt.header')}</h4>
          <JsonTree data={jwt.header} defaultExpandDepth={1} rootLabel="header" aria-label={t('network.jwt.header')} />
          <p className="net-jwt__note">{t('network.jwt.note')}</p>
        </div>
      ) : null}
    </div>
  );
}
