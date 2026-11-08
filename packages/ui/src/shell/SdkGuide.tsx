import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Archive, BookOpen, Cable, FolderOpen, Plug, ShieldCheck, Wifi, Zap } from 'lucide-react';
import { DEFAULT_PORTS } from '@durbun/protocol';
import { useLanguage, useT } from '../i18n';
import { isConnected, ui, updateServerSettings, useConnection, useDevices, useServerSettings, useUi, type SdkGuideSection, type SdkGuideTab } from '../data';
import { Dialog, confirm } from '../components/Dialog';
import { Tabs } from '../components/Tabs';
import { Button } from '../components/Button';
import { Input, Select, Textarea } from '../components/Form';
import { Callout } from '../components/Layout';
import { CopyButton } from '../components/CopyButton';
import { SegmentedControl, Toggle } from '../components/Controls';
import { toast } from '../components/Toast';
import { usePersistentState } from '../hooks';
import { deviceDisplayName } from '../i18n/codes';
import { attachVm, errorMessage } from './actions';
import { Snippet } from './Snippet';
import * as S from './sdkSnippets';
import { sdkHostLines } from './sdkHosts';
import { BUILD_REPO_DIR, HAS_BUILD_REPO_DIR } from './repo';

/** Where the snippets take the SDK from: the package registries, or a local clone of the repository. */
type SdkSource = 'registry' | 'local';

const TABS: SdkGuideTab[] = ['flutter', 'android', 'ios', 'react-native'];

function Step({ n, title, children }: { n: number; title: ReactNode; children: ReactNode }) {
  return (
    <li className="sdk-step">
      <span className="sdk-step__num" aria-hidden>
        {n}
      </span>
      <div className="sdk-step__body">
        <h3 className="sdk-step__title">{title}</h3>
        {children}
      </div>
    </li>
  );
}

/** "SDK kurulumu": per-platform setup with copyable snippets, connection notes and VM attach. */
export function SdkGuideDialog() {
  const tab = useUi((s) => s.sdkGuide);
  const t = useT();
  return (
    <Dialog open={tab !== null} onClose={ui.closeSdkGuide} title={t('shell.sdk.title')} description={t('shell.sdk.description')} icon={BookOpen} size="xl" className="sdk-dialog" autoFocusField={false}>
      {tab ? <SdkGuideBody tab={tab} /> : null}
    </Dialog>
  );
}

/** Scroll to the section a link asked for ("İç test derlemesinde aç" → release), once per request. */
function useSectionScroll(tab: SdkGuideTab) {
  const section = useUi((s) => s.sdkGuideSection);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!section) return;
    // 'setup' is the top of the guide: keep the tabs and the "works without the SDK" note in view.
    if (section === 'setup') {
      ui.consumeSdkGuideSection();
      return;
    }
    const id = requestAnimationFrame(() => {
      const el = root.current?.querySelector<HTMLElement>(`[data-sdk-section="${section}"]`);
      if (el) {
        el.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
        el.classList.add('is-flash');
        setTimeout(() => el.classList.remove('is-flash'), 1200);
      }
      ui.consumeSdkGuideSection();
    });
    return () => cancelAnimationFrame(id);
  }, [section, tab]);
  return root;
}

function Section({ id, title, children }: { id: SdkGuideSection | 'optional'; title: ReactNode; children: ReactNode }) {
  return (
    <section className="sdk-section" data-sdk-section={id}>
      <h3 className="sdk-section__title">{title}</h3>
      {children}
    </section>
  );
}

