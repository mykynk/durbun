/**
 * Flows ("Akışlar"): graph documents the desktop runs against a device and an app — HTTP requests sent from the Mac,
 * conditions and variables, sub-flows, device actions, waits on what the app does, mock scenarios and outputs.
 *
 * A flow is ONE JSON document (`format: 'durbun-flow'`). The same document is stored on disk
 * (`<dataDir>/flows/<id>.json`), exported, shared inside a Dürbün package and written by the user's own AI, so this
 * file is a public contract: add optional members only.
 */
import type { DevicePlatform, I18nParams, UrlMatchType } from '../index';

export const FLOW_FORMAT = 'durbun-flow';
export const FLOW_VERSION = 1;
export const FLOW_ENVIRONMENTS_FORMAT = 'durbun-environments';

/** Every port a node can leave through. `error` exists on every node that accepts input, except flow.end. */
export type FlowPort = 'out' | 'true' | 'false' | 'loop' | 'done' | 'error';

export interface FlowPosition {
  x: number;
  y: number;
}

export interface FlowNode {
  /**
   * Unique within the flow and the name templates use: `{{login.body.token}}` reads node `login`'s output.
   * Letters, digits and `_`, starting with a letter or `_` (max 64).
   */
  id: string;
  /** Node type from the catalog, e.g. 'http.request' (see FLOW_NODE_TYPES). */
  type: string;
  /** Text shown on the canvas and in reports instead of the type title. */
  label?: string;
  /** Parameters as the catalog describes them; string values may contain {{templates}}. */
  params?: Record<string, unknown>;
  /** Canvas position; nodes without one are placed automatically. */
  position?: FlowPosition;
  /** Skipped while running: the run passes straight through `out`. */
  disabled?: boolean;
  /**
   * A failure does not fail the run: the step is marked failed and the run continues the way it would after a
   * pass — `out`, `true` for logic.condition, `done` for logic.repeat. An `error` edge takes precedence.
   */
  continueOnError?: boolean;
  /** Try again after a failure. */
  retry?: { count: number; delayMs?: number };
  /** Fail the step when it takes longer (default per node type). */
  timeoutMs?: number;
  /** Free text for the people reading the flow. */
  note?: string;
}

export interface FlowEdge {
  /** Node id the run leaves. */
  from: string;
  /** Port of `from` (default 'out'). */
  port?: FlowPort;
  /** Node id the run enters. */
  to: string;
}

export interface FlowVariableDef {
  /** Read as `{{input.<name>}}`. */
  name: string;
  description?: string;
  default?: string | number | boolean;
  required?: boolean;
  /** Masked in reports and run history. */
  secret?: boolean;
}

export interface FlowOutputDef {
  /** What a calling flow reads as `{{<call node id>.outputs.<name>}}`. */
  name: string;
  /** Template resolved when the flow ends, e.g. '{{login.body.token}}'. */
  value: string;
  description?: string;
}

export interface FlowTargetHint {
  /** Platform the flow was written for (informational; preflight warns on a mismatch). */
  platform?: DevicePlatform | 'any';
  /** Bundle id / package name of the app under test; `{{target.appId}}` defaults to it. */
  appId?: string;
}

export interface FlowSettings {
  /** A step this device/app cannot run: 'skip' (default, yellow) or 'fail' the run. */
  onUnsupported?: 'skip' | 'fail';
  /** Whole-run limit in ms (default 30 min). */
  timeoutMs?: number;
  /** Send captured flow requests to the Network tab (default true). */
  recordRequests?: boolean;
}

export interface FlowAutomation {
  /** Event triggers (trigger.event) start runs on their own while Dürbün is open. */
  enabled: boolean;
  /** At most one automatic run per this many ms (default 30 000). */
  throttleMs?: number;
}

