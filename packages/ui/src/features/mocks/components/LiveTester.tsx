import { useDeferredValue, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { Ban, CircleCheck, CornerDownRight, ExternalLink, FlaskConical } from 'lucide-react';
import type { MockRule } from '@durbun/protocol';
import { networkStore, ui, useHub, useNetworkVersion } from '../../../data';
import { IconButton, Input, MethodBadge, Select, TagChip, useFeatureActive } from '../../../components';
import { useT } from '../../../i18n';
import { collectCandidates, evaluateTester, parseOperationInput, testRequest, withDraft, type TesterRow, type TesterVerdict } from '../model/tester';
import { graphqlCondition, looksLikeGraphql, ruleLabel } from '../model/rules';

const SHOWN = 8;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function VerdictIcon({ v }: { v: TesterVerdict }) {
  if (v === 'applies') return <CircleCheck size={14} className="mk-tester__ok" aria-hidden />;
  if (v === 'shadowed' || v === 'notSent') return <CornerDownRight size={14} className="mk-tester__warn" aria-hidden />;
  return <Ban size={14} className="mk-tester__miss" aria-hidden />;
}

/** Recent requests the edited rule would catch (SDK semantics via the protocol's `mockRuleMatchesRequest`). */
export function LiveTester({
  draft,
  rules,
  insertAt,
  appNames,
  notSentTo,
}: {
  draft: MockRule | null;
  rules: readonly MockRule[];
  insertAt: number;
  appNames: ReadonlyMap<string, string>;
  /** Sessions (`AppSession.id`) whose SDK does not receive this rule (it uses a condition they did not declare). */
  notSentTo?: ReadonlySet<string>;
}) {
  const t = useT();
  const active = useFeatureActive();
  const v = useNetworkVersion({ throttleMs: 1000, enabled: active });
  // Session id → bundle id only changes when apps come and go (not with every stats update).
  const bundleSig = useHub((s) =>
    Object.values(s.apps)
      .map((a) => `${a.id}=${a.app.id}`)
      .join('|'),
  );
  const deferred = useDeferredValue(draft);
  const [expanded, setExpanded] = useState(false);
  const [tryMethod, setTryMethod] = useState('GET');
  const [tryUrl, setTryUrl] = useState('');
  const [tryOp, setTryOp] = useState('');

  const candidates = useMemo(() => {
    const apps = useHub.getState().apps;
    return collectCandidates(networkStore.list(), (appId) => (appId ? apps[appId]?.app.id : undefined));
  }, [v, bundleSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(() => (deferred ? withDraft(rules, deferred, insertAt) : rules.slice()), [rules, deferred, insertAt]);
  const result = useMemo(() => (deferred ? evaluateTester(deferred, list, candidates, notSentTo) : null), [deferred, list, candidates, notSentTo]);
  // The operation field shows for rules with a GraphQL condition or a GraphQL-looking address.
  const opField = !!draft && (!!graphqlCondition(draft) || looksLikeGraphql(draft.url));
  const typedOp = opField ? parseOperationInput(tryOp) : undefined;
  const manual = useMemo(() => {
    if (!deferred || !tryUrl.trim()) return null;
    if (typedOp === null) return { verdict: 'badOperation' as const, winner: undefined };
    return testRequest(deferred, list, tryMethod, tryUrl.trim(), undefined, typedOp);
  }, [deferred, list, tryMethod, tryUrl, typedOp]);

  const rows: TesterRow[] = result ? (expanded ? result.rows : result.rows.slice(0, SHOWN)) : [];
  // A rule for every app that catches several apps' requests: easy to miss when one app was meant.
  const otherApps = useMemo(() => {
    if (!deferred || (deferred.apps && deferred.apps.length > 0) || !result) return [];
    const ids = new Set<string>();
    for (const r of result.rows) if (r.verdict === 'applies' && r.bundleId) ids.add(r.bundleId);
    return ids.size > 1 ? [...ids] : [];
  }, [deferred, result]);
  const hidden = result ? result.rows.length - rows.length : 0;
  // The same app from two devices: name the device (one may get a rule with a condition and the other not).
  const rowLabel = useMemo(() => {
    const sessions = new Map<string, Set<string>>();
    for (const r of result?.rows ?? []) if (r.bundleId && r.appId) sessions.set(r.bundleId, (sessions.get(r.bundleId) ?? new Set()).add(r.appId));
    const { apps, devices } = useHub.getState();
    return (r: TesterRow): string => {
      const name = r.bundleId ? (appNames.get(r.bundleId) ?? r.bundleId) : '';
      if (!r.bundleId || !r.appId || (sessions.get(r.bundleId)?.size ?? 0) < 2) return name;
      const deviceId = apps[r.appId]?.deviceId;
      return deviceId ? `${name} · ${devices[deviceId]?.name ?? deviceId}` : name;
    };
  }, [result, appNames]);

  return (
    <section className="mk-tester" aria-label={t('mocks.tester.title')}>
      <header className="mk-tester__head">
        <FlaskConical size={14} aria-hidden />
        <span className="mk-tester__title">{t('mocks.tester.title')}</span>
        <span className="mk-tester__sub">
          {!draft
            ? t('mocks.tester.noPattern')
            : candidates.length === 0
              ? t('mocks.tester.noTraffic')
              : t('mocks.tester.summary', { count: result?.applies ?? 0 })}
          {result && result.shadowed > 0 ? ` · ${t('mocks.tester.shadowedSummary', { count: result.shadowed })}` : ''}
          {result && result.notSent > 0 ? ` · ${t('mocks.tester.notSentSummary', { count: result.notSent })}` : ''}
        </span>
      </header>
      {draft && !draft.enabled && result && result.applies > 0 ? <p className="mk-tester__note">{t('mocks.tester.disabled')}</p> : null}
      {otherApps.length > 0 ? (
        <p className="mk-tester__note" role="note">
          {t('mocks.tester.manyApps', { count: otherApps.length, apps: otherApps.map((id) => appNames.get(id) ?? id).join(', ') })}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="mk-tester__list">
          {rows.map((r) => (
            <li key={r.key} className={clsx('mk-tester__row', `is-${r.verdict}`)}>
              <VerdictIcon v={r.verdict} />
              <MethodBadge method={r.method} />
              <span className="mk-tester__url mono truncate" title={r.url}>
                {r.url}
              </span>
              {r.operation?.name ? (
                <span className={clsx('mk-op', `mk-op--${r.operation.type ?? 'query'}`)} title={t('mocks.list.operation', { op: r.operation.name })}>
                  {r.operation.name}
                </span>
              ) : null}
              {r.bundleId ? <TagChip name={rowLabel(r)} title={r.bundleId} maxWidth={150} className="mk-tester__app" /> : null}
              {r.count > 1 ? <span className="mk-tester__count tnum">{t('mocks.tester.count', { count: r.count })}</span> : null}
              <span className="mk-tester__verdict">
                {r.verdict === 'applies'
                  ? t('mocks.tester.applies')
                  : r.verdict === 'shadowed'
                    ? t('mocks.tester.shadowed', { rule: r.winner ? ruleLabel(r.winner) : '?' })
                    : r.verdict === 'appMismatch' || r.verdict === 'methodMismatch' || r.verdict === 'operationMismatch' || r.verdict === 'operationUnknown' || r.verdict === 'notSent'
                      ? t(`mocks.tester.${r.verdict}`)
                      : t('mocks.tester.methodMismatch')}
              </span>
              <IconButton icon={ExternalLink} size="xs" label={t('mocks.tester.open')} onClick={() => ui.focusNetwork(r.sampleId)} />
            </li>
          ))}
        </ul>
      ) : null}
      {hidden > 0 ? (
        <button type="button" className="mk-linkbtn" onClick={() => setExpanded(true)}>
          {t('mocks.tester.more', { count: hidden })}
        </button>
      ) : null}
      <div className="mk-tester__try">
        <Select size="sm" value={tryMethod} onChange={(e) => setTryMethod(e.target.value)} options={METHODS.map((m) => ({ value: m, label: m }))} aria-label={t('mocks.editor.method')} />
        <Input size="sm" mono value={tryUrl} onChange={(e) => setTryUrl(e.target.value)} placeholder={t('mocks.tester.tryPlaceholder')} aria-label={t('mocks.tester.tryUrl')} wrapperClassName="grow" className="grow" />
        {opField ? (
          <Input
            size="sm"
            mono
            value={tryOp}
            onChange={(e) => setTryOp(e.target.value)}
            placeholder={t('mocks.tester.tryOperationPlaceholder')}
            aria-label={t('mocks.tester.tryOperation')}
            invalid={typedOp === null}
            wrapperClassName="mk-tester__op"
            spellCheck={false}
          />
        ) : null}
      </div>
      {manual ? (
        <p className={clsx('mk-tester__manual', `is-${manual.verdict}`)} role="status">
          {manual.verdict === 'badOperation' ? null : <VerdictIcon v={manual.verdict} />}
          {manual.verdict === 'shadowed'
            ? t('mocks.tester.result.shadowed', { rule: manual.winner ? ruleLabel(manual.winner) : '?' })
            : t(`mocks.tester.result.${manual.verdict}`)}
        </p>
      ) : null}
    </section>
  );
}