function SdkGuideBody({ tab }: { tab: SdkGuideTab }) {
  const t = useT();
  const [repo, setRepo] = usePersistentState('sdk.repoDir', BUILD_REPO_DIR);
  const repoDir = repo.trim().replace(/\/+$/, '') || BUILD_REPO_DIR;
  // A build made inside a clone (npm run app:dist, the CLI) starts on that folder; a release build on the registries.
  const [sourceRaw, setSource] = usePersistentState<SdkSource>('sdk.source', HAS_BUILD_REPO_DIR ? 'local' : 'registry');
  const source: SdkSource = sourceRaw === 'local' ? 'local' : 'registry';
  const local = source === 'local' ? repoDir : undefined;
  const root = useSectionScroll(tab);
  return (
    <div className="sdk" ref={root}>
      <Tabs
        value={tab}
        onChange={(v) => ui.openSdkGuide(v)}
        items={TABS.map((id) => ({ value: id, label: t(`shell.sdk.tabs.${id}`) }))}
        idPrefix="sdk"
        aria-label={t('shell.sdk.title')}
      />
      <div className="sdk__grid" role="tabpanel" id={`sdk-panel-${tab}`} aria-labelledby={`sdk-tab-${tab}`}>
        <div className="sdk__main">
          <div className="sdk-repo">
            <span className="sdk-repo__label">{t('shell.sdk.source')}</span>
            <SegmentedControl
              size="sm"
              value={source}
              onChange={setSource}
              aria-label={t('shell.sdk.source')}
              options={[
                { value: 'registry', label: t('shell.sdk.sourceRegistry') },
                { value: 'local', label: t('shell.sdk.sourceLocal') },
              ]}
            />
          </div>
          {source === 'local' ? (
            <div className="sdk-repo">
              <FolderOpen size={14} aria-hidden className="subtle" />
              <label htmlFor="sdk-repo" className="sdk-repo__label">
                {t('shell.sdk.repoDir')}
              </label>
              <Input id="sdk-repo" size="sm" mono value={repo} onChange={(e) => setRepo(e.target.value)} wrapperClassName="grow" className="grow" />
            </div>
          ) : null}
          {tab === 'flutter' ? <FlutterGuide repo={local} /> : null}
          {tab === 'android' ? <AndroidGuide repo={local} /> : null}
          {tab === 'ios' ? <IosGuide repo={local} /> : null}
          {tab === 'react-native' ? <RnGuide repo={local} /> : null}
        </div>
        <aside className="sdk__aside">
          <ConnectionNotes tab={tab} />
        </aside>
      </div>
    </div>
  );
}

/** `repo`: the local clone's folder; undefined → the package registries. */
function FlutterGuide({ repo }: { repo?: string }) {
  const t = useT();
  const lang = useLanguage();
  return (
    <>
      <Callout
        tone="info"
        icon={Zap}
        title={t('shell.sdk.flutter.zeroTitle')}
        className="sdk-zero"
        actions={
          <Button size="sm" variant="ghost" icon={BookOpen} onClick={() => ui.openDataSources()}>
            {t('shell.sdk.flutter.sourcesLink')}
          </Button>
        }
      >
        {t('shell.sdk.flutter.zeroBody')}
      </Callout>
      <Section id="setup" title={t('shell.sdk.flutter.setupTitle')}>
        <ol className="sdk-steps">
          <Step n={1} title={t('shell.sdk.flutter.add')}>
            <p className="sdk-p">{t(repo ? 'shell.sdk.flutter.addHint' : 'shell.sdk.flutter.addHintRegistry')}</p>
            <Snippet title="pubspec.yaml" lang="yaml" code={repo ? S.flutterPubspec(repo) : S.flutterPubspecRegistry()} />
          </Step>
          <Step n={2} title={t('shell.sdk.flutter.wrap')}>
            <p className="sdk-p">{t('shell.sdk.flutter.wrapHint')}</p>
            <Snippet title="lib/main.dart" lang="dart" code={S.flutterMain(lang)} />
          </Step>
        </ol>
        <p className="sdk-p sdk-done">{t('shell.sdk.flutter.done')}</p>
      </Section>
      <Section id="release" title={t('shell.sdk.flutter.releaseTitle')}>
        <p className="sdk-p">{t('shell.sdk.flutter.releaseHint')}</p>
        <Snippet lang="shell" code={S.flutterReleaseFlag(lang)} />
        <Callout tone="info" icon={Archive} compact title={t('shell.sdk.flutter.releaseArchiveTitle')}>
          {t('shell.sdk.flutter.releaseArchive')}
        </Callout>
      </Section>
      <Section id="native" title={t('shell.sdk.flutter.nativeTitle')}>
        <p className="sdk-p">{t('shell.sdk.flutter.nativeAndroid')}</p>
        <Snippet title="android/app/src/main/kotlin/…" lang="kotlin" code={S.flutterNativeAndroid(lang)} />
        <p className="sdk-p">{t('shell.sdk.flutter.nativeIos')}</p>
      </Section>
      <Section id="optional" title={t('shell.sdk.flutter.optionalTitle')}>
        <ol className="sdk-steps sdk-steps--plain">
          <Step n={1} title={t('shell.sdk.flutter.use')}>
            <p className="sdk-p">{t('shell.sdk.flutter.useHint')}</p>
            <Snippet lang="dart" code={S.flutterUsage(lang)} />
          </Step>
          <Step n={2} title={t('shell.sdk.flutter.dio')}>
            <p className="sdk-p">{t('shell.sdk.flutter.dioHint')}</p>
            <Snippet title="pubspec.yaml" lang="yaml" code={repo ? S.flutterDioPubspec(repo) : S.flutterDioPubspecRegistry()} />
            <Snippet lang="dart" code={S.FLUTTER_DIO} />
          </Step>
        </ol>
      </Section>
      <Section id="vm" title={t('shell.sdk.flutter.noSdk')}>
        <p className="sdk-p">{t('shell.sdk.flutter.noSdkHint')}</p>
        <VmAttach />
      </Section>
    </>
  );
}