export interface FlowDoc {
  format: typeof FLOW_FORMAT;
  version: typeof FLOW_VERSION;
  /** Lower-case letters, digits, '-' and '_' (max 64); the file name on disk. */
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  inputs?: FlowVariableDef[];
  outputs?: FlowOutputDef[];
  target?: FlowTargetHint;
  settings?: FlowSettings;
  automation?: FlowAutomation;
  nodes: FlowNode[];
  edges: FlowEdge[];
  createdAt?: number;
  updatedAt?: number;
}

/* ────────────────────────────── Parameters of structured kinds ────────────────────────────── */

export type FlowConditionOp =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'matches'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'exists'
  | 'notExists'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'isTrue'
  | 'isFalse'
  | 'in';

export interface FlowConditionRule {
  /** Template or literal, e.g. '{{getCart.status}}'. */
  left: string;
  op: FlowConditionOp;
  /**
   * Template or literal; required by every operator except exists / notExists / isEmpty / isNotEmpty / isTrue /
   * isFalse. For `in`: comma-separated values ('a, b'); validation turns a JSON list into that text.
   */
  right?: string;
}

export interface FlowAssertion extends FlowConditionRule {
  /** Shown when the assertion fails. */
  message?: string;
}

export interface FlowExtractRule {
  /** Variable name, read as `{{vars.<name>}}`. */
  name: string;
  from: 'body' | 'header' | 'status' | 'bodyText';
  /** body: JSON path (`items[0].id`, `$.items[0].id`); header: header name. */
  path?: string;
  /** Optional regex applied to the text; group 1 (or the whole match) is kept. */
  regex?: string;
}

export interface FlowAssignment {
  name: string;
  /** Template or literal. */
  value: string;
}

/** [name, value] pairs (headers, query, form fields). */
export type FlowKeyValue = [string, string];

/* ────────────────────────────── Environments ────────────────────────────── */

export interface FlowEnvVar {
  key: string;
  value: string;
  /** Masked in reports, AI packs and shared packages. */
  secret?: boolean;
}

export interface FlowEnvironment {
  id: string;
  name: string;
  vars: FlowEnvVar[];
}

export interface FlowEnvironments {
  format: typeof FLOW_ENVIRONMENTS_FORMAT;
  version: 1;
  activeId?: string;
  environments: FlowEnvironment[];
}

/* ────────────────────────────── Validation ────────────────────────────── */

export interface FlowIssue {
  level: 'error' | 'warning';
  /** Stable code, e.g. 'flow.node.unknownType' (the UI words it; `message` is the English text). */
  code: string;
  message: string;
  /** JSON path into the document, e.g. 'nodes[3].params.url'. */
  path?: string;
  nodeId?: string;
  params?: I18nParams;
}

/* ────────────────────────────── Runs ────────────────────────────── */

export type FlowStepStatus = 'running' | 'passed' | 'failed' | 'skipped' | 'cancelled';
export type FlowRunStatus = 'running' | 'passed' | 'failed' | 'cancelled';

export interface FlowEvidence {
  kind: 'screenshot' | 'video' | 'file';
  name: string;
  /** Same-origin URL (GET /api/flow-runs/:id/files/:name). */
  url: string;
  width?: number;
  height?: number;
}

export interface FlowRunStep {
  /** 1-based, in start order. */
  id: number;
  nodeId: string;
  type: string;
  label?: string;
  /** Flow the node belongs to (a sub-flow's steps carry the sub-flow id). */
  flowId: string;
  /** 0 = the flow that was started; sub-flows add one. */
  depth: number;
  /** The flow.call / repeat step this one runs under. */
  parentStepId?: number;
  /** 0-based iteration of the closest repeat. */
  iteration?: number;
  status: FlowStepStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  attempts?: number;
  /** Port the run left through. */
  port?: FlowPort;
  /** One-line English summary ("GET https://… → 200 · 142 ms"); `code` + `params` for the UI. */
  summary?: string;
  code?: string;
  params?: I18nParams;
  error?: string;
  errorCode?: string;
  /** What templates read as `{{<nodeId>…}}`, trimmed (bodies cut, secrets masked). */
  output?: unknown;
  /** The output was dropped to keep a long run small (later runs of the same step kept theirs). */
  outputTrimmed?: boolean;
  /** Network tab entry of a request the step sent or waited for. */
  netId?: string;
  evidence?: FlowEvidence[];
  /** Skipped because this device or app cannot run it (preflight code). */
  unsupported?: string;
  /** A failure the flow handled (its `error` port, or continueOnError): the run goes on. */
  handled?: boolean;
}

