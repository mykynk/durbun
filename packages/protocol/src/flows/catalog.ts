/**
 * The node catalog: one description per node type. The UI builds its palette and forms from it, the server validates
 * and runs nodes by it, and the AI pack + JSON Schema are generated from it — keep the English texts precise.
 */
import type { DeviceActionId, DevicePlatform, DeviceKind, SdkCapability } from '../index';
import type { FlowPort } from './types';

export type FlowNodeGroup = 'trigger' | 'http' | 'logic' | 'device' | 'wait' | 'mock' | 'output';

export type FlowParamKind =
  /** One-line text; {{templates}} allowed. */
  | 'text'
  /** Multi-line text; {{templates}} allowed. */
  | 'longText'
  /** Number or a template that resolves to one. */
  | 'number'
  | 'boolean'
  /** One of `options`. */
  | 'select'
  /** [[name, value], …]; templates allowed in values. */
  | 'keyValue'
  /** Any JSON value; strings inside may be templates. */
  | 'json'
  /** FlowConditionRule[] */
  | 'conditions'
  /** FlowAssertion[] */
  | 'assertions'
  /** FlowExtractRule[] */
  | 'extracts'
  /** FlowAssignment[] */
  | 'assignments'
  /** Id of another flow. */
  | 'flowRef'
  /** { [input name]: template } */
  | 'mapping';

export interface FlowParamOption {
  value: string;
  label: string;
}

export interface FlowParamSpec {
  name: string;
  kind: FlowParamKind;
  description: string;
  required?: boolean;
  default?: unknown;
  options?: FlowParamOption[];
  example?: unknown;
  min?: number;
  max?: number;
  placeholder?: string;
  /** Shown/used only when another param has one of these values. */
  showIf?: { param: string; values: unknown[] };
  /** Collapsed under "More" in the editor. */
  advanced?: boolean;
  /** Read as written, never through templates (validation rejects `{{…}}` here). */
  fixed?: boolean;
}

export interface FlowNodeNeeds {
  /** Runs this device action (support per platform: DEVICE_ACTION_SUPPORT). */
  deviceAction?: DeviceActionId;
  /** Needs a target device. */
  device?: boolean;
  /** Needs the app under test to run the Dürbün SDK with this capability (release tester builds often do not). */
  sdk?: SdkCapability;
  /** Needs the Send to Slack webhook. */
  slack?: boolean;
}

export interface FlowNodeSpec {
  type: string;
  group: FlowNodeGroup;
  title: string;
  description: string;
  /** Output ports besides `error` (every node with input has `error`). */
  ports: FlowPort[];
  /** False for triggers. */
  acceptsInput: boolean;
  params: FlowParamSpec[];
  /** Fields of the output templates can read, e.g. ['status', 'body', …]. */
  outputs: { name: string; description: string }[];
  needs?: FlowNodeNeeds;
  /** Default step timeout in ms (the node's `timeoutMs` overrides it). */
  timeoutMs?: number;
  /** Changes the device in a way that is hard to undo (listed before a run). */
  irreversible?: boolean;
  /** Short id prefix for new nodes ('request' → request1, request2). */
  idPrefix: string;
}

/* ────────────────────────────── Shared parameter pieces ────────────────────────────── */

const METHODS: FlowParamOption[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => ({ value: m, label: m }));
const ANY_METHODS: FlowParamOption[] = [{ value: '*', label: 'Any' }, ...METHODS];
const URL_MATCH: FlowParamOption[] = [
  { value: 'contains', label: 'Contains' },
  { value: 'exact', label: 'Exact' },
  { value: 'glob', label: 'Glob (* and ?)' },
  { value: 'regex', label: 'Regular expression' },
];
const SINCE: FlowParamOption[] = [
  { value: 'previous', label: 'Since the previous step started' },
  { value: 'run', label: 'Since the run started' },
  { value: 'now', label: 'From now on' },
];
const LOG_LEVELS: FlowParamOption[] = ['verbose', 'debug', 'info', 'warn', 'error', 'fatal'].map((l) => ({ value: l, label: l }));

const appIdParam = (description = 'Bundle id / package name of the app.'): FlowParamSpec => ({
  name: 'appId',
  kind: 'text',
  description: `${description} Defaults to the run's app ({{target.appId}}).`,
  default: '{{target.appId}}',
  placeholder: 'com.example.app',
});

const timeoutParam = (ms: number, description = 'Give up after this many milliseconds.'): FlowParamSpec => ({
  name: 'timeoutMs',
  kind: 'number',
  description,
  default: ms,
  min: 100,
  max: 30 * 60_000,
});

const sinceParam: FlowParamSpec = {
  name: 'since',
  kind: 'select',
  description:
    "Which events count: 'previous' (default) also catches what happened while the previous step ran (e.g. the request a deep link caused), 'run' anything since the run started, 'now' only what happens after this step starts.",
  options: SINCE,
  default: 'previous',
  advanced: true,
};

