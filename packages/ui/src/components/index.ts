/**
 * Foundation component library + hooks + formatters. Features import everything from here:
 *   import { Button, JsonTree, useShortcut, formatBytes, toast } from '../../components';
 */
export { Button, IconButton } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize, IconButtonProps } from './Button';
export { Toggle, Checkbox, SegmentedControl } from './Controls';
export type { ToggleProps, CheckboxProps, SegmentOption, SegmentedControlProps } from './Controls';
export { Chip, CountBadge, StatusDot, TagChip, LevelBadge, MethodBadge, StatusBadge, levelLabel, methodClass, statusClass } from './Badges';
export type { Tone, ChipProps, TagChipProps } from './Badges';
export { Kbd } from './Kbd';
export { Spinner } from './Spinner';
export { Sparkline } from './Sparkline';
export type { SparklineProps } from './Sparkline';
export { Tooltip } from './Tooltip';
export type { TooltipProps } from './Tooltip';
export { Popover } from './Popover';
export type { PopoverProps } from './Popover';
export { Menu, DropdownMenu, openContextMenu, closeContextMenu, ContextMenuHost } from './Menu';
export type { MenuItem, MenuProps, MenuTriggerProps } from './Menu';
export { Dialog, confirm, ConfirmHost } from './Dialog';
export type { DialogProps, ConfirmOptions } from './Dialog';
export { toast, dismissToast, Toaster } from './Toast';
export type { ToastInput, ToastKind } from './Toast';
export { Tabs } from './Tabs';
export type { TabItem, TabsProps } from './Tabs';
export { SplitPane } from './SplitPane';
export type { SplitPaneProps } from './SplitPane';
export { Toolbar, ToolbarSeparator, ToolbarSpacer, ToolbarGroup, Card, Callout, EmptyState } from './Layout';
export type { CardProps, CalloutProps, EmptyStateProps } from './Layout';
export { SearchInput } from './SearchInput';
export type { SearchInputProps } from './SearchInput';
export { Field, Input, Select, Textarea, useFieldId } from './Form';
export type { FieldProps, InputProps, SelectProps, TextareaProps } from './Form';
export { KeyValueTable } from './KeyValueTable';
export type { KeyValueRow, KeyValueTableProps } from './KeyValueTable';
export { JsonTree } from './JsonTree';
export type { JsonTreeProps } from './JsonTree';
export { CodeView } from './CodeView';
export type { CodeViewProps } from './CodeView';
export { CopyButton } from './CopyButton';
export type { CopyButtonProps } from './CopyButton';
export { Highlight, findRanges } from './Highlight';
export { ErrorBoundary } from './ErrorBoundary';
export { FeatureContext, useFeatureActive, useFeatureTab } from './FeatureContext';
export type { FeatureContextValue } from './FeatureContext';
export { AndroidIcon, DurbunMark, PlatformIcon, SdkBadge, sdkLabel } from './Icons';
export type { IconType } from './Icons';
export { Portal, computePlacement, useFloating } from './floating';
export type { Side, Align, AnchorSource } from './floating';

/* hooks */
export { useShortcut, useCommands, usePersistentState, useEvent, useElementSize, useMediaQuery, useOutsidePointerDown } from '../hooks';

/* formatters & helpers */
export {
  formatBytes,
  formatDuration,
  formatTime,
  formatClock,
  formatOffset,
  formatRelative,
  formatDateTime,
  formatNumber,
  formatCompact,
  formatPercent,
} from '../lib/format';
export type { TimeFormatMode } from '../lib/format';
export { copyText } from '../lib/clipboard';
export { downloadUrl, downloadBlob, downloadText, pickFiles } from '../lib/download';
export { fuzzyMatch, fuzzyFilter, fold } from '../lib/fuzzy';
export type { FuzzyMatch, FuzzyResult } from '../lib/fuzzy';
export { hashHue, fnv1a } from '../lib/hash';
export { jsonPath, tryParseJson, prettyJson, looksLikeJson, previewValue, valueToText, detectCodeLanguage } from '../lib/json';
export type { CodeLanguage, PathSegment } from '../lib/json';
export { formatCombo, comboLabels, parseCombo } from '../lib/shortcuts';
export type { ShortcutOptions, ShortcutHandler } from '../lib/shortcuts';
export { registerCommands, getAllCommands } from '../lib/commands';
export type { PaletteCommand } from '../lib/commands';
export { notifyDesktop, requestNotificationPermission, notificationPermission } from '../lib/notify';
export { isMac } from '../lib/platform';
