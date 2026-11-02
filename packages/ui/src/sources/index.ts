/** Source transparency (SPEC §10.5): "where does this come from / why can't I see it". */
export {
  SourceBadge,
  BuildBadgeChip,
  StatusIcon,
  SourcesPanel,
  WhatCanISeeButton,
  ScopeSourcesButton,
  ExplainEmpty,
  ExplainCallout,
  ReasonList,
  ActionButtons,
  RichText,
} from './components';
export type { ExplainEmptyProps } from './components';
export { DataSourcesDialog, DataSourcesExplainer, buildMatrix } from './DataSourcesDialog';
export { explainGroup, explainScope, groupFor, scopeGroupKeys, explainSignature, useAppExplain, useScopeExplain, pickEmptyReason } from './model';
export type { ExplainedApp, ScopeExplain, EmptyExplanation } from './model';
export { runExplainAction, actionAvailable, guideTabFor, mainPidOf } from './actions';
export {
  capabilityLabel,
  statusLabel,
  sourceLabel,
  sourceHint,
  badgeLabel,
  badgeHint,
  badgeTooltip,
  buildBadgeLabel,
  buildBadgeHint,
  reasonText,
  reasonParams,
  actionLabel,
  tipText,
  summaryText,
  originLabel,
  entryOrigin,
  entrySourceText,
  isDeviceCrashRecord,
  isUnsymbolicated,
  isKnownOrigin,
  TIP_ACTIONS,
} from './text';
