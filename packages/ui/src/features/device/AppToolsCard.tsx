import { useEffect, useRef, useState } from 'react';
import { FileText, ScrollText, Wrench } from 'lucide-react';
import type { AppActionDescriptor, AppSession, LogEntry } from '@durbun/protocol';
import { logStore, sendCommand, ui } from '../../data';
import { Button, CodeView, CopyButton, Dialog, SdkBadge, SegmentedControl, Select, Spinner, StatusDot, Toggle, previewValue, toast } from '../../components';
import { hasMessage, useT } from '../../i18n';
import { describeError } from './codes';
import { ACTION_GROUP_ORDER, actionGroups, appActionParams, builtinLabelId, dumpReply, isDumpAction, isDumpMessage } from './model';
import { DeviceCard } from './useAction';
import { ExplainCallout, pickEmptyReason, useScopeExplain } from '../../sources';

interface DumpState {
  title: string;
  app: string;
  text?: string;
  lines?: number;
  logId?: number;
  waiting: boolean;
}

type Value = boolean | string;
const OVERRIDE_MS = 3000;

function actionLabel(t: (k: string) => string, a: AppActionDescriptor): string {
  const id = builtinLabelId(a);
  return id && hasMessage(`device.tools.action.${id}`) ? t(`device.tools.action.${id}`) : a.label || a.id;
}

function optionLabel(t: (k: string) => string, a: AppActionDescriptor, o: { value: string; label: string }): string {
  return builtinLabelId(a) && hasMessage(`device.tools.option.${o.value}`) ? t(`device.tools.option.${o.value}`) : o.label || o.value;
}

function groupLabel(t: (k: string) => string, group: string): string {
  return (ACTION_GROUP_ORDER as readonly string[]).includes(group) ? t(`device.tools.group.${group}`) : group;
}

/** Find the log row a dump command produced (searching entries that arrived after `afterId`). */
function findDumpEntry(afterId: number, session: AppSession, sessionIds: ReadonlySet<string>, actionId: string, lines?: number): LogEntry | undefined {
  const entries = logStore.entries;
  for (let i = logStore.lowerBound(afterId + 1); i < entries.length; i++) {
    const e = entries[i]!;
    const mine = (e.appId !== undefined && sessionIds.has(e.appId)) || (e.deviceId === session.deviceId && e.pid !== undefined && e.pid === session.app.pid);
    if (mine && isDumpMessage(e.message, actionId, lines)) return e;
  }
  return undefined;
}

/**
 * Debug tools advertised by connected app sessions (`AppSession.actions`), grouped (Flutter, Android, iOS,
 * React Native, Web, app-specific). Toggles and selects send `{ value }`, buttons `{}` (SPEC §9.4); dumps open
 * a viewer with the text from the reply or, when the reply has none, the matching log row.
 */
