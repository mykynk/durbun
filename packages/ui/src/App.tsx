import { useEffect, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { useShallow } from 'zustand/react/shallow';
import { useLanguage } from './i18n';
import { noticeToastParts } from './shell/notices';
import { onNotice, usePrefs, useUi } from './data';
import { initHashSync } from './data/stores/ui';
import { ConfirmHost } from './components/Dialog';
import { ErrorBoundary, PartBoundary } from './components/ErrorBoundary';
import { ContextMenuHost } from './components/Menu';
import { Toaster, toast, type ToastKind } from './components/Toast';
import { Sidebar } from './shell/Sidebar';
import { TopBar } from './shell/TopBar';
import { StatusBar } from './shell/StatusBar';
import { FeatureHost } from './shell/FeatureHost';
import { ConnectionBanner, DeviceAttentionBanner } from './shell/ConnectionStates';
import { CommandPalette } from './shell/CommandPalette';
import { ShortcutsDialog } from './shell/ShortcutsDialog';
import { SettingsDialog } from './shell/SettingsDialog';
import { DoctorDialog } from './shell/DoctorDialog';
import { SdkGuideDialog } from './shell/SdkGuide';
import { DataSourcesDialog } from './sources';
import { DropImport } from './shell/DropImport';
import { TransferHost } from './features/transfer/TransferHost';
import { useGlobalCommands } from './shell/globalCommands';

const NOTICE_KIND: Record<'info' | 'success' | 'warn' | 'error', ToastKind> = { info: 'info', success: 'success', warn: 'warn', error: 'error' };

function useNoticeToasts(): void {
  useEffect(
    () =>
      onNotice((n) => {
        const { title, description } = noticeToastParts(n);
        toast({ kind: NOTICE_KIND[n.level] ?? 'info', title, description, duration: description && description.length > 90 ? 9000 : undefined });
      }),
    [],
  );
}

export function App() {
  useLanguage(); // re-render everything when the language changes
  useNoticeToasts();
  useGlobalCommands();
  useEffect(() => initHashSync(), []);
  const collapsed = usePrefs((s) => s.sidebarCollapsed);
  const { narrow, overlay } = useUi(useShallow((s) => ({ narrow: s.narrow, overlay: s.sidebarOverlay })));
  const compact = narrow ? true : collapsed;

  return (
    <>
      <div className={clsx('app', compact && 'app--compact', narrow && 'app--narrow', narrow && overlay && 'app--overlay')}>
        <PartBoundary name="sidebar">
          <Sidebar />
        </PartBoundary>
        <main className="main" aria-label="Dürbün">
          <PartBoundary name="topbar">
            <TopBar />
          </PartBoundary>
          <PartBoundary name="banners">
            <ConnectionBanner />
            <DeviceAttentionBanner />
          </PartBoundary>
          <FeatureHost />
        </main>
        <PartBoundary name="statusbar">
          <StatusBar />
        </PartBoundary>
      </div>
      <DialogBoundary>
        <CommandPalette />
        <ShortcutsDialog />
        <SettingsDialog />
        <DoctorDialog />
        <SdkGuideDialog />
        <DataSourcesDialog />
      </DialogBoundary>
      <TransferHost />
      <DropImport />
      <ConfirmHost />
      <ContextMenuHost />
      <Toaster />
    </>
  );
}

/**
 * Global dialogs: one that crashes closes (the error reaches the console and, in the Mac app, its log)
 * instead of blanking the window, and opening any dialog again retries.
 */
function DialogBoundary({ children }: { children: ReactNode }) {
  const openKey = useUi((s) => `${s.palette}|${s.shortcuts}|${s.settings}|${s.doctor}|${s.sdkGuide}|${s.dataSources}`);
  return (
    <ErrorBoundary name="dialogs" resetKey={openKey} fallback={() => null}>
      {children}
    </ErrorBoundary>
  );
}
