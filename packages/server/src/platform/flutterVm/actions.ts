/**
 * Flutter app actions (SPEC §5.6) ↔ `ext.flutter.*` service extensions.
 *
 * Verified against Flutter 3.38 (packages/flutter/lib/src/*): bool extensions (`registerBoolServiceExtension`)
 * take/return `enabled: 'true'|'false'`; `timeDilation` (numeric) takes/returns `timeDilation: '<double>'`;
 * `platformOverride` takes `value` = a TargetPlatform name (anything else clears the override) and returns the
 * effective platform; `brightnessOverride` takes `value` = 'Brightness.light'|'Brightness.dark' (anything
 * else clears it) and returns the effective brightness; `debugDumpApp` / `debugDumpRenderTree` return
 * `{data: <dump>}` instead of printing. Changes post `Flutter.ServiceExtensionStateChanged`
 * `{extension, value}` on the Extension stream.
 */
import type { AppActionDescriptor } from '@durbun/protocol';

export type ActionKind = 'toggle' | 'select' | 'button';
export type ActionValue = boolean | string;

export interface FlutterActionSpec {
  id: string;
  kind: ActionKind;
  label: string;
  extension: string;
  options?: { value: string; label: string }[];
}

export const SLOW_ANIMATION_FACTOR = 5;

export const FLUTTER_ACTIONS: readonly FlutterActionSpec[] = [
  { id: 'flutter.debugPaint', kind: 'toggle', label: 'Debug paint', extension: 'ext.flutter.debugPaint' },
  { id: 'flutter.repaintRainbow', kind: 'toggle', label: 'Repaint rainbow', extension: 'ext.flutter.repaintRainbow' },
  { id: 'flutter.slowAnimations', kind: 'toggle', label: 'Slow animations', extension: 'ext.flutter.timeDilation' },
  {
    id: 'flutter.performanceOverlay',
    kind: 'toggle',
    label: 'Performance overlay',
    extension: 'ext.flutter.showPerformanceOverlay',
  },
  {
    id: 'flutter.invertOversizedImages',
    kind: 'toggle',
    label: 'Invert oversized images',
    extension: 'ext.flutter.invertOversizedImages',
  },
  {
    id: 'flutter.brightness',
    kind: 'select',
    label: 'Brightness',
    extension: 'ext.flutter.brightnessOverride',
    options: [
      { value: 'system', label: 'System' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ],
  },
  {
    id: 'flutter.platform',
    kind: 'select',
    label: 'Target platform',
    extension: 'ext.flutter.platformOverride',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'android', label: 'Android' },
      { value: 'iOS', label: 'iOS' },
      { value: 'macOS', label: 'macOS' },
    ],
  },
  { id: 'flutter.dumpWidgetTree', kind: 'button', label: 'Dump widget tree', extension: 'ext.flutter.debugDumpApp' },
  { id: 'flutter.dumpRenderTree', kind: 'button', label: 'Dump render tree', extension: 'ext.flutter.debugDumpRenderTree' },
];

export const ACTIONS_BY_ID: ReadonlyMap<string, FlutterActionSpec> = new Map(FLUTTER_ACTIONS.map((a) => [a.id, a]));
const ACTIONS_BY_EXTENSION: ReadonlyMap<string, FlutterActionSpec> = new Map(
  FLUTTER_ACTIONS.map((a) => [a.extension, a]),
);

const TARGET_PLATFORMS = ['android', 'fuchsia', 'iOS', 'linux', 'macOS', 'windows'];

export function specForExtension(extension: string): FlutterActionSpec | undefined {
  return ACTIONS_BY_EXTENSION.get(extension);
}

/** VM `operatingSystem` → Flutter TargetPlatform name. */
export function nativeTargetPlatform(os: string | undefined): string | undefined {
  switch ((os ?? '').toLowerCase()) {
    case 'android':
      return 'android';
    case 'ios':
      return 'iOS';
    case 'macos':
      return 'macOS';
    case 'linux':
      return 'linux';
    case 'windows':
      return 'windows';
    case 'fuchsia':
      return 'fuchsia';
    default:
      return undefined;
  }
}

/** Only actions whose extension is registered in the isolate (debug-only ones vanish in profile mode). */
export function availableActions(extensions: ReadonlySet<string>): FlutterActionSpec[] {
  return FLUTTER_ACTIONS.filter((a) => extensions.has(a.extension));
}

export function buildActionDescriptors(
  extensions: ReadonlySet<string>,
  values: ReadonlyMap<string, ActionValue>,
): AppActionDescriptor[] {
  return availableActions(extensions).map((spec) => {
    const d: AppActionDescriptor = { id: spec.id, kind: spec.kind, label: spec.label, labelKey: spec.id, group: 'flutter' };
    if (spec.options) d.options = spec.options.map((o) => ({ ...o }));
    const value = values.get(spec.id);
    if (value !== undefined) d.value = value;
    return d;
  });
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return undefined;
}

