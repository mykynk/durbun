import { Suspense, lazy, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react';
import { clsx } from 'clsx';
import { useT } from '../i18n';
import { TAB_IDS, useConnection, useIsEmpty, useUi, type TabId } from '../data';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { FeatureContext } from '../components/FeatureContext';
import { Spinner } from '../components/Spinner';
import { Onboarding } from './Onboarding';
import { ServerUnreachable } from './ConnectionStates';

/**
 * Feature contract: each tab renders the default export of `src/features/<tab>/index.tsx` inside a
 * full-height flex container (`.feature`). Views stay mounted after their first visit and are hidden
 * (not unmounted) when inactive; `useFeatureActive()` tells them whether they are visible.
 */
const FEATURES: Record<TabId, LazyExoticComponent<ComponentType>> = {
  logs: lazy(() => import('../features/logs')),
  network: lazy(() => import('../features/network')),
  mocks: lazy(() => import('../features/mocks')),
  perf: lazy(() => import('../features/perf')),
  device: lazy(() => import('../features/device')),
};

/** Tabs that work without any device (no onboarding overlay). */
const DEVICE_INDEPENDENT: ReadonlySet<TabId> = new Set(['mocks']);

function Loading() {
  return (
    <div className="feature-loading">
      <Spinner size={18} />
    </div>
  );
}

export function FeatureHost() {
  const t = useT();
  const tab = useUi((s) => s.tab);
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(() => new Set([tab]));
  const empty = useIsEmpty();
  const status = useConnection((s) => s.status);
  const everConnected = useConnection((s) => s.everConnected);

  useEffect(() => {
    setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab)));
  }, [tab]);

  const unreachable = !everConnected && (status === 'connecting' || status === 'reconnecting');
  const onboarding = !unreachable && status === 'live' && empty && !DEVICE_INDEPENDENT.has(tab);
  const overlay = unreachable ? <ServerUnreachable /> : onboarding ? <Onboarding /> : null;

  return (
    <div className="feature-host">
      {TAB_IDS.filter((id) => visited.has(id) || id === tab).map((id) => {
        const Feature = FEATURES[id];
        const active = id === tab && !overlay;
        return (
          <div
            key={id}
            id={`main-panel-${id}`}
            role="tabpanel"
            aria-labelledby={`main-tab-${id}`}
            className={clsx('feature', active ? 'is-active' : 'is-hidden')}
            inert={!active}
            aria-hidden={!active}
          >
            <FeatureContext.Provider value={{ tab: id, active }}>
              <ErrorBoundary name={t(`shell.tabs.${id}`)}>
                <Suspense fallback={<Loading />}>
                  <Feature />
                </Suspense>
              </ErrorBoundary>
            </FeatureContext.Provider>
          </div>
        );
      })}
      {overlay ? <div className="feature-overlay">{overlay}</div> : null}
    </div>
  );
}