export interface FlowRunTarget {
  deviceId?: string;
  deviceName?: string;
  platform?: DevicePlatform;
  kind?: string;
  osVersion?: string;
  /** Bundle id / package name. */
  appId?: string;
  appName?: string;
  appVersion?: string;
}

export interface FlowRunTrigger {
  kind: 'manual' | 'event';
  /** trigger.event `event` value. */
  event?: string;
  /** Human text: the log line, the request, the crash. */
  detail?: string;
}

export interface FlowRunCounts {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

export interface FlowRun {
  id: string;
  flowId: string;
  flowName: string;
  status: FlowRunStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  trigger: FlowRunTrigger;
  target?: FlowRunTarget;
  environment?: { id: string; name: string };
  /** Input values used (secrets masked). */
  inputs?: Record<string, unknown>;
  steps: FlowRunStep[];
  counts: FlowRunCounts;
  /** Why the run failed or stopped (the failing step has the details). */
  error?: string;
  errorCode?: string;
  /** Params of `errorCode` (the end message, the step that looped…). */
  errorParams?: I18nParams;
  outputs?: Record<string, unknown>;
  preflight?: FlowPreflightIssue[];
}

/** A run without its steps (history lists). */
export type FlowRunHeader = Omit<FlowRun, 'steps'> & { stepCount: number };

/* ────────────────────────────── Preflight ────────────────────────────── */

export interface FlowPreflightIssue {
  level: 'error' | 'warn' | 'info';
  /** e.g. 'preflight.action.unsupported', 'preflight.sdk.missing', 'preflight.env.missing'. */
  code: string;
  message: string;
  nodeId?: string;
  /** Set for a step of a sub-flow (flow.call). */
  flowId?: string;
  params?: I18nParams;
}

export interface FlowPreflight {
  /**
   * False when the run cannot start at all: an invalid flow, or no device for its device steps under onUnsupported
   * 'fail' (under 'skip' only when nothing but device steps would run).
   */
  ok: boolean;
  issues: FlowPreflightIssue[];
  /** Steps that change the device in a way that is hard to undo (clear data, uninstall, install). */
  irreversible: string[];
  /** Nodes that will be skipped. */
  skipped: string[];
  target?: FlowRunTarget;
}

/* ────────────────────────────── Lists and requests ────────────────────────────── */

export interface FlowSummary {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  nodeCount: number;
  createdAt?: number;
  updatedAt?: number;
  triggers: ('manual' | 'event')[];
  automation: boolean;
  target?: FlowTargetHint;
  /** Flow ids this flow calls. */
  calls: string[];
  issues: { errors: number; warnings: number };
  lastRun?: { id: string; status: FlowRunStatus; startedAt: number; durationMs?: number };
}

export interface FlowRunRequest {
  target?: { deviceId?: string; appId?: string };
  environmentId?: string | null;
  inputs?: Record<string, unknown>;
  /** Run only this node and what follows it (the editor's "run from here"). */
  startNodeId?: string;
}

/** Steps changed since the previous message, merged by step id (WS `flowRun`). */
export interface FlowRunDelta {
  run: FlowRunHeader;
  steps: FlowRunStep[];
}

/** What GET /api/flows/catalog and the AI pack describe for one URL match type. */
export type FlowUrlMatch = UrlMatchType;
