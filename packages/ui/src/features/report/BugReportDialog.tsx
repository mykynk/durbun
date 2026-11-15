import './i18n';
import '../transfer/i18n';
import './report.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Bug, Camera, ChevronDown, ChevronRight, Copy, FileArchive, RotateCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { BugReportRequest, DeviceInfo, LogEntry, NetworkEntry } from '@durbun/protocol';
import { Button, Callout, Checkbox, CodeView, Dialog, Select, SlackButton, Spinner, Textarea, copyText, downloadBlob, formatClock, toast, useShortcut } from '../../components';
import { api, compileNoiseRules, compileScope, getScope, logStore, networkStore, sendCommand, useConnection, useHub, useLogVersion, useNetworkVersion, usePrefs, type Scope } from '../../data';
import { screenshotAvailability } from '../../data/explain';
import { errorText, useLanguage, useT } from '../../i18n';
import { deviceDisplayName } from '../../i18n/codes';
import { codeText, describeError } from '../device/codes';
import { mediaResult } from '../device/model';
import { addShot } from '../device/stores';
import { crashReportDownload, displayText } from '../logs/components/DetailPanel';
import { logShareReport } from '../logs/components/ShareDialog';
import { buildShareReport } from '../network/model/shareReport';
import { shareAppLabel, shareDeviceLabel, shareInputFor, shareInstallLabel, shareLabels } from '../network/share';
import { scopeExportParams } from '../transfer/dataExport';
import { bugReportLabels, durationLabel } from './i18n';
import {
  AFTER_CHOICES,
  BEFORE_CHOICES,
  DEFAULT_AFTER_S,
  DEFAULT_BEFORE_S,
  bugFileName,
  bugScope,
  bugWindow,
  buildBugReport,
  collectLogs,
  collectRequests,
  logsText,
  maskUrlsIn,
  reportableDevices,
  scopeDevice,
  windowCrashReport,
  type BugAnchor,
  type BugReportInput,
} from './model';
import { bugReport, useBugReport } from './store';

type Shot = { status: 'idle' } | { status: 'taking' } | { status: 'done'; url: string; width?: number; height?: number } | { status: 'failed'; reason: string };

interface Parts {
  logs: boolean;
  requests: boolean;
  moment: boolean;
  facts: boolean;
  crash: boolean;
  recording: boolean;
  screenshot: boolean;
}

const ALL_PARTS: Parts = { logs: true, requests: true, moment: true, facts: true, crash: true, recording: true, screenshot: true };
const ALL_DEVICES = '*';

export interface BugReportDialogProps {
  anchor: BugAnchor & { openedAt: number };
  onClose(): void;
}

/**
 * "Report a bug": the moment, its device and app, a window around it, and what goes in with counts — before
 * anything leaves the Mac. Secrets are masked every time it opens; a raw report is a deliberate choice.
 */
