/**
 * `Logging` stream events (dart:developer `log()`, package:logging via developer.log) → SDK log messages.
 *
 * Verified against the Dart 3.10 VM: `event.logRecord` carries `time` (ms), `level`, `sequenceNumber`, and
 * InstanceRefs `message`, `loggerName`, `zone`, `error`, `stackTrace` (the class is under `class`). String
 * refs are truncated to 128 chars (`valueAsStringIsTruncated`, `count`, `length`) → `getObject` for the
 * full text. `error` may be any object (kind `PlainInstance` → `invoke toString`), `stackTrace` is kind
 * `StackTrace` with its full text in `valueAsString`. Absent values are refs of kind `Null`.
 */
import type { ErrorInfo, SdkLog } from '@durbun/protocol';
import { mapDartLogLevel } from './levels';

export interface InstanceRefJson {
  type?: string;
  kind?: string;
  id?: string;
  class?: { name?: string };
  valueAsString?: string;
  valueAsStringIsTruncated?: boolean;
  length?: number;
  count?: number;
}

export interface LogRecordJson {
  type?: string;
  sequenceNumber?: number;
  time?: number;
  level?: number;
  loggerName?: InstanceRefJson;
  message?: InstanceRefJson;
  zone?: InstanceRefJson;
  error?: InstanceRefJson;
  stackTrace?: InstanceRefJson;
}

export interface LoggingEventJson {
  kind?: string;
  timestamp?: number;
  isolate?: { id?: string; name?: string };
  logRecord?: LogRecordJson;
}

/** Resolves values the event only carries as (possibly truncated) references. */
export interface ObjectResolver {
  /** Full value of a String instance, at most `maxChars` characters. */
  fullString(isolateId: string, objectId: string, maxChars: number): Promise<string | undefined>;
  /** `toString()` of any instance (runs Dart code in the isolate). */
  describe(isolateId: string, objectId: string, maxChars: number): Promise<string | undefined>;
}

export type AppLog = Omit<SdkLog, 'type'>;

export function isPresentRef(ref: unknown): ref is InstanceRefJson {
  if (!ref || typeof ref !== 'object') return false;
  const r = ref as InstanceRefJson;
  return r.kind !== 'Null' && r.type !== 'Sentinel' && r.type !== '@Sentinel';
}

/** Readable class name: private VM classes lose their leading underscores (`_Exception` → `Exception`). */
export function displayClassName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const cleaned = name.replace(/^_+/, '');
  return cleaned || name;
}

/** Text of an instance ref, resolving truncation / non-string objects through the resolver. */
export async function instanceText(
  ref: InstanceRefJson | undefined,
  isolateId: string | undefined,
  resolver: ObjectResolver | undefined,
  maxChars: number,
): Promise<string | undefined> {
  if (!isPresentRef(ref)) return undefined;
  if (typeof ref.valueAsString === 'string') {
    if (!ref.valueAsStringIsTruncated) return ref.valueAsString;
    if (resolver && isolateId && ref.id && ref.kind === 'String') {
      const full = await resolver.fullString(isolateId, ref.id, maxChars).catch(() => undefined);
      if (full !== undefined) return full;
    }
    return `${ref.valueAsString}…`;
  }
  if (resolver && isolateId && ref.id) {
    const described = await resolver.describe(isolateId, ref.id, maxChars).catch(() => undefined);
    if (described !== undefined) return described;
  }
  const cls = displayClassName(ref.class?.name);
  return cls ? `Instance of '${cls}'` : undefined;
}

export interface LogConversionOptions {
  /** Upper bound for message / error / stack text. */
  maxChars: number;
}

/** Convert a `Logging` event. `resolver` may be omitted to skip RPCs (fast path under heavy load). */
export async function loggingEventToAppLog(
  event: LoggingEventJson,
  resolver: ObjectResolver | undefined,
  opts: LogConversionOptions,
): Promise<AppLog | undefined> {
  const record = event.logRecord;
  if (!record || typeof record !== 'object') return undefined;
  const isolateId = event.isolate?.id;
  const [message, loggerName, errorText, stackText] = await Promise.all([
    instanceText(record.message, isolateId, resolver, opts.maxChars),
    instanceText(record.loggerName, isolateId, resolver, 256),
    instanceText(record.error, isolateId, resolver, opts.maxChars),
    instanceText(record.stackTrace, isolateId, resolver, opts.maxChars),
  ]);
  const hasError = errorText !== undefined;
  let error: ErrorInfo | undefined;
  if (hasError || stackText !== undefined) {
    error = {};
    if (hasError && record.error?.kind !== 'String') {
      const type = displayClassName(record.error?.class?.name);
      if (type) error.type = type;
    }
    if (errorText !== undefined) error.message = errorText;
    if (stackText !== undefined) error.stack = stackText.replace(/\s+$/, '');
  }
  const time = typeof record.time === 'number' && record.time > 0 ? record.time : undefined;
  const log: AppLog = {
    ts: time ?? event.timestamp ?? Date.now(),
    level: mapDartLogLevel(record.level, hasError),
    tag: loggerName?.trim() || 'log',
    message: message !== undefined && message !== '' ? message : errorText ?? '',
    kind: 'text',
  };
  if (error) log.error = error;
  return log;
}

/** Stable identity of a Logging event, used to drop DDS history replays we already delivered. */
export function loggingEventKey(event: LoggingEventJson): string {
  const r = event.logRecord ?? {};
  return [
    event.isolate?.id ?? '',
    r.sequenceNumber ?? '',
    r.time ?? '',
    r.level ?? '',
    r.loggerName?.valueAsString ?? '',
    (r.message?.valueAsString ?? '').slice(0, 64),
  ].join('|');
}
