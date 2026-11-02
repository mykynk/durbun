import { useDeferredValue, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { Ban, CircleCheck, CornerDownRight, ExternalLink, FlaskConical } from 'lucide-react';
import type { MockRule } from '@durbun/protocol';
import { networkStore, ui, useHub, useNetworkVersion } from '../../../data';
import { IconButton, Input, MethodBadge, Select, TagChip, useFeatureActive } from '../../../components';
import { useT } from '../../../i18n';
import { collectCandidates, evaluateTester, testRequest, withDraft, type TesterRow, type TesterVerdict } from '../model/tester';
import { ruleLabel } from '../model/rules';

const SHOWN = 8;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function VerdictIcon({ v }: { v: TesterVerdict }) {
  if (v === 'applies') return <CircleCheck size={14} className="mk-tester__ok" aria-hidden />;
  if (v === 'shadowed') return <CornerDownRight size={14} className="mk-tester__warn" aria-hidden />;
  return <Ban size={14} className="mk-tester__miss" aria-hidden />;
}

/** Recent requests the edited rule would catch (exact SDK semantics via `mockRuleMatches`). */
export function LiveTester({ draft, rules, insertAt, appNames }: { draft: MockRule | null; rules: readonly MockRule[]; insertAt: number; appNames: ReadonlyMap<string, string> }) {
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

  const candidates = useMemo(() => {
    const apps = useHub.getState().apps;
    return collectCandidates(networkStore.list(), (appId) => (appId ? apps[appId]?.app.id : undefined));
  }, [v, bundleSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(() => (deferred ? withDraft(rules, deferred, insertAt) : rules.slice()), [rules, deferred, insertAt]);
  const result = useMemo(() => (deferred ? evaluateTester(deferred, list, candidates) : null), [deferred, list, candidates]);
  const manual = useMemo(() => (deferred && tryUrl.trim() ? testRequest(deferred, list, tryMethod, tryUrl.trim(), undefined) : null), [deferred, list, tryMethod, tryUrl]);

  const rows: TesterRow[] = result ? (expanded ? result.rows : result.rows.slice(0, SHOWN)) : [];
  const hidden = result ? result.rows.length - rows.length : 0;

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
        </span>
      </header>
      {draft && !draft.enabled && result && result.applies > 0 ? <p className="mk-tester__note">{t('mocks.tester.disabled')}</p> : null}
      {rows.length > 0 ? (
        <ul className="mk-tester__list">
          {rows.map((r) => (
            <li key={r.key} className={clsx('mk-tester__row', `is-${r.verdict}`)}>
              <VerdictIcon v={r.verdict} />
              <MethodBadge method={r.method} />
              <span className="mk-tester__url mono truncate" title={r.url}>
                {r.url}
              </span>
              {r.bundleId ? <TagChip name={appNames.get(r.bundleId) ?? r.bundleId} title={r.bundleId} maxWidth={110} /> : null}
              {r.count > 1 ? <span className="mk-tester__count tnum">{t('mocks.tester.count', { count: r.count })}</span> : null}
              <span className="mk-tester__verdict">
                {r.verdict === 'applies'
                  ? t('mocks.tester.applies')
                  : r.verdict === 'shadowed'
                    ? t('mocks.tester.shadowed', { rule: r.winner ? ruleLabel(r.winner) : '?' })
                    : r.verdict === 'appMismatch'
                      ? t('mocks.tester.appMismatch')
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
      </div>
      {manual ? (
        <p className={clsx('mk-tester__manual', `is-${manual.verdict}`)} role="status">
          <VerdictIcon v={manual.verdict} />
          {manual.verdict === 'shadowed'
            ? t('mocks.tester.result.shadowed', { rule: manual.winner ? ruleLabel(manual.winner) : '?' })
            : t(`mocks.tester.result.${manual.verdict}`)}
        </p>
      ) : null}
    </section>
  );
}