function brightnessFromEffective(value: unknown): string | undefined {
  if (value === 'Brightness.dark') return 'dark';
  if (value === 'Brightness.light') return 'light';
  return undefined;
}

export interface ValueContext {
  /** TargetPlatform name of the device (from the VM's operatingSystem). */
  nativePlatform?: string;
}

/**
 * Current action value from an extension's read/write response. For the select overrides the response is
 * the *effective* value, so the requested value (when we just set it) is the better truth.
 */
export function valueFromResponse(
  spec: FlutterActionSpec,
  result: Record<string, unknown> | undefined,
  ctx: ValueContext,
  requested?: ActionValue,
): ActionValue | undefined {
  switch (spec.id) {
    case 'flutter.slowAnimations': {
      const n = Number(result?.timeDilation);
      return Number.isFinite(n) ? n > 1.0001 : undefined;
    }
    case 'flutter.brightness':
      return typeof requested === 'string' ? requested : 'system';
    case 'flutter.platform': {
      if (typeof requested === 'string') return requested;
      const v = result?.value;
      if (typeof v !== 'string') return undefined;
      return v === ctx.nativePlatform ? 'default' : v;
    }
    default:
      if (spec.kind === 'toggle') return asBool(result?.enabled);
      return undefined;
  }
}

/** Action value from a `Flutter.ServiceExtensionStateChanged` event (another tool or the app changed it). */
export function valueFromStateChange(
  extension: string,
  value: unknown,
  ctx: ValueContext,
): { id: string; value: ActionValue } | undefined {
  const spec = specForExtension(extension);
  if (!spec) return undefined;
  switch (spec.id) {
    case 'flutter.slowAnimations': {
      const n = Number(value);
      return Number.isFinite(n) ? { id: spec.id, value: n > 1.0001 } : undefined;
    }
    case 'flutter.brightness': {
      const b = brightnessFromEffective(value);
      return b ? { id: spec.id, value: b } : undefined;
    }
    case 'flutter.platform':
      return typeof value === 'string' ? { id: spec.id, value: value === ctx.nativePlatform ? 'default' : value } : undefined;
    default: {
      if (spec.kind !== 'toggle') return undefined;
      const b = asBool(value);
      return b === undefined ? undefined : { id: spec.id, value: b };
    }
  }
}

export type Resolved = { ok: true; value?: ActionValue } | { ok: false; error: string };

/**
 * The value a command asks for. Accepts `{value}` (the descriptor's value type), `{enabled}` / `{on}`
 * for toggles and `{option}` for selects; a toggle without a value flips the current state.
 */
export function resolveRequestedValue(
  spec: FlutterActionSpec,
  params: Record<string, unknown> | undefined,
  current: ActionValue | undefined,
): Resolved {
  const p = params ?? {};
  if (spec.kind === 'button') return { ok: true };
  if (spec.kind === 'toggle') {
    const raw = p.value ?? p.enabled ?? p.on;
    if (raw === undefined || raw === null) return { ok: true, value: !(current === true) };
    const b = asBool(raw);
    return b === undefined ? { ok: false, error: `Expected a boolean value for ${spec.id}` } : { ok: true, value: b };
  }
  const raw = p.value ?? p.option;
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: `Expected a string value for ${spec.id}` };
  const v = raw.trim();
  if (spec.id === 'flutter.brightness') {
    const lower = v.toLowerCase().replace(/^brightness\./, '');
    if (lower === 'light' || lower === 'dark') return { ok: true, value: lower };
    if (lower === 'system' || lower === 'default') return { ok: true, value: 'system' };
    return { ok: false, error: `Unsupported brightness "${v}" (light, dark or system)` };
  }
  if (spec.id === 'flutter.platform') {
    if (v.toLowerCase() === 'default' || v.toLowerCase() === 'system') return { ok: true, value: 'default' };
    const match = TARGET_PLATFORMS.find((t) => t.toLowerCase() === v.toLowerCase());
    return match ? { ok: true, value: match } : { ok: false, error: `Unsupported platform "${v}"` };
  }
  return { ok: false, error: `Unsupported action ${spec.id}` };
}

/** Extension parameters (all strings — extension handlers receive Map<String, String>) for a write. */
export function writeParams(spec: FlutterActionSpec, value: ActionValue | undefined): Record<string, string> {
  switch (spec.id) {
    case 'flutter.slowAnimations':
      return { timeDilation: value === true ? `${SLOW_ANIMATION_FACTOR}.0` : '1.0' };
    case 'flutter.brightness':
      return { value: value === 'light' ? 'Brightness.light' : value === 'dark' ? 'Brightness.dark' : 'default' };
    case 'flutter.platform':
      return { value: typeof value === 'string' ? value : 'default' };
    default:
      return spec.kind === 'toggle' ? { enabled: value === true ? 'true' : 'false' } : {};
  }
}