function VmAttach() {
  const t = useT();
  const [input, setInput] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [busy, setBusy] = useState(false);
  const devices = useDevices().filter((d) => d.state === 'online' && !d.id.startsWith('import:') && d.id !== 'desktop' && !d.id.startsWith('net:'));
  const autoAttach = useServerSettings((s) => s.settings.autoAttachVmService);
  const connected = isConnected(useConnection((s) => s.status));
  const submit = async () => {
    setBusy(true);
    const ok = await attachVm(input, deviceId || undefined);
    setBusy(false);
    if (ok) setInput('');
  };
  return (
    <div className="vm-attach">
      <Toggle
        checked={autoAttach}
        disabled={!connected}
        onChange={(v) => updateServerSettings({ autoAttachVmService: v }).catch((err) => toast.error(t('shell.settings.saveFailed'), { description: errorMessage(err) }))}
        label={t('shell.settings.autoAttachVm')}
        description={t('shell.settings.autoAttachVmHint')}
      />
      <Textarea
        mono
        rows={3}
        value={input}
        placeholder={t('shell.sdk.vmPlaceholder')}
        aria-label={t('shell.sdk.vmPlaceholder')}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
      <div className="row gap-2">
        <Select
          size="sm"
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          aria-label={t('shell.sdk.vmDevice')}
          options={[{ value: '', label: t('shell.sdk.vmDeviceAuto') }, ...devices.map((d) => ({ value: d.id, label: deviceDisplayName(d) }))]}
        />
        <span className="grow" />
        <Button variant="primary" size="sm" icon={Plug} loading={busy} disabled={!input.trim() || !connected} onClick={() => void submit()}>
          {t('shell.sdk.vmAttach')}
        </Button>
      </div>
    </div>
  );
}