const HTTP_OUTPUTS = [
  { name: 'status', description: 'HTTP status code (number)' },
  { name: 'statusText', description: 'Status text' },
  { name: 'ok', description: 'true for 2xx' },
  { name: 'headers', description: "Response headers by lower-case name, e.g. headers['content-type']" },
  { name: 'body', description: 'Parsed JSON body, or the text when it is not JSON' },
  { name: 'bodyText', description: 'Body as text' },
  { name: 'durationMs', description: 'Duration in ms' },
  { name: 'url', description: 'Final URL (after redirects)' },
  { name: 'method', description: 'HTTP method' },
];

/* ────────────────────────────── Catalog ────────────────────────────── */

export const FLOW_NODE_SPECS: readonly FlowNodeSpec[] = [
  /* ── triggers ── */
  {
    type: 'trigger.manual',
    group: 'trigger',
    title: 'Manual start',
    description: 'Where a run starts when someone presses Run. Flow inputs are read as {{input.<name>}}.',
    ports: ['out'],
    acceptsInput: false,
    params: [],
    outputs: [],
    idPrefix: 'start',
  },
  {
    type: 'trigger.event',
    group: 'trigger',
    title: 'When something happens',
    description:
      "Starts the flow on its own when the event happens on a connected device (only while the flow's automation switch is on and Dürbün is open). The run targets the device and app of the event. Event data is read as {{trigger.<field>}}.",
    ports: ['out'],
    acceptsInput: false,
    params: [
      {
        name: 'event',
        kind: 'select',
        description: 'What starts the flow.',
        required: true,
        fixed: true,
        default: 'crash',
        options: [
          { value: 'crash', label: 'App crash, ANR or Flutter error' },
          { value: 'logMatch', label: 'A log line matches' },
          { value: 'networkError', label: 'A request fails (network error or 5xx)' },
          { value: 'networkMatch', label: 'A request matches' },
          { value: 'appConnected', label: 'The app connects (SDK)' },
          { value: 'deviceConnected', label: 'A device connects' },
        ],
      },
      { name: 'text', kind: 'text', description: 'Text the log line contains (or a regex when `regex` is on).', showIf: { param: 'event', values: ['logMatch'] }, fixed: true },
      { name: 'regex', kind: 'boolean', description: 'Treat `text` as a regular expression.', default: false, showIf: { param: 'event', values: ['logMatch'] }, fixed: true },
      { name: 'level', kind: 'select', description: 'Lowest log level that counts.', options: LOG_LEVELS, default: 'verbose', showIf: { param: 'event', values: ['logMatch'] }, fixed: true },
      { name: 'method', kind: 'select', description: 'HTTP method.', options: ANY_METHODS, default: '*', showIf: { param: 'event', values: ['networkMatch'] }, fixed: true },
      { name: 'url', kind: 'text', description: 'URL pattern.', showIf: { param: 'event', values: ['networkMatch', 'networkError'] }, fixed: true },
      { name: 'match', kind: 'select', description: 'How `url` matches.', options: URL_MATCH, default: 'contains', showIf: { param: 'event', values: ['networkMatch', 'networkError'] }, fixed: true },
      { name: 'status', kind: 'text', description: "Status filter: '2xx', '404', '400-499', '500,502' (empty = any).", showIf: { param: 'event', values: ['networkMatch'] }, fixed: true },
      { name: 'appId', kind: 'text', description: "Only this app (bundle id / package). Empty = the flow's target app, or any app when the flow has none.", fixed: true },
    ],
    outputs: [
      { name: 'event', description: 'The event value' },
      { name: 'deviceId', description: 'Device the event came from' },
      { name: 'appId', description: 'App bundle id / package (when known)' },
      { name: 'message', description: 'Log line text / request line / crash title' },
      { name: 'log', description: 'The log entry (log and crash events)' },
      { name: 'request', description: 'The request: method, url, status, error (network events)' },
      { name: 'app', description: 'The app: name, id, version (appConnected)' },
      { name: 'device', description: 'The device: id, name, platform (deviceConnected)' },
    ],
    idPrefix: 'trigger',
  },

  /* ── HTTP ── */
  {
    type: 'http.request',
    group: 'http',
    title: 'HTTP request',
    description:
      'Sends a request from the Mac (not through the app, so it works with any build). The response is the step output; it also shows in the Network tab under "Desktop".',
    ports: ['out'],
    acceptsInput: true,
    params: [
      { name: 'method', kind: 'select', description: 'HTTP method.', required: true, default: 'GET', options: METHODS },
      { name: 'url', kind: 'text', description: 'Absolute http(s) URL; usually starts with {{env.baseUrl}}.', required: true, placeholder: 'https://api.example.com/v1/cart', example: '{{env.baseUrl}}/v1/cart' },
      { name: 'query', kind: 'keyValue', description: 'Query parameters appended to the URL.', default: [] },
      { name: 'headers', kind: 'keyValue', description: 'Request headers.', default: [], example: [['Authorization', 'Bearer {{login.body.token}}']] },
      {
        name: 'bodyType',
        kind: 'select',
        description: "Body: 'none', 'json' (sends `body` as JSON), 'text' (sends `body` as is), 'form' (x-www-form-urlencoded from `form`).",
        default: 'none',
        options: [
          { value: 'none', label: 'None' },
          { value: 'json', label: 'JSON' },
          { value: 'text', label: 'Text' },
          { value: 'form', label: 'Form (urlencoded)' },
        ],
      },
      { name: 'body', kind: 'json', description: 'JSON body (bodyType json) or text (bodyType text). Strings may contain templates. Without a body type, an object or list goes as JSON and text as plain text; the step notes it.', showIf: { param: 'bodyType', values: ['json', 'text'] }, example: { productId: '{{vars.productId}}', quantity: 1 } },
      { name: 'form', kind: 'keyValue', description: 'Form fields (bodyType form).', default: [], showIf: { param: 'bodyType', values: ['form'] } },
      { name: 'expectStatus', kind: 'text', description: "Fail the step unless the status matches: '2xx', '200', '200,201', '200-299'. Empty = any status passes.", default: '', placeholder: '2xx' },
      { name: 'extract', kind: 'extracts', description: 'Save values from the response as variables ({{vars.<name>}}).', default: [] },
      { name: 'timeoutMs', kind: 'number', description: 'Give up after this many milliseconds.', default: 30_000, min: 100, max: 10 * 60_000, advanced: true },
      { name: 'followRedirects', kind: 'boolean', description: 'Follow 3xx redirects.', default: true, advanced: true },
    ],
    outputs: HTTP_OUTPUTS,
    timeoutMs: 10 * 60_000,
    idPrefix: 'request',
  },

  /* ── logic ── */
  {
    type: 'logic.condition',
    group: 'logic',
    title: 'Condition',
    description: 'Checks rules and continues through `true` or `false`.',
    ports: ['true', 'false'],
    acceptsInput: true,
    params: [
      { name: 'mode', kind: 'select', description: "'all' = every rule must hold, 'any' = one is enough.", default: 'all', options: [{ value: 'all', label: 'All rules' }, { value: 'any', label: 'Any rule' }] },
      { name: 'rules', kind: 'conditions', description: 'Rules: left, op, right.', required: true, default: [], example: [{ left: '{{getCart.status}}', op: 'equals', right: '200' }] },
    ],
    outputs: [{ name: 'result', description: 'true or false' }],
    idPrefix: 'condition',
  },
  {
    type: 'logic.repeat',
    group: 'logic',
    title: 'Repeat',
    description:
      'Runs everything connected to `loop` up to `count` times (one iteration ends when its steps end or come back to this node), then continues through `done`. With `until` rules it stops as soon as they hold — use it to poll ("until the order is ready"). The iteration number is {{<id>.index}} (0-based).',
    ports: ['loop', 'done'],
    acceptsInput: true,
    params: [
      { name: 'count', kind: 'number', description: 'Most iterations (0 = none). A template that gives a list (e.g. {{getOrders.body.items}}), or a JSON list in text, runs once per element, read as {{item}}.', required: true, default: 3, min: 0, max: 1000 },
      { name: 'until', kind: 'conditions', description: 'Stop early when all these rules hold (checked after each iteration).', default: [] },
      { name: 'delayMs', kind: 'number', description: 'Wait between iterations (ms).', default: 0, min: 0, max: 10 * 60_000 },
      { name: 'failIfNotMet', kind: 'boolean', description: 'Fail when `until` never held within `count` iterations.', default: false, advanced: true, fixed: true },
    ],
    outputs: [
      { name: 'index', description: 'Current iteration (0-based)' },
      { name: 'iterations', description: 'Iterations run (after done)' },
      { name: 'met', description: 'Whether `until` held' },
    ],
    timeoutMs: 60 * 60_000,
    idPrefix: 'repeat',
  },
  {
    type: 'logic.setVariables',
    group: 'logic',
    title: 'Set variables',
    description: 'Sets variables read as {{vars.<name>}} later in the run.',
    ports: ['out'],
    acceptsInput: true,
    params: [{ name: 'assignments', kind: 'assignments', description: 'name = value (template or literal).', required: true, default: [], example: [{ name: 'email', value: 'qa+{{$timestamp}}@example.com' }] }],
    outputs: [{ name: '<name>', description: 'Every assigned value' }],
    idPrefix: 'set',
  },
  {
    type: 'logic.delay',
    group: 'logic',
    title: 'Wait',
    description: 'Waits a fixed time.',
    ports: ['out'],
    acceptsInput: true,
    params: [{ name: 'durationMs', kind: 'number', description: 'Milliseconds to wait.', required: true, default: 1000, min: 0, max: 30 * 60_000 }],
    outputs: [],
    timeoutMs: 31 * 60_000,
    idPrefix: 'wait',
  },
  {
    type: 'check.assert',
    group: 'logic',
    title: 'Check',
    description: 'Fails the run when an assertion does not hold. Use it for what a tester would verify.',
    ports: ['out'],
    acceptsInput: true,
    params: [
      { name: 'assertions', kind: 'assertions', description: 'left, op, right and an optional message.', required: true, default: [], example: [{ left: '{{createOrder.status}}', op: 'equals', right: '201', message: 'The order is created' }] },
    ],
    outputs: [{ name: 'passed', description: 'Number of assertions that held' }],
    idPrefix: 'check',
  },
  {
    type: 'check.noErrors',
    group: 'logic',
    title: 'No errors so far',
    description:
      'Fails when the app crashed during the run on the target device; by default also when its requests failed or got a 5xx response, and optionally when it logged error/fatal lines.',
    ports: ['out'],
    acceptsInput: true,
    params: [
      { name: 'networkFailures', kind: 'boolean', description: 'Also fail on failed requests and 5xx responses of the app.', default: true },
      { name: 'errorLogs', kind: 'boolean', description: 'Also fail on error/fatal log lines of the app.', default: false },
      { name: 'since', kind: 'select', description: "'run' (default) or 'previous' step.", options: SINCE.slice(0, 2), default: 'run' },
    ],
    outputs: [{ name: 'problems', description: 'What was found (list of texts)' }],
    needs: { device: true },
    idPrefix: 'noErrors',
  },
  {
    type: 'flow.call',
    group: 'logic',
    title: 'Run another flow',
    description:
      'Runs another flow (sub-flow) with inputs and continues with its outputs: {{<id>.outputs.<name>}}. The sub-flow uses the same device, app and environment.',
    ports: ['out'],
    acceptsInput: true,
    params: [
      { name: 'flowId', kind: 'flowRef', description: 'Id of the flow to run.', required: true },
      { name: 'inputs', kind: 'mapping', description: "Values for the sub-flow's inputs: { name: template }.", default: {}, example: { email: '{{input.email}}' } },
    ],
    outputs: [
      { name: 'outputs', description: "The sub-flow's outputs by name" },
      { name: 'status', description: "The sub-flow's result" },
    ],
    timeoutMs: 60 * 60_000,
    idPrefix: 'call',
  },
  {
    type: 'flow.end',
    group: 'logic',
    title: 'End the run',
    description: 'Ends the run here as passed or failed. Inside a sub-flow it ends that sub-flow: failed makes the calling step fail (its error edge can handle it), passed returns to the caller.',
    ports: [],
    acceptsInput: true,
    params: [
      { name: 'status', kind: 'select', description: 'Result.', default: 'passed', options: [{ value: 'passed', label: 'Passed' }, { value: 'failed', label: 'Failed' }], fixed: true },
      { name: 'message', kind: 'text', description: 'Shown in the report.' },
    ],
    outputs: [],
    idPrefix: 'end',
  },

  /* ── device ── */
  {
    type: 'device.openUrl',
    group: 'device',
    title: 'Open a link (deep link)',
    description: 'Opens a URL or deep link on the device.',
    ports: ['out'],
    acceptsInput: true,
    params: [{ name: 'url', kind: 'text', description: 'URL or deep link.', required: true, placeholder: 'myapp://orders/42' }],
    outputs: [],
    needs: { device: true, deviceAction: 'open-url' },
    idPrefix: 'openUrl',
  },
  {
    type: 'device.launchApp',
    group: 'device',
    title: 'Launch the app',
    description: 'Starts the app (brings it to the front when it runs).',
    ports: ['out'],
    acceptsInput: true,
    params: [appIdParam()],
    outputs: [],
    needs: { device: true, deviceAction: 'app-launch' },
    idPrefix: 'launch',
  },
  {
    type: 'device.stopApp',
    group: 'device',
    title: 'Stop the app',
    description: 'Force-stops the app.',
    ports: ['out'],
    acceptsInput: true,
    params: [appIdParam()],
    outputs: [],
    needs: { device: true, deviceAction: 'app-stop' },
    idPrefix: 'stop',
  },
  {
    type: 'device.restartApp',
    group: 'device',
    title: 'Restart the app',
    description: 'Stops and launches the app again.',
    ports: ['out'],
    acceptsInput: true,
    params: [appIdParam()],
    outputs: [],
    needs: { device: true, deviceAction: 'app-restart' },
    idPrefix: 'restart',
  },
  {
    type: 'device.clearData',
    group: 'device',
    title: 'Clear app data',
    description: 'Deletes the app data (fresh install state). Cannot be undone.',
    ports: ['out'],
    acceptsInput: true,
    params: [appIdParam()],
    outputs: [],
    needs: { device: true, deviceAction: 'app-clear-data' },
    irreversible: true,
    idPrefix: 'clearData',
  },
  {
    type: 'device.installApp',
    group: 'device',
    title: 'Install a build',
    description: 'Installs an .apk / .ipa / .app from a path on this Mac.',
    ports: ['out'],
    acceptsInput: true,
    params: [{ name: 'file', kind: 'text', description: 'Absolute path of the build on this Mac.', required: true, placeholder: '/Users/me/Downloads/app-release.apk' }],
    outputs: [],
    needs: { device: true, deviceAction: 'app-install' },
    irreversible: true,
    timeoutMs: 10 * 60_000,
    idPrefix: 'install',
  },
  {
    type: 'device.uninstallApp',
    group: 'device',
    title: 'Uninstall the app',
    description: 'Removes the app and its data. Cannot be undone.',
    ports: ['out'],
    acceptsInput: true,
    params: [appIdParam()],
    outputs: [],
    needs: { device: true, deviceAction: 'app-uninstall' },
    irreversible: true,
    idPrefix: 'uninstall',
  },
  {
    type: 'device.screenshot',
    group: 'device',
    title: 'Screenshot',
    description: 'Takes a screenshot and keeps it with the run as evidence.',
    ports: ['out'],
    acceptsInput: true,
    params: [{ name: 'name', kind: 'text', description: 'Name shown in the report.', placeholder: 'Order screen' }],
    outputs: [{ name: 'url', description: 'Address of the image' }],
    needs: { device: true, deviceAction: 'screenshot' },
    timeoutMs: 60_000,
    idPrefix: 'screenshot',
  },
  {
    type: 'device.startRecording',
    group: 'device',
    title: 'Start screen recording',
    description: 'Starts recording the screen; "Stop screen recording" (or the end of the run) saves the video with the run.',
    ports: ['out'],
    acceptsInput: true,
    params: [{ name: 'maxSeconds', kind: 'number', description: 'Stop by itself after this many seconds (platform limits: Android 180, iOS 600).', default: 180, min: 1, max: 600 }],
    outputs: [],
    needs: { device: true, deviceAction: 'screen-record' },
    idPrefix: 'record',
  },
  {
    type: 'device.stopRecording',
    group: 'device',
    title: 'Stop screen recording',
    description: 'Stops the recording and keeps the video with the run.',
    ports: ['out'],
    acceptsInput: true,
    params: [{ name: 'name', kind: 'text', description: 'Name shown in the report.' }],
    outputs: [{ name: 'url', description: 'Address of the video' }],
    needs: { device: true, deviceAction: 'screen-record-stop' },
    timeoutMs: 3 * 60_000,
    idPrefix: 'stopRecording',
  },
  {
    type: 'device.appearance',
    group: 'device',
    title: 'Dark / light mode',
    description: 'Switches the system appearance.',
    ports: ['out'],
    acceptsInput: true,
    params: [{ name: 'mode', kind: 'select', description: 'Appearance.', required: true, default: 'dark', options: [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }] }],
    outputs: [],
    needs: { device: true, deviceAction: 'appearance' },
    idPrefix: 'appearance',
  },
  {
    type: 'device.fontScale',
    group: 'device',
    title: 'Font size',
    description: 'Sets the system font scale (1 = default).',
    ports: ['out'],
    acceptsInput: true,
    params: [{ name: 'scale', kind: 'number', description: 'Scale, 0.85–2.', required: true, default: 1.3, min: 0.85, max: 2 }],
    outputs: [],
    needs: { device: true, deviceAction: 'font-scale' },
    idPrefix: 'fontScale',
  },
  {
    type: 'device.location',
    group: 'device',
    title: 'Set location',
    description: 'Moves the simulated location (simulators and emulators).',
    ports: ['out'],
    acceptsInput: true,
    params: [
      { name: 'lat', kind: 'number', description: 'Latitude.', required: true, default: 41.0082, min: -90, max: 90 },
      { name: 'lon', kind: 'number', description: 'Longitude.', required: true, default: 28.9784, min: -180, max: 180 },
    ],
    outputs: [],
    needs: { device: true, deviceAction: 'location' },
    idPrefix: 'location',
  },
  {
    type: 'device.pushNotification',
    group: 'device',
    title: 'Send a push notification',
    description: 'Delivers a push payload to the app (iOS simulator).',
    ports: ['out'],
    acceptsInput: true,
    params: [
      appIdParam(),
      { name: 'payload', kind: 'json', description: 'APNs payload.', required: true, default: { aps: { alert: { title: 'Dürbün', body: 'Test notification' } } } },
    ],
    outputs: [],
    needs: { device: true, deviceAction: 'push-notification' },
    idPrefix: 'push',
  },
  {
    type: 'device.inputText',
    group: 'device',
    title: 'Type text',
    description: 'Types into the focused field (Android).',
    ports: ['out'],
    acceptsInput: true,
    params: [{ name: 'text', kind: 'text', description: 'Text to type.', required: true }],
    outputs: [],
    needs: { device: true, deviceAction: 'input-text' },
    idPrefix: 'type',
  },
  {
    type: 'device.keyEvent',
    group: 'device',
    title: 'Press a key',
    description: 'Presses a hardware or system key (Android).',
    ports: ['out'],
    acceptsInput: true,
    params: [
      {
        name: 'key',
        kind: 'select',
        description: 'Key.',
        required: true,
        default: 'back',
        options: ['back', 'home', 'recents', 'enter', 'delete', 'menu', 'power', 'volume-up', 'volume-down'].map((k) => ({ value: k, label: k })),
      },
    ],
    outputs: [],
    needs: { device: true, deviceAction: 'key-event' },
    idPrefix: 'key',
  },
  {
    type: 'device.statusBar',
    group: 'device',
    title: 'Clean status bar',
    description: 'Shows a clean status bar for screenshots, or resets it (iOS simulator).',
    ports: ['out'],
    acceptsInput: true,
    params: [{ name: 'mode', kind: 'select', description: 'clean or reset.', required: true, default: 'clean', options: [{ value: 'clean', label: 'Clean' }, { value: 'reset', label: 'Reset' }] }],
    outputs: [],
    needs: { device: true, deviceAction: 'status-bar' },
    idPrefix: 'statusBar',
  },
  {
    type: 'device.animations',
    group: 'device',
    title: 'System animations',
    description: 'Turns system animations on or off (Android).',
    ports: ['out'],
    acceptsInput: true,
    params: [{ name: 'enabled', kind: 'boolean', description: 'Animations on.', required: true, default: false }],
    outputs: [],
    needs: { device: true, deviceAction: 'animations' },
    idPrefix: 'animations',
  },

  /* ── wait ── */
  {
    type: 'wait.network',
    group: 'wait',
    title: 'Wait for an app request',
    description:
      "Waits until the app under test makes a matching request and it finishes, then outputs it like an HTTP request step (status, headers, body…). Needs the app's network capture (Dürbün SDK).",
    ports: ['out'],
    acceptsInput: true,
    params: [
      { name: 'method', kind: 'select', description: 'HTTP method.', options: ANY_METHODS, default: '*' },
      { name: 'url', kind: 'text', description: 'URL pattern.', required: true, placeholder: '/v1/orders/' },
      { name: 'match', kind: 'select', description: 'How `url` matches.', options: URL_MATCH, default: 'contains' },
      { name: 'status', kind: 'text', description: "Only responses with this status: '2xx', '200,201' (empty = any, failed requests included).", default: '' },
      timeoutParam(30_000),
      sinceParam,
    ],
    outputs: [...HTTP_OUTPUTS, { name: 'request', description: 'request.headers and request.body of the app request' }, { name: 'error', description: 'Network error text when it failed' }],
    needs: { device: true, sdk: 'network' },
    timeoutMs: 31 * 60_000,
    idPrefix: 'waitRequest',
  },
  {
    type: 'wait.log',
    group: 'wait',
    title: 'Wait for a log line',
    description: 'Waits until a matching log line appears on the target device (device logs work without the SDK).',
    ports: ['out'],
    acceptsInput: true,
    params: [
      { name: 'text', kind: 'text', description: 'Text the line contains (or a regex when `regex` is on).', required: true },
      { name: 'regex', kind: 'boolean', description: 'Treat `text` as a regular expression; group 1 becomes {{<id>.match}}, every group {{<id>.groups}}.', default: false },
      { name: 'level', kind: 'select', description: 'Lowest level that counts.', options: LOG_LEVELS, default: 'verbose' },
      { name: 'tag', kind: 'text', description: 'Only this tag (exact, case-insensitive).', advanced: true },
      { name: 'appOnly', kind: 'boolean', description: "Only lines of the run's app.", default: true },
      timeoutParam(30_000),
      sinceParam,
    ],
    outputs: [
      { name: 'message', description: 'The line' },
      { name: 'match', description: 'Regex group 1 (or the whole match)' },
      { name: 'groups', description: 'Every regex group: groups[0] is the whole match, groups[1] the first group' },
      { name: 'level', description: 'Level' },
      { name: 'tag', description: 'Tag' },
      { name: 'data', description: 'Structured payload (SDK lines)' },
    ],
    needs: { device: true },
    timeoutMs: 31 * 60_000,
    idPrefix: 'waitLog',
  },
  {
    type: 'wait.event',
    group: 'wait',
    title: 'Wait for an app event',
    description: 'Waits for a custom event the app sends with the Dürbün SDK (Durbun.event(name, props)).',
    ports: ['out'],
    acceptsInput: true,
    params: [{ name: 'name', kind: 'text', description: 'Event name.', required: true, placeholder: 'checkout_completed' }, timeoutParam(30_000), sinceParam],
    outputs: [
      { name: 'name', description: 'Event name' },
      { name: 'props', description: 'Event properties' },
    ],
    needs: { device: true, sdk: 'events' },
    timeoutMs: 31 * 60_000,
    idPrefix: 'waitEvent',
  },

  /* ── mock ── */
  {
    type: 'mock.add',
    group: 'mock',
    title: 'Add a mock',
    description:
      "Adds a mock rule the app's SDK applies to matching requests: respond with a fake response, add delay, or fail. Removed when the run ends unless `keep` is on. Needs the Dürbün SDK in the app.",
    ports: ['out'],
    acceptsInput: true,
    params: [
      { name: 'name', kind: 'text', description: 'Rule name.' },
      { name: 'method', kind: 'select', description: 'HTTP method.', options: ANY_METHODS, default: '*' },
      { name: 'url', kind: 'text', description: 'URL pattern.', required: true, placeholder: '/v1/profile' },
      { name: 'match', kind: 'select', description: 'How `url` matches.', options: URL_MATCH, default: 'contains' },
      {
        name: 'action',
        kind: 'select',
        description: "'respond' = fake response, 'delay' = slow down the real request, 'fail' = network error.",
        default: 'respond',
        options: [
          { value: 'respond', label: 'Respond' },
          { value: 'delay', label: 'Delay' },
          { value: 'fail', label: 'Fail' },
        ],
      },
      { name: 'status', kind: 'number', description: 'Status code (respond).', default: 200, min: 100, max: 599, showIf: { param: 'action', values: ['respond'] } },
      { name: 'headers', kind: 'keyValue', description: 'Response headers (respond).', default: [['Content-Type', 'application/json']], showIf: { param: 'action', values: ['respond'] } },
      { name: 'body', kind: 'longText', description: 'Response body (respond).', default: '', showIf: { param: 'action', values: ['respond'] } },
      { name: 'delayMs', kind: 'number', description: 'Delay in ms.', default: 0, min: 0, max: 120_000 },
      {
        name: 'error',
        kind: 'select',
        description: 'Error kind (fail).',
        default: 'timeout',
        options: ['timeout', 'connection', 'dns', 'tls'].map((e) => ({ value: e, label: e })),
        showIf: { param: 'action', values: ['fail'] },
      },
      { name: 'appOnly', kind: 'boolean', description: "Apply only to the run's app.", default: true, advanced: true },
      { name: 'keep', kind: 'boolean', description: 'Keep the rule after the run.', default: false, advanced: true },
    ],
    outputs: [{ name: 'ruleId', description: 'Id of the rule' }],
    needs: { sdk: 'mocks' },
    idPrefix: 'mock',
  },
  {
    type: 'mock.toggle',
    group: 'mock',
    title: 'Turn a mock on/off',
    description: 'Enables or disables an existing mock rule (by id or name). Restored after the run unless `keep` is on.',
    ports: ['out'],
    acceptsInput: true,
    params: [
      { name: 'rule', kind: 'text', description: 'Rule id or name.', required: true },
      { name: 'enabled', kind: 'boolean', description: 'On or off.', required: true, default: true },
      { name: 'keep', kind: 'boolean', description: 'Keep the change after the run.', default: false, advanced: true },
    ],
    outputs: [],
    needs: { sdk: 'mocks' },
    idPrefix: 'toggleMock',
  },
  {
    type: 'mock.remove',
    group: 'mock',
    title: 'Remove a mock',
    description: 'Removes a mock rule (by id or name) — also one added earlier in this run.',
    ports: ['out'],
    acceptsInput: true,
    params: [{ name: 'rule', kind: 'text', description: 'Rule id or name.', required: true }],
    outputs: [],
    idPrefix: 'removeMock',
  },

  /* ── output ── */
  {
    type: 'output.marker',
    group: 'output',
    title: 'Timeline marker',
    description: 'Adds a marker line to the log timeline of the device, so the run is easy to find in the logs.',
    ports: ['out'],
    acceptsInput: true,
    params: [{ name: 'label', kind: 'text', description: 'Marker text.', default: '{{run.flowName}}' }],
    outputs: [],
    idPrefix: 'marker',
  },
  {
    type: 'output.slack',
    group: 'output',
    title: 'Send to Slack',
    description: "Posts a message to the team's Slack channel (Settings → Slack), optionally with the run summary so far.",
    ports: ['out'],
    acceptsInput: true,
    params: [
      { name: 'text', kind: 'longText', description: 'Message.', required: true, default: '{{run.flowName}}: {{run.status}}' },
      { name: 'includeSummary', kind: 'boolean', description: 'Append the steps so far.', default: true },
    ],
    outputs: [],
    needs: { slack: true },
    idPrefix: 'slack',
  },
  {
    type: 'output.note',
    group: 'output',
    title: 'Note',
    description: 'Writes a line into the run report (e.g. "Order {{vars.orderId}} created").',
    ports: ['out'],
    acceptsInput: true,
    params: [{ name: 'text', kind: 'longText', description: 'Text.', required: true }],
    outputs: [{ name: 'text', description: 'The resolved text' }],
    idPrefix: 'note',
  },
];