export function AppToolsCard({ sessions, preferredAppId }: { sessions: readonly AppSession[]; preferredAppId?: string }) {
  const t = useT();
  const [pending, setPending] = useState<ReadonlyMap<string, Value | null>>(() => new Map());
  const [overrides, setOverrides] = useState<ReadonlyMap<string, { value: Value; until: number }>>(() => new Map());
  const [dump, setDump] = useState<DumpState | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  // Expire optimistic values (the SDK confirms with an `actions` update).
  useEffect(() => {
    if (overrides.size === 0) return;
    const next = Math.min(...[...overrides.values()].map((o) => o.until));
    const id = setTimeout(() => setOverrides((m) => new Map([...m].filter(([, o]) => o.until > Date.now()))), Math.max(50, next - Date.now()));
    return () => clearTimeout(id);
  }, [overrides]);

  // The scoped app cannot have in-app tools (no SDK / store build): say why and what would enable them.
  const scopeExplain = useScopeExplain();
  const toolsStructural = scopeExplain.kind !== 'none' && pickEmptyReason('tools', scopeExplain).structural;

  const live = sessions
    .filter((s) => s.connected && s.actions.length > 0)
    .sort((a, b) => Number(b.app.id === preferredAppId) - Number(a.app.id === preferredAppId) || a.app.name.localeCompare(b.app.name));

  const send = async (session: AppSession, a: AppActionDescriptor, value?: Value) => {
    const key = `${session.id}|${a.id}`;
    if (pending.has(key)) return;
    const label = actionLabel(t, a);
    setPending((m) => new Map(m).set(key, value ?? null));
    const startId = logStore.lastId;
    try {
      const data = await sendCommand({ name: 'app.action', appId: session.id, action: a.id, params: appActionParams(a, value) });
      if (a.kind !== 'button') {
        if (value !== undefined) setOverrides((m) => new Map(m).set(key, { value, until: Date.now() + OVERRIDE_MS }));
        return;
      }
      const reply = dumpReply(data);
      if (isDumpAction(a.id) || reply.text) {
        openDump(session, a, label, reply, startId);
        return;
      }
      const summary = data === null || data === undefined ? undefined : previewValue(data, 120);
      toast.success(t('device.tools.done', { action: label }), { description: summary });
    } catch (err) {
      toast.error(t('device.tools.failed', { action: label }), { description: describeError(err).text });
    } finally {
      setPending((m) => {
        const next = new Map(m);
        next.delete(key);
        return next;
      });
    }
  };

  const openDump = (session: AppSession, a: AppActionDescriptor, label: string, reply: { text?: string; lines?: number }, startId: number) => {
    cleanup.current?.();
    const ids = new Set(sessions.filter((s) => s.deviceId === session.deviceId && s.app.id === session.app.id).map((s) => s.id));
    const app = session.app.name || session.app.id;
    const found = findDumpEntry(startId, session, ids, a.id, reply.lines);
    const text = reply.text ?? found?.message;
    setDump({ title: label, app, text, lines: reply.lines ?? text?.split('\n').length, logId: found?.id, waiting: !found });
    if (found) return;
    // The log row may arrive a moment after the reply (batched); watch the store briefly.
    const unsub = logStore.subscribe(() => {
      const e = findDumpEntry(startId, session, ids, a.id, reply.lines);
      if (!e) return;
      stop();
      setDump((d) => (d ? { ...d, text: d.text ?? e.message, lines: d.lines ?? e.message.split('\n').length, logId: e.id, waiting: false } : d));
    });
    const timer = setTimeout(() => {
      stop();
      setDump((d) => (d ? { ...d, waiting: false } : d));
    }, 5000);
    const stop = () => {
      unsub();
      clearTimeout(timer);
      if (cleanup.current === stop) cleanup.current = null;
    };
    cleanup.current = stop;
  };

  return (
    <DeviceCard section="tools" title={t('device.tools.title')} icon={Wrench} description={t('device.tools.description')}>
      {live.length === 0 && toolsStructural ? (
        <ExplainCallout capability="tools" className="dv-explain" />
      ) : live.length === 0 ? (
        <div className="dv-empty-inline">
          <p className="dv-muted">{t('device.tools.empty')}</p>
          <p className="dv-hint">{t('device.tools.emptyHint')}</p>
          <Button size="sm" variant="ghost" onClick={() => ui.openSdkGuide()}>
            {t('device.tools.sdkGuide')}
          </Button>
        </div>
      ) : (
        <div className="dv-tools">
          {/* The scoped app has no tools of its own (other apps on the device do): say so above theirs. */}
          {toolsStructural ? <ExplainCallout capability="tools" className="dv-explain" /> : null}
          {live.map((s) => (
            <section key={s.id} className="dv-tools__app" aria-label={s.app.name}>
              <header className="dv-tools__head">
                <StatusDot tone="success" size={7} />
                <span className="dv-tools__name">{s.app.name || s.app.id}</span>
                {s.app.version ? <span className="mono subtle">{s.app.version}</span> : null}
                <SdkBadge platform={s.sdk.platform} />
              </header>
              {actionGroups(s.actions).map(({ group, actions }) => (
                <div key={group} className="dv-tools__group">
                  <div className="dv-tools__group-title">{groupLabel(t, group)}</div>
                  <div className="dv-tools__items">
                    {actions.map((a) => {
                      const key = `${s.id}|${a.id}`;
                      const isPending = pending.has(key);
                      const pendingValue = pending.get(key);
                      const override = overrides.get(key);
                      const value = pendingValue ?? (override && override.value !== a.value ? override.value : a.value);
                      const label = actionLabel(t, a);
                      if (a.kind === 'toggle')
                        return <Toggle key={a.id} size="sm" className="dv-tools__toggle" label={label} checked={value === true} disabled={isPending} onChange={(v) => void send(s, a, v)} />;
                      if (a.kind === 'select') {
                        const options = (a.options ?? []).map((o) => ({ value: o.value, label: optionLabel(t, a, o) }));
                        return (
                          <div key={a.id} className="dv-tools__select">
                            <span className="dv-tools__label">{label}</span>
                            {options.length <= 4 ? (
                              <SegmentedControl<string>
                                size="sm"
                                value={typeof value === 'string' ? value : ''}
                                aria-label={label}
                                onChange={(v) => void send(s, a, v)}
                                options={options.map((o) => ({ ...o, disabled: isPending }))}
                              />
                            ) : (
                              <Select size="sm" aria-label={label} value={typeof value === 'string' ? value : ''} disabled={isPending} options={options} onChange={(e) => void send(s, a, e.target.value)} />
                            )}
                          </div>
                        );
                      }
                      return null;
                    })}
                  </div>
                  {actions.some((a) => a.kind === 'button') ? (
                    <div className="dv-tools__buttons">
                      {actions
                        .filter((a) => a.kind === 'button')
                        .map((a) => (
                          <Button key={a.id} size="sm" icon={isDumpAction(a.id) ? FileText : undefined} loading={pending.has(`${s.id}|${a.id}`)} onClick={() => void send(s, a)}>
                            {actionLabel(t, a)}
                          </Button>
                        ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
      <Dialog
        open={dump !== null}
        onClose={() => {
          cleanup.current?.();
          setDump(null);
        }}
        size="xl"
        icon={FileText}
        title={dump?.title}
        description={dump ? [dump.app, dump.lines ? t('device.tools.dump.lines', { count: dump.lines }) : null].filter(Boolean).join(' · ') : undefined}
        autoFocusField={false}
        footer={
          dump ? (
            <>
              {dump.logId !== undefined ? (
                <Button
                  variant="ghost"
                  icon={ScrollText}
                  onClick={() => {
                    const id = dump.logId!;
                    setDump(null);
                    ui.focusLog(id);
                  }}
                >
                  {t('device.tools.dump.showInLogs')}
                </Button>
              ) : null}
              <span className="grow" />
              {dump.text ? <CopyButton value={dump.text} text={t('common.copy')} size="md" /> : null}
              <Button variant="primary" onClick={() => setDump(null)}>
                {t('common.close')}
              </Button>
            </>
          ) : undefined
        }
      >
        {dump ? (
          dump.text ? (
            <CodeView code={dump.text} language="plain" maxHeight="62vh" defaultWrap={false} aria-label={dump.title} />
          ) : dump.waiting ? (
            <div className="dv-loading">
              <Spinner size={14} /> {t('device.tools.dump.waiting')}
            </div>
          ) : (
            <p className="dv-muted">{t('device.tools.dump.notFound')}</p>
          )
        ) : null}
      </Dialog>
    </DeviceCard>
  );
}