function AndroidGuide({ repo }: { repo?: string }) {
  const t = useT();
  const lang = useLanguage();
  return (
    <ol className="sdk-steps" data-sdk-section="setup">
      {repo ? (
        <Step n={1} title={t('shell.sdk.android.modules')}>
          <p className="sdk-p">{t('shell.sdk.android.modulesHint')}</p>
          <Snippet title="settings.gradle.kts" lang="kotlin" code={S.androidSettings(repo)} />
          <Snippet title={t('shell.sdk.android.groovy')} lang="kotlin" code={S.androidSettingsGroovy(repo)} />
          <Snippet title="app/build.gradle.kts" lang="kotlin" code={S.androidDependencies(lang)} />
        </Step>
      ) : (
        <Step n={1} title={t('shell.sdk.android.deps')}>
          <p className="sdk-p">{t('shell.sdk.android.depsHint')}</p>
          <Snippet title="app/build.gradle.kts" lang="kotlin" code={S.androidDependenciesRegistry(lang)} />
        </Step>
      )}
      <Step n={2} title={t('shell.sdk.android.start')}>
        <div data-sdk-section="native">
          <p className="sdk-p">{t('shell.sdk.android.startHint')}</p>
          <Snippet lang="kotlin" code={S.androidStart(lang)} />
        </div>
      </Step>
      <Step n={3} title={t('shell.sdk.android.use')}>
        <p className="sdk-p">{t('shell.sdk.android.useHint')}</p>
        <Snippet lang="kotlin" code={S.androidUsage(lang)} />
      </Step>
    </ol>
  );
}

function IosGuide({ repo }: { repo?: string }) {
  const t = useT();
  const lang = useLanguage();
  const where = repo ? `${repo}/sdks/ios` : S.REPO_URL;
  return (
    <ol className="sdk-steps" data-sdk-section="setup">
      <Step n={1} title={t('shell.sdk.ios.add')}>
        <p className="sdk-p">{t(repo ? 'shell.sdk.ios.addHint' : 'shell.sdk.ios.addHintRegistry')}</p>
        <div className="sdk-path">
          <code className="mono selectable">{where}</code>
          <CopyButton size="sm" value={where} />
        </div>
        <p className="sdk-p">{t('shell.sdk.ios.productHint')}</p>
        <p className="sdk-p subtle">{t('shell.sdk.ios.spmHint')}</p>
        <Snippet lang="swift" code={repo ? S.iosPackage(repo, lang) : S.iosPackageRegistry(lang)} />
        {repo ? null : (
          <>
            <p className="sdk-p subtle">{t('shell.sdk.ios.podHint')}</p>
            <Snippet title="Podfile" lang="shell" code={S.iosPodfile(lang)} />
          </>
        )}
      </Step>
      <Step n={2} title={t('shell.sdk.ios.start')}>
        <p className="sdk-p">{t('shell.sdk.ios.startHint')}</p>
        <Snippet lang="swift" code={S.iosStart(lang)} />
      </Step>
      <Step n={3} title={t('shell.sdk.ios.use')}>
        <Snippet lang="swift" code={S.iosUsage(lang)} />
      </Step>
    </ol>
  );
}

function RnGuide({ repo }: { repo?: string }) {
  const t = useT();
  const lang = useLanguage();
  const first = repo ? 2 : 1;
  return (
    <ol className="sdk-steps" data-sdk-section="setup">
      {repo ? (
        <Step n={1} title={t('shell.sdk.rn.build')}>
          <p className="sdk-p">{t('shell.sdk.rn.buildHint')}</p>
          <Snippet lang="shell" code={S.rnPack(repo, lang)} />
        </Step>
      ) : null}
      <Step n={first} title={t('shell.sdk.rn.add')}>
        <Snippet lang="shell" code={repo ? S.rnInstall(repo, lang) : S.rnInstallRegistry()} />
        <p className="sdk-p subtle">{t(repo ? 'shell.sdk.rn.metroHint' : 'shell.sdk.rn.registryHint')}</p>
      </Step>
      <Step n={first + 1} title={t('shell.sdk.rn.start')}>
        <p className="sdk-p">{t('shell.sdk.rn.startHint')}</p>
        <Snippet title="index.js" lang="js" code={S.rnStart(lang)} />
      </Step>
      <Step n={first + 2} title={t('shell.sdk.rn.use')}>
        <Snippet lang="js" code={S.rnUsage(lang)} />
      </Step>
    </ol>
  );
}