export const FLOW_NODE_TYPES: readonly string[] = FLOW_NODE_SPECS.map((s) => s.type);
const SPEC_BY_TYPE = new Map(FLOW_NODE_SPECS.map((s) => [s.type, s]));

export function flowNodeSpec(type: string): FlowNodeSpec | undefined {
  return SPEC_BY_TYPE.get(type);
}

export const FLOW_NODE_GROUPS: readonly FlowNodeGroup[] = ['trigger', 'http', 'logic', 'device', 'wait', 'mock', 'output'];

/**
 * Ports a node of this type can leave through: `error` for nodes with input, except a node that ends the run
 * (flow.end has no ports and cannot fail).
 */
export function flowNodePorts(type: string): FlowPort[] {
  const spec = flowNodeSpec(type);
  if (!spec) return ['out', 'error'];
  return spec.acceptsInput && spec.ports.length > 0 ? [...spec.ports, 'error'] : [...spec.ports];
}

/** Default params of a new node (only those with a default). */
export function defaultFlowParams(type: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of flowNodeSpec(type)?.params ?? []) {
    if (p.default !== undefined) out[p.name] = structuredCloneJson(p.default);
  }
  return out;
}

function structuredCloneJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/* ────────────────────────────── Device action support ────────────────────────────── */