export function BugReportDialog({ anchor, onClose }: BugReportDialogProps) {
  const t = useT();
  const lang = useLanguage();

  // Where the report starts, fixed when the dialog opens (the line or request may leave the ring later).
  const [start] = useState(() => {
    const hub = useHub.getState();
    const entry = anchor.kind === 'log' ? logStore.getById(anchor.logId) : undefined;
    const request = anchor.kind === 'request' ? networkStore.get(anchor.netId) : undefined;
    const scope = bugScope({ entry, request }, getScope(), hub);
    const devices = reportableDevices(hub);
    // Every device in view: one phone is the obvious subject; with several the user picks (or keeps all).
    const target: Scope = scope.kind === 'all' && devices.length === 1 ? { kind: 'device', deviceId: devices[0]!.id } : scope;
    return {
      entry,
      request,
      moment: entry?.ts ?? request?.startTs ?? anchor.openedAt,
      gone: (anchor.kind === 'log' && !entry) || (anchor.kind === 'request' && !request),
      target,
      pickDevice: scope.kind === 'all' && devices.length > 1,
    };
  });

  const [target, setTarget] = useState<Scope>(start.target);
  const [beforeS, setBeforeS] = useState<number>(DEFAULT_BEFORE_S);
  const [afterS, setAfterS] = useState<number>(anchor.kind === 'now' ? 0 : DEFAULT_AFTER_S);
  const [parts, setParts] = useState<Parts>(ALL_PARTS);
  const [mask, setMask] = useState(true);
  const note = useBugReport((s) => s.draft);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const part =(key: keyof Parts) => (v: boolean) => setParts((p) => ({ ...p, [key]: v }));

  const hub = useHub(useShallow((s) => ({ devices: s.devices, apps: s.apps, deviceApps: s.deviceApps, processes: s.processes })));
  const version = useConnection((s) => s.server?.version);
  const lv = useLogVersion({ throttleMs: 1000 });
  const nv = useNetworkVersion({ throttleMs: 1000 });
  const hideNoise = usePrefs((s) => s.hideNoise);
  const noiseRules = usePrefs((s) => s.noiseRules);

  const compiled = useMemo(() => compileScope(target, hub), [target, hub]);
  const deviceId = scopeDevice(compiled);
  const device: DeviceInfo | undefined = deviceId ? hub.devices[deviceId] : undefined;
  const noDevice = reportableDevices(hub).length === 0;
  const imported = !!deviceId?.startsWith('import:');
  const win = useMemo(() => bugWindow(start.moment, beforeS, afterS), [start.moment, beforeS, afterS]);

  const noisy = useMemo(() => (hideNoise ? compileNoiseRules(noiseRules) : undefined), [hideNoise, noiseRules]);
  const logs = useMemo(() => collectLogs(logStore, compiled, win, noisy), [compiled, win, noisy, lv]); // eslint-disable-line react-hooks/exhaustive-deps
  const requests = useMemo(() => collectRequests(networkStore.list(), compiled, win), [compiled, win, nv]); // eslint-disable-line react-hooks/exhaustive-deps
  // The iOS crash report of the moment's line, else of the window's newest crash record.
  const crashReport = useMemo(() => (start.entry ? crashReportDownload(start.entry) : undefined) ?? windowCrashReport(logs.lines, crashReportDownload), [start.entry, logs.lines]);
  const crash = crashReport?.url;
  const crashFile = crashReport?.fileName;

  /* ───── facts ───── */
  const app = compiled.app;
  const deviceApp = compiled.deviceApp;
  const appLabel = target.kind === 'app' || target.kind === 'deviceApp' ? shareAppLabel(app, deviceApp, shareInstallLabel(deviceApp, app, device)) : undefined;
  const deviceLabel = shareDeviceLabel(device);
  const sdk = app ? `${app.sdk.name} ${app.sdk.version} · ${app.sdk.platform}` : undefined;

  /* ───── screenshot ───── */
  const avail = screenshotAvailability(device);
  const canShoot = avail === 'yes';
  const [shot, setShot] = useState<Shot>({ status: 'idle' });
  const shotSeq = useRef(0);
  const take = useCallback(async () => {
    if (!deviceId || !canShoot) return;
    const mine = ++shotSeq.current;
    setShot({ status: 'taking' });
    try {
      const data = await sendCommand({ name: 'device.action', deviceId, action: 'screenshot', params: {} });
      if (mine !== shotSeq.current) return;
      const m = mediaResult(data);
      if (!m) {
        setShot({ status: 'failed', reason: codeText('action.invalidResult') ?? '' });
        return;
      }
      // The Device tab's gallery keeps it too (the user can take it again from there).
      addShot({ deviceId, ...m, ts: Date.now() });
      setShot({ status: 'done', url: m.url, ...(m.width ? { width: m.width } : {}), ...(m.height ? { height: m.height } : {}) });
    } catch (err) {
      if (mine === shotSeq.current) setShot({ status: 'failed', reason: describeError(err).text });
    }
  }, [deviceId, canShoot]);
  // A fresh screenshot when the dialog opens, and again when the user picks another device.
  useEffect(() => {
    if (canShoot) void take();
    else {
      shotSeq.current++;
      setShot({ status: 'idle' });
    }
    return () => {
      shotSeq.current++;
    };
  }, [deviceId, canShoot]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ───── the report ───── */
  // The line's or request's own share report (one wording per item); app and device are in the environment above it.
  const momentText = useMemo(() => {
    if (!parts.moment) return undefined;
    if (start.entry) {
      const text = mask ? (x: LogEntry) => (x.kind === 'network' ? maskUrlsIn(displayText(x)) : displayText(x)) : displayText;
      return logShareReport(start.entry, {}, lang, text);
    }
    if (start.request) {
      const n: NetworkEntry = networkStore.get(start.request.id) ?? start.request;
      return buildShareReport(shareInputFor(n, null), { mask, bodies: false, curl: false }, shareLabels(lang));
    }
    return undefined;
  }, [parts.moment, start, mask, lang, nv]); // eslint-disable-line react-hooks/exhaustive-deps

  const shotName = shot.status === 'done' ? `screenshot${/\.(png|jpe?g|heic|webp)$/i.exec(shot.url)?.[0]?.toLowerCase() ?? '.png'}` : undefined;
  const includeShot = parts.screenshot && shot.status === 'done';
  const includeCrash = parts.crash && !!crash;
  const includeRecording = parts.recording && !noDevice;
  const allDevices = target.kind === 'all';
  const input: BugReportInput = useMemo(
    () => ({
      note,
      moment: start.moment,
      window: win,
      ...(parts.facts ? { device: deviceLabel, app: appLabel, sdk: appLabel ? sdk : undefined, durbun: version, allDevices: allDevices && !noDevice } : {}),
      momentText,
      ...(noDevice ? {} : { requests: parts.requests ? requests.failed : undefined, logs: parts.logs ? { lines: logs.lines, total: logs.total, text: displayText } : undefined }),
      mask,
    }),
    [note, start.moment, win, parts, deviceLabel, appLabel, sdk, version, allDevices, noDevice, momentText, requests, logs, mask],
  );
  const labels = useMemo(() => bugReportLabels(lang), [lang]);
  const markdown = useMemo(() => buildBugReport(input, labels), [input, labels]);
  const what = [appLabel?.split(' · ')[0], device ? deviceDisplayName(device) : undefined].filter(Boolean).join(' ');

  const empty = !noDevice && logs.total === 0 && requests.all.length === 0;

  const save = async () => {
    if (busy) return;
    const zipInput: BugReportInput = { ...input, attachments: { ...(includeShot ? { screenshot: shotName } : {}), ...(includeCrash ? { crash: crashFile } : {}), recording: includeRecording } };
    const body: BugReportRequest = {
      report: buildBugReport(zipInput, labels, { forZip: true }),
      ...(input.logs && logs.lines.length ? { logs: logsText(logs.lines, displayText, mask, [[what, `${formatClock(win.fromTs)} – ${formatClock(win.toTs)}`].filter(Boolean).join(' · ')]) } : {}),
      ...(input.requests?.length ? { requestIds: input.requests.map((n) => n.id) } : {}),
      ...(includeShot && shot.status === 'done' ? { screenshot: shot.url } : {}),
      ...(includeCrash ? { crashReport: crash } : {}),
      ...(includeRecording ? { recording: { ...(allDevices ? {} : scopeExportParams(target, hub)), fromTs: win.fromTs, toTs: win.toTs } } : {}),
      ...(mask ? {} : { mask: false }),
      name: bugFileName(what, start.moment),
    };
    setBusy(true);
    try {
      const r = await api.bugReport(body);
      downloadBlob(r.blob, r.fileName);
      const masked = mask ? t('transfer.data.doneMasked') : t('transfer.data.doneRaw');
      if (r.skipped.length) {
        const names = r.skipped.map((s) => (s === 'screenshot' ? t('report.skipped.screenshot') : s === 'crashReport' ? t('report.skipped.crashReport') : s)).join(', ');
        toast.warn(t('report.saved'), { description: `${t('report.skipped.lead', { parts: names })} ${masked}` });
      } else toast.success(t('report.saved'), { description: masked });
      bugReport.done();
    } catch (err) {
      toast.error(t('report.saveFailed'), { description: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (await copyText(markdown)) {
      toast.success(t('report.copied'), { description: mask ? t('transfer.data.doneMasked') : t('transfer.data.doneRaw') });
      bugReport.done();
    } else toast.error(t('common.copyFailed'));
  };
  useShortcut('Mod+Enter', () => void save(), { allowInModal: true, allowInInputs: true });

  const momentKey = anchor.kind === 'log' && !start.gone ? 'report.moment.log' : anchor.kind === 'request' && !start.gone ? 'report.moment.request' : 'report.moment.now';
  const shotHint =
    avail === 'noDevice' ? t('report.shot.noDevice') : avail === 'imported' ? t('report.shot.imported') : avail === 'offline' ? t('report.shot.offline') : avail === 'unsupported' ? t('report.shot.unsupported') : undefined;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      icon={Bug}
      title={t('report.title')}
      description={t('report.description')}
      initialFocus={noteRef}
      footer={
        <>
          <span className="grow" />
          <SlackButton report={markdown} onSent={bugReport.done} onConnect={onClose} />
          <Button variant="secondary" icon={Copy} onClick={() => void copy()}>
            {t('report.copy')}
          </Button>
          <Button variant={mask ? 'primary' : 'danger'} icon={FileArchive} loading={busy} onClick={() => void save()} kbd="Mod+Enter">
            {mask ? t('report.save') : t('report.saveRaw')}
          </Button>
        </>
      }
    >
      <div className="br">
        <div className="br-head">
          <span className="br-moment tnum">{t(momentKey, { time: formatClock(start.moment, { ms: true }) })}</span>
          {start.pickDevice ? (
            <label className="br-field">
              <span className="br-field__label">{t('report.target.label')}</span>
              <Select
                size="sm"
                value={target.kind === 'device' ? target.deviceId : ALL_DEVICES}
                onChange={(ev) => setTarget(ev.target.value === ALL_DEVICES ? { kind: 'all' } : { kind: 'device', deviceId: ev.target.value })}
                options={[...reportableDevices(hub).map((d) => ({ value: d.id, label: deviceDisplayName(d) })), { value: ALL_DEVICES, label: t('report.target.all') }]}
              />
            </label>
          ) : null}
          <span className="grow" />
          <label className="br-field">
            <span className="br-field__label">{t('report.window.before')}</span>
            <Select size="sm" value={String(beforeS)} onChange={(ev) => setBeforeS(Number(ev.target.value))} options={BEFORE_CHOICES.map((s) => ({ value: String(s), label: durationLabel(lang, s) }))} />
          </label>
          <label className="br-field">
            <span className="br-field__label">{t('report.window.after')}</span>
            <Select size="sm" value={String(afterS)} onChange={(ev) => setAfterS(Number(ev.target.value))} options={AFTER_CHOICES.map((s) => ({ value: String(s), label: durationLabel(lang, s) }))} />
          </label>
          <span className="br-range tnum" aria-label={t('report.window.label')}>
            {t('report.window.range', { from: formatClock(win.fromTs), to: formatClock(win.toTs) })}
          </span>
        </div>
        {start.gone ? <p className="br-hint">{t('report.moment.gone')}</p> : null}

        {noDevice ? (
          <Callout compact tone="info">
            {t('report.state.noDevice')}
          </Callout>
        ) : imported ? (
          <Callout compact tone="info">
            {t('report.state.imported')}
          </Callout>
        ) : null}
        {empty ? (
          <Callout compact tone="info">
            {t('report.state.empty')}
          </Callout>
        ) : null}
        {win.cut ? (
          <Callout compact tone="warn">
            {t('report.window.cut')}
          </Callout>
        ) : null}
        {logs.total > logs.lines.length && parts.logs ? (
          <Callout compact tone="warn">
            {t('report.state.linesCapped', { total: logs.total, count: logs.lines.length })}
          </Callout>
        ) : null}

        <div className="br-grid">
          <div className="br-main">
            <label className="br-note">
              <span className="br-section__title">{t('report.note.label')}</span>
              <Textarea ref={noteRef} rows={3} value={note} placeholder={t('report.note.placeholder')} onChange={(ev) => bugReport.setDraft(ev.target.value)} />
            </label>

            <section className="br-section" aria-label={t('report.parts.title')}>
              <h3 className="br-section__title">{t('report.parts.title')}</h3>
              {noDevice ? null : (
                <>
                  <Checkbox checked={parts.logs} onChange={part('logs')} label={<span className="tnum">{t('report.parts.logs', { count: logs.total })}</span>} />
                  <Checkbox checked={parts.requests} onChange={part('requests')} label={<span className="tnum">{t('report.parts.failed', { count: requests.failed.length })}</span>} />
                  {requests.all.length > 0 ? <p className="br-hint br-hint--indent tnum">{t('report.parts.allInWindow', { count: requests.all.length })}</p> : null}
                </>
              )}
              {start.entry || start.request ? <Checkbox checked={parts.moment} onChange={part('moment')} label={start.entry ? t('report.parts.moment') : t('report.parts.momentRequest')} /> : null}
              <Checkbox checked={parts.facts} onChange={part('facts')} label={t('report.parts.facts')} />
              {parts.facts && (deviceLabel || appLabel || version) ? (
                <p className="br-hint br-hint--indent">{[appLabel, deviceLabel, sdk && appLabel ? sdk : undefined, version ? `Dürbün ${version}` : undefined].filter(Boolean).join(' · ')}</p>
              ) : null}
              {crash ? (
                <Checkbox
                  checked={parts.crash}
                  onChange={part('crash')}
                  label={
                    <>
                      {t('report.parts.crash', { name: crashFile ?? '' })} <span className="br-zip">{t('report.parts.zipOnly')}</span>
                    </>
                  }
                />
              ) : null}
              {noDevice ? null : (
                <Checkbox
                  checked={parts.recording}
                  onChange={part('recording')}
                  label={
                    <>
                      {t('report.parts.recording')} <span className="br-zip">{t('report.parts.zipOnly')}</span>
                    </>
                  }
                />
              )}
            </section>
          </div>

          <section className="br-shot" aria-label={t('report.parts.screenshot')}>
            <Checkbox
              checked={parts.screenshot && canShoot}
              disabled={!canShoot}
              onChange={part('screenshot')}
              label={
                <>
                  {t('report.parts.screenshot')} <span className="br-zip">{t('report.parts.zipOnly')}</span>
                </>
              }
            />
            <div className="br-shot__frame">
              {shot.status === 'taking' ? (
                <span className="br-shot__state">
                  <Spinner size={14} /> {t('report.shot.taking')}
                </span>
              ) : shot.status === 'done' ? (
                <img className="br-shot__img" src={shot.url} alt={t('report.shot.alt')} onError={() => setShot({ status: 'failed', reason: t('report.shot.unreadable') })} />
              ) : shot.status === 'failed' ? (
                <span className="br-shot__state br-shot__state--error">{t('report.shot.failed', { reason: shot.reason })}</span>
              ) : (
                <span className="br-shot__state">{shotHint ?? <Camera size={16} aria-hidden />}</span>
              )}
            </div>
            {canShoot ? (
              <Button size="sm" variant="ghost" icon={shot.status === 'idle' ? Camera : RotateCw} disabled={shot.status === 'taking'} onClick={() => void take()}>
                {shot.status === 'failed' ? t('report.shot.retry') : shot.status === 'idle' ? t('report.shot.take') : t('report.shot.retake')}
              </Button>
            ) : null}
            {includeShot ? <p className="br-hint">{t('report.shot.notMasked')}</p> : null}
          </section>
        </div>

        <section className="br-section">
          <Checkbox checked={mask} onChange={setMask} label={t('transfer.data.mask')} />
          {mask ? (
            <p className="br-hint">
              <ShieldCheck size={13} aria-hidden /> {t('transfer.data.maskOn')} {t('report.maskLogs')}
            </p>
          ) : (
            <Callout compact tone="warn" icon={ShieldAlert}>
              {t('transfer.data.maskOffSession')}
            </Callout>
          )}
        </section>

        <section className="br-section">
          <button type="button" className="br-toggle" aria-expanded={preview} onClick={() => setPreview((v) => !v)}>
            {preview ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            {preview ? t('report.preview.hide') : t('report.preview.show')}
          </button>
          {preview ? <CodeView code={markdown} language="plain" lineNumbers={false} defaultWrap toolbar={false} maxHeight="min(40vh, 420px)" aria-label={t('report.preview.label')} /> : null}
          <p className="br-hint">{t('report.slackNote')}</p>
        </section>
      </div>
    </Dialog>
  );
}