function ConnectionNotes({ tab }: { tab: SdkGuideTab }) {
  const t = useT();
  const lang = useLanguage();
  const server = useConnection((s) => s.server);
  const allowLan = useServerSettings((s) => s.settings.allowLan);
  const connected = isConnected(useConnection((s) => s.status));
  const sdkPort = server?.ports.sdk ?? DEFAULT_PORTS.sdk;
  const httpPort = server?.ports.http ?? DEFAULT_PORTS.http;
  const hosts = server?.hostAddresses ?? [];
  const [host, setHost] = useState<string | null>(null);
  const current = host && hosts.includes(host) ? host : (hosts[0] ?? '192.168.1.20');
  const wifiLine = sdkHostLines(current, { http: httpPort, sdk: sdkPort }).find((l) => l.sdk === tab)?.code ?? '';

  const enableLan = async () => {
    const ok = await confirm({ title: t('shell.settings.lanConfirmTitle'), message: t('shell.settings.lanConfirmMessage'), confirmLabel: t('shell.settings.lanConfirm') });
    if (!ok) return;
    try {
      await updateServerSettings({ allowLan: true });
    } catch (err) {
      toast.error(t('shell.settings.saveFailed'), { description: errorMessage(err) });
    }
  };

  return (
    <div className="sdk-notes">
      <section className="sdk-note">
        <h3 className="sdk-note__title">
          <Cable size={14} aria-hidden /> {t('shell.sdk.usbTitle')}
        </h3>
        <p className="sdk-p">{t(`shell.sdk.usb.${tab}`)}</p>
        {sdkPort !== DEFAULT_PORTS.sdk || httpPort !== DEFAULT_PORTS.http ? <p className="sdk-p subtle">{t('shell.sdk.customPorts', { port: sdkPort, http: httpPort })}</p> : null}
      </section>
      <section className="sdk-note">
        <h3 className="sdk-note__title">
          <Wifi size={14} aria-hidden /> {t('shell.sdk.wifiTitle')}
        </h3>
        <p className="sdk-p">{t(`shell.sdk.wifi.${tab}`, { port: sdkPort, http: httpPort })}</p>
        {hosts.length > 1 ? (
          <div className="host-list">
            {hosts.map((h) => (
              <button key={h} type="button" className="host-chip mono host-chip--button" aria-pressed={h === current} onClick={() => setHost(h)}>
                {h}
              </button>
            ))}
          </div>
        ) : null}
        <Snippet lang={tab === 'flutter' ? 'shell' : tab === 'android' ? 'kotlin' : tab === 'ios' ? 'swift' : 'js'} code={wifiLine} />
        {hosts.length === 0 ? <p className="sdk-p subtle">{t('shell.sdk.noHosts')}</p> : null}
        {allowLan ? (
          <p className="sdk-p subtle">{t('shell.sdk.lanOn')}</p>
        ) : (
          <Callout
            tone="info"
            compact
            actions={
              <Button size="sm" onClick={() => void enableLan()} disabled={!connected}>
                {t('shell.sdk.enableLan')}
              </Button>
            }
          >
            {t('shell.sdk.lanOff')}
          </Callout>
        )}
        {tab === 'react-native' ? <p className="sdk-p subtle">{t('shell.settings.lanRnNote', { port: httpPort })}</p> : null}
        {tab === 'ios' || tab === 'flutter' || tab === 'react-native' ? (
          <>
            <p className="sdk-p subtle">{t('shell.sdk.iosLocalNetwork')}</p>
            <Snippet title="Info.plist" lang="text" code={S.iosLocalNetwork(lang)} />
          </>
        ) : null}
      </section>
      <section className="sdk-note">
        <h3 className="sdk-note__title">
          <ShieldCheck size={14} aria-hidden /> {t('shell.sdk.releaseTitle')}
        </h3>
        <p className="sdk-p">{t(`shell.sdk.releaseBy.${tab}`)}</p>
        <button type="button" className="src-link" onClick={() => ui.openDataSources()}>
          <BookOpen size={13} aria-hidden />
          {t('shell.sdk.flutter.sourcesLink')}
        </button>
      </section>
    </div>
  );
}
