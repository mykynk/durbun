/**
 * Data layer barrel. Features import from here:
 *   import { logStore, useLogVersion, useCompiledScope, sendCommand, api } from '../../data';
 */

/* High-frequency stores (outside React) + hooks */
export { logStore, LogStore, isCrashEntry, isProtectedEntry, emptyLogCounts, keptAfter, PROTECTED_MAX } from './logStore';
export type { LogCounts } from './logStore';
export { networkStore, NetworkStore, isNetworkError, emptyNetworkCounts } from './networkStore';
export type { NetworkCounts } from './networkStore';
export { metricsStore, MetricsStore, metricSeriesKey } from './metricsStore';
export type { MetricSeries } from './metricsStore';
export { createFrameScheduler, VersionedStore } from './versioned';
export type { FrameScheduler, VersionedSource } from './versioned';
export {
  useStoreVersion,
  useLogVersion,
  useNetworkVersion,
  useMetricsVersion,
  useScopedLogCounts,
  useScopedNetworkCounts,
  useIngestRate,
  useNow,
} from './hooks';
export type { VersionHookOptions, IngestRate } from './hooks';

/* zustand stores */
export { useConnection, isConnected } from './stores/connection';
export type { ConnectionState, ConnectionStatus } from './stores/connection';
export {
  useHub,
  hubActions,
  useDevices,
  useDevice,
  useApps,
  useApp,
  useAppGroups,
  useDrivers,
  useDemoActive,
  useProcessName,
  useIsEmpty,
  sortDevices,
  groupApps,
  appGroupOf,
  appGroupKey,
  appGroupName,
  deviceAppKey,
  useDeviceApp,
  sameDeviceAppIgnoringActivity,
  deviceGroup,
  isDeviceUsable,
  isImportedDevice,
  isNetworkDevice,
  isReadOnlyDevice,
  DESKTOP_DEVICE_ID,
} from './stores/hub';
export type { HubState, AppGroup, DeviceGroup } from './stores/hub';
export { useScope, useScopeStore, getScope, setScope, scopeEquals, deviceAppScope, ALL_SCOPE } from './stores/scope';
export type { Scope, ScopeHint } from './stores/scope';
export { useMocks, saveMocks, useServerSettings, updateServerSettings } from './stores/server';
export type { MocksState, ServerSettingsState } from './stores/server';
export { useSlack, useSlackStatus, loadSlack, updateSlack } from './stores/slack';
export type { SlackState } from './stores/slack';
export { usePrefs, getPrefs, flushPrefs, defaultPrefs, DEFAULT_NOISE_RULES, HIGHLIGHT_COLORS, TAB_IDS } from './stores/prefs';
export type { UiPrefs, ThemePref, Density, TimeFormat, TabId, NoiseRule, HighlightRule, HighlightColor } from './stores/prefs';
export { useUi, ui } from './stores/ui';
export type { UiState, SettingsSection, SdkGuideTab, SdkGuideSection, UiFocus, MockRuleDraft } from './stores/ui';

/* scope helpers */
export {
  compileScope,
  entryInScope,
  networkInScope,
  useCompiledScope,
  scopeLogCounts,
  scopeNetworkCounts,
  scopeTarget,
  scopeSignature,
  scopeAppRef,
  scopeDeviceId,
} from './scope';
export type { CompiledScope, ScopeTarget } from './scope';
export { compileNoiseRules } from './noise';

/* wire */
export { sendCommand, sendCommandDetailed, CommandError, LOCAL_ERROR_CODES, defaultCommandTimeout } from './commands';
export type { CommandReply, CommandReplyMap, CommandName, SendCommandOptions, DetailedReply } from './commands';
export { startConnection, stopConnection, reconnectNow, sendMessage } from './ws';
export { onServerMessage, onNotice, onResync } from './events';
export * as api from './api';
export { ApiError } from './api';

/* "what can I see / where from / why not" (SPEC §10) */
export { explainSources, explainContext, explainRow, buildBadgeOf, buildKindOf, EXPLAIN_CAPABILITIES } from './explain';
export { bundlePrefix, isDeveloperInstall, ownAppIndex, isOwnApp } from './ownApps';
export type { OwnAppIndex } from './ownApps';
export type {
  ExplainCapability,
  ExplainStatus,
  ExplainSource,
  ExplainReason,
  ExplainAction,
  ExplainRow,
  ExplainInput,
  ExplainBadge,
  ExplainResult,
  ExplainContext,
  ExplainPlatform,
  ExplainTransport,
  ExplainBuild,
  BuildBadge,
} from './explain';