export interface DeviceSupport {
  /** 'all' Android devices, 'emulator' only, 'none'. */
  android: 'all' | 'emulator' | 'none';
  iosSimulator: boolean;
  iosDevice: boolean;
}

/** What the platform drivers implement (packages/server/src/platform). */
export const DEVICE_ACTION_SUPPORT: Readonly<Record<DeviceActionId, DeviceSupport>> = {
  screenshot: { android: 'all', iosSimulator: true, iosDevice: true },
  'open-url': { android: 'all', iosSimulator: true, iosDevice: true },
  'list-apps': { android: 'all', iosSimulator: true, iosDevice: true },
  'app-launch': { android: 'all', iosSimulator: true, iosDevice: true },
  'app-stop': { android: 'all', iosSimulator: true, iosDevice: true },
  'app-restart': { android: 'all', iosSimulator: true, iosDevice: true },
  'app-clear-data': { android: 'all', iosSimulator: true, iosDevice: false },
  'app-uninstall': { android: 'all', iosSimulator: true, iosDevice: true },
  'app-install': { android: 'all', iosSimulator: true, iosDevice: true },
  'logs-clear-buffer': { android: 'all', iosSimulator: false, iosDevice: false },
  'logs-restart': { android: 'all', iosSimulator: true, iosDevice: true },
  appearance: { android: 'all', iosSimulator: true, iosDevice: false },
  'font-scale': { android: 'all', iosSimulator: true, iosDevice: false },
  animations: { android: 'all', iosSimulator: false, iosDevice: false },
  'input-text': { android: 'all', iosSimulator: false, iosDevice: false },
  'key-event': { android: 'all', iosSimulator: false, iosDevice: false },
  'push-notification': { android: 'none', iosSimulator: true, iosDevice: false },
  location: { android: 'emulator', iosSimulator: true, iosDevice: false },
  'status-bar': { android: 'none', iosSimulator: true, iosDevice: false },
  'screen-record': { android: 'all', iosSimulator: true, iosDevice: true },
  'screen-record-stop': { android: 'all', iosSimulator: true, iosDevice: true },
};

/** Does a device of this platform/kind support the action? */
export function deviceSupportsAction(action: DeviceActionId, platform: DevicePlatform | undefined, kind: DeviceKind | undefined): boolean {
  const s = DEVICE_ACTION_SUPPORT[action];
  if (!s) return false;
  if (platform === 'android') return s.android === 'all' || (s.android === 'emulator' && kind === 'emulator');
  if (platform === 'ios') return kind === 'physical' ? s.iosDevice : s.iosSimulator;
  return false;
}
