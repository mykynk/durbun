/**
 * Dürbün never calls an AI. The "AI pack" is a Markdown text the user gives to their own AI (ChatGPT, Claude,
 * Gemini, a local model…): what they want, the flow format with every node type, template and rule, what this
 * Dürbün knows (flows to call, environment variable names, apps, recent request URLs — never values or
 * secrets) and the answer format. The AI's answer comes back through the import, which finds the JSON in it,
 * validates it and shows the problems before anything is saved.
 */
import {
  FLOW_CONDITION_OPS,
  FLOW_FORMAT,
  FLOW_NODE_GROUPS,
  FLOW_NODE_SPECS,
  FLOW_VERSION,
  fixFlowId,
  flowJsonSchema,
  layoutMissing,
  PACKAGE_FORMAT,
  TEMPLATE_HELPERS,
  TEMPLATE_PIPES,
  validateFlow,
  type FlowDoc,
  type FlowEnvironments,
  type FlowIssue,
  type FlowParamSpec,
} from '@durbun/protocol';
import type { Hub } from '../types';

export interface AiPackRequest {
  /** What the user wants, in their words (any language). */
  goal?: string;
  /** Edit this flow instead of writing a new one. */
  flowId?: string;
  /** App and device the flow is for (recent requests come from it). */
  appId?: string;
  deviceId?: string;
  include?: { schema?: boolean; requests?: boolean; flows?: boolean; environments?: boolean };
  /** The UI language: the AI writes labels and descriptions in it. */
  language?: 'tr' | 'en';
}

export interface AiPackDeps {
  hub: Pick<Hub, 'getNetwork' | 'getApps' | 'getDeviceApps' | 'getDevices'>;
  flows: { list(): FlowDoc[]; get(id: string): FlowDoc | undefined };
  environments(): FlowEnvironments;
}

const GROUP_TITLES: Record<string, string> = {
  trigger: 'Start',
  http: 'HTTP',
  logic: 'Logic and checks',
  device: 'Device (the Mac drives the phone, emulator or simulator)',
  wait: 'Wait for the app',
  mock: 'Mock responses',
  output: 'Output',
};

function paramLine(p: FlowParamSpec): string {
  const bits: string[] = [];
  bits.push(`\`${p.name}\` (${p.kind}${p.required ? ', required' : ''})`);
  let text = p.description;
  if (p.options?.length) text += ` One of: ${p.options.map((o) => `\`${o.value}\``).join(', ')}.`;
  if (p.default !== undefined && !(Array.isArray(p.default) && p.default.length === 0) && p.default !== '') text += ` Default: \`${JSON.stringify(p.default)}\`.`;
  if (p.min !== undefined || p.max !== undefined) text += ` Range ${p.min ?? '…'}–${p.max ?? '…'}.`;
  if (p.showIf) text += ` Only when ${p.showIf.param} is ${p.showIf.values.map((v) => `\`${v}\``).join(' or ')}.`;
  if (p.example !== undefined) text += ` Example: \`${JSON.stringify(p.example)}\`.`;
  if (p.fixed && (p.kind === 'text' || p.kind === 'longText' || p.kind === 'number')) text += ' Written as is: no {{ }} templates here.';
  return `  - ${bits.join('')}: ${text}`;
}

/** `$randomInt(min, max)` (whole number…) — the signature when the description starts with one. */
function signatureLine(name: string, description: string, prefix = ''): string {
  const m = /^(\$?\w+\([^)]*\)): (.*)$/.exec(description);
  return m ? `\`${prefix}${m[1]}\` (${m[2]})` : `\`${prefix}${name}\` (${description})`;
}

/** Node catalog as Markdown. */
export function catalogMarkdown(): string {
  const out: string[] = [];
  for (const group of FLOW_NODE_GROUPS) {
    const specs = FLOW_NODE_SPECS.filter((s) => s.group === group);
    if (!specs.length) continue;
    out.push(`### ${GROUP_TITLES[group] ?? group}`, '');
    for (const s of specs) {
      const ports = s.ports.length ? [...s.ports, ...(s.acceptsInput ? ['error'] : [])].join(', ') : 'none (the run ends here)';
      out.push(`- **\`${s.type}\`** — ${s.title}. ${s.description}`);
      out.push(`  - Ports: ${ports}${s.irreversible ? ' · hard to undo on the device' : ''}${s.needs?.sdk ? ` · needs the app to use the Dürbün SDK (${s.needs.sdk})` : ''}`);
      for (const p of s.params) out.push(paramLine(p));
      if (s.outputs.length) out.push(`  - Output: ${s.outputs.map((o) => `\`${o.name}\` ${o.description.toLowerCase()}`).join('; ')}`);
    }
    out.push('');
  }
  return out.join('\n');
}

const EXAMPLE: FlowDoc = {
  format: FLOW_FORMAT,
  version: FLOW_VERSION,
  id: 'checkout-smoke',
  name: 'Checkout smoke test',
  description: 'Logs in, puts a product in the cart, opens the cart in the app and checks the totals.',
  inputs: [{ name: 'email', default: 'qa@example.com' }],
  target: { appId: 'com.example.shop' },
  nodes: [
    { id: 'start', type: 'trigger.manual' },
    {
      id: 'login',
      type: 'http.request',
      params: {
        method: 'POST',
        url: '{{env.baseUrl}}/v1/login',
        bodyType: 'json',
        body: { email: '{{input.email}}', password: '{{env.password}}' },
        expectStatus: '200',
        extract: [{ name: 'token', from: 'body', path: 'token' }],
      },
    },
    {
      id: 'addToCart',
      type: 'http.request',
      params: {
        method: 'POST',
        url: '{{env.baseUrl}}/v1/cart/items',
        headers: [['Authorization', 'Bearer {{vars.token}}']],
        bodyType: 'json',
        body: { productId: 42, quantity: 2 },
        expectStatus: '2xx',
      },
    },
    { id: 'openCart', type: 'device.openUrl', params: { url: 'shop://cart' } },
    { id: 'cartLoaded', type: 'wait.network', params: { method: 'GET', url: '/v1/cart', status: '2xx', timeoutMs: 15000 } },
    {
      id: 'checkTotals',
      type: 'check.assert',
      params: {
        assertions: [
          { left: '{{cartLoaded.body.items | length}}', op: 'gte', right: '1', message: 'The cart has the product' },
          { left: '{{cartLoaded.body.total}}', op: 'gt', right: '0', message: 'The total is shown' },
        ],
      },
    },
    { id: 'shot', type: 'device.screenshot', params: { name: 'Cart' } },
    { id: 'report', type: 'output.note', params: { text: 'Cart failed: {{addToCart.status}} {{addToCart.error}}' } },
  ],
  edges: [
    { from: 'start', to: 'login' },
    { from: 'login', to: 'addToCart' },
    { from: 'addToCart', to: 'openCart' },
    { from: 'addToCart', port: 'error', to: 'report' },
    { from: 'openCart', to: 'cartLoaded' },
    { from: 'cartLoaded', to: 'checkTotals' },
    { from: 'checkTotals', to: 'shot' },
  ],
};

const RULES = `## The flow format

A flow is one JSON document:

\`\`\`json
{ "format": "${FLOW_FORMAT}", "version": ${FLOW_VERSION}, "id": "kebab-case-id", "name": "Readable name",
  "description": "…", "inputs": [], "outputs": [], "target": { "appId": "…" },
  "settings": { "onUnsupported": "skip" }, "nodes": [], "edges": [] }
\`\`\`

- **nodes** are the steps: \`{ "id": "camelCaseId", "type": "<node type>", "label": "optional text", "params": { … } }\`.
  Node ids are unique, start with a letter or \`_\`, use letters, digits and \`_\` only, and say what the step does
  (\`login\`, \`createOrder\`, \`waitForCart\`). Do not use the ids \`env\`, \`vars\`, \`input\`, \`target\`, \`trigger\`, \`run\`, \`item\`
  (nor \`constructor\`, \`prototype\`, \`__proto__\` for ids or variable names).
- Optional on every node: \`"continueOnError": true\` (after a failure the run goes on the way it would after a pass:
  \`out\`, \`true\` after \`logic.condition\`, \`done\` after \`logic.repeat\`; an \`error\` edge wins), \`"retry": { "count": 2, "delayMs": 1000 }\`,
  \`"timeoutMs": 60000\`, \`"disabled": true\`, \`"note": "…"\`. Leave \`position\` out: Dürbün lays the graph out itself.
- **edges** connect them: \`{ "from": "login", "to": "addToCart" }\`. \`port\` picks which way the run leaves:
  \`out\` (default), \`true\`/\`false\` after \`logic.condition\`, \`loop\`/\`done\` after \`logic.repeat\`,
  and \`error\` on every step that takes input except \`flow.end\` — the run goes there when the step fails. Without an
  \`error\` edge (or \`continueOnError\`) a failure fails the whole run.
- Several edges from one port run in parallel. A step reached twice runs twice. Steps hanging off a repeat's \`loop\`
  port run once per iteration; an edge back to the repeat node ends the iteration.
- Every flow starts at a trigger: \`trigger.manual\` (the tester presses Run) and/or \`trigger.event\` (automatic).
- **inputs** are asked when the flow starts (or passed by a calling flow): \`{ "name": "email", "default": "…", "required": true, "secret": false }\`.
  **outputs** are what a calling flow reads: \`{ "name": "orderId", "value": "{{createOrder.body.id}}" }\`.
- Put base URLs, tokens and passwords in environment variables (\`{{env.baseUrl}}\`, \`{{env.password}}\`), never in the flow.

## Templates

Any text parameter may contain \`{{ … }}\`:

- \`{{login.body.token}}\` — output of node \`login\` (see each node's Output). Bracket keys for odd names:
  \`{{login.headers['x-request-id']}}\`; list items: \`{{orders.body.items[0].id}}\`.
- \`{{vars.name}}\` (set by \`logic.setVariables\` or an HTTP \`extract\`), \`{{env.key}}\`, \`{{input.name}}\`,
  \`{{target.appId}}\` / \`{{target.deviceId}}\` / \`{{target.platform}}\`, \`{{trigger.message}}\` (automatic runs),
  \`{{run.id}}\` / \`{{run.flowName}}\` / \`{{run.status}}\` (the result so far: "failed" once any step failed, even a
  handled one, else "passed"), \`{{item}}\` inside a repeat over a list. A disabled or skipped step reads as empty.
- Helpers, as \`{{$uuid}}\` or \`{{$randomInt(1, 100)}}\`: ${Object.entries(TEMPLATE_HELPERS)
  .map(([k, v]) => signatureLine(k, v.description))
  .join(', ')}.
- Pipes, as \`{{orders.body.items | length}}\` (several: \`{{x | trim | upper}}\`): ${Object.entries(TEMPLATE_PIPES)
  .map(([k, v]) => signatureLine(k, v.description, '| '))
  .join(', ')}.
- Helper and pipe arguments are fixed values: numbers, \`true\`/\`false\`/\`null\` or text in quotes (\`default('none')\`,
  \`\\'\` for a quote inside). An argument cannot read a path: \`default(input.x)\` is an error.
- A template only reads a value: \`{{a.b > 0}}\`, \`{{a + 1}}\` or \`{{a == b}}\` are errors — compare in a condition rule.
- A value that is exactly one template keeps its type (\`"{{orders.body.items}}"\` is a list); inside longer text it becomes text.
- Every \`{{\` needs a \`}}\`; a \`}}\` alone is plain text. A literal \`{{\` cannot be written.
- Parameters marked "Written as is" take a fixed value, never a template.

## Rules (conditions and checks)

\`{ "left": "{{getCart.status}}", "op": "equals", "right": "200" }\` — \`check.assert\` adds \`"message"\`.
Operators: ${FLOW_CONDITION_OPS.map((o) => `\`${o.op}\`${o.unary ? ' (no right side)' : ''}`).join(', ')}. Every other operator needs \`right\`.
\`in\` takes a comma-separated list (\`"right": "pending, paid"\`) or a JSON list (\`"right": ["pending", "paid"]\`).
\`matches\` takes a regular expression (\`"^ord_[0-9]+$"\`).
\`equals\` compares plain decimals as numbers (\`"200"\` equals \`200\`, \`"1.50"\` equals \`1.5\`) and everything else as
exact text (\`"007"\` does not equal \`"7"\`); \`gt\`/\`gte\`/\`lt\`/\`lte\` compare numbers.
Status specs (\`expectStatus\`, \`status\`): \`200\`, \`2xx\`, \`200,201\`, \`200-299\`.
URL matches (\`match\`): \`contains\`, \`exact\`, \`glob\` (\`*\` any text), \`regex\`.
`;

/** A path segment that carries data (an id, a token, an e-mail) shown as `:id`, `:token`, `:email`. */
function maskSegment(segment: string): string {
  if (!segment) return segment;
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {
    /* keep */
  }
  if (/^[^@\s/]+@[^@\s/]+$/.test(s)) return ':email';
  if (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || (/^[0-9a-f]{12,}$/i.test(s) && /\d/.test(s))) return ':id';
  if (s.length >= 20 && /\d/.test(s) && /[A-Za-z]/.test(s)) return ':token';
  if (s.split('.').length === 3 && s.length >= 20) return ':token';
  if ((s.match(/\d/g)?.length ?? 0) >= 4) return ':id';
  return segment;
}

function recentRequests(deps: AiPackDeps, req: AiPackRequest): string[] {
  const apps = deps.hub.getApps();
  const appOf = (appId: string | undefined) => (appId ? apps.find((a) => a.id === appId)?.app.id : undefined);
  const seen = new Set<string>();
  const lines: string[] = [];
  const entries = deps.hub.getNetwork().filter((e) => e.deviceId !== 'desktop' && !e.deviceId.startsWith('import:'));
  for (const e of entries.slice(-400).reverse()) {
    if (req.appId && appOf(e.appId) !== req.appId) continue;
    if (req.deviceId && e.deviceId !== req.deviceId) continue;
    let shown: string;
    try {
      const u = new URL(e.url);
      // Query values may carry tokens: keep the names only.
      const keys = [...new Set([...u.searchParams.keys()])];
      const path = u.pathname.split('/').map(maskSegment).join('/');
      shown = `${u.origin}${path}${keys.length ? `?${keys.map((k) => `${k}=…`).join('&')}` : ''}`;
    } catch {
      continue;
    }
    const key = `${e.method} ${shown}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- \`${e.method} ${shown}\` → ${e.state === 'failed' ? 'failed' : (e.status ?? '…')}${e.responseContentType ? ` (${e.responseContentType.split(';')[0]})` : ''}`);
    if (lines.length >= 40) break;
  }
  return lines.reverse();
}

export function buildAiPack(deps: AiPackDeps, req: AiPackRequest): { markdown: string; flow?: FlowDoc } {
  const inc = { schema: true, requests: true, flows: true, environments: true, ...req.include };
  const editing = req.flowId ? deps.flows.get(req.flowId) : undefined;
  const lang = req.language === 'tr' ? 'Turkish' : 'English';
  const out: string[] = [];
  out.push(editing ? `# Change a Dürbün flow` : `# Write a Dürbün flow`, '');
  out.push(
    'You are helping a software tester. **Dürbün** is a Mac app that watches mobile apps (Android, iOS) and runs **flows**:',
    'graphs of steps that call HTTP APIs, drive the phone/emulator/simulator, wait for what the app does (requests, logs,',
    'events), mock responses, check results and report. Write the flow described below as Dürbün flow JSON.',
    '',
  );
  out.push('## What the flow should do', '');
  out.push(req.goal?.trim() ? req.goal.trim() : '_(Describe the flow here: what to call or tap, what to check, what to do when something fails.)_', '');

  if (editing) {
    const shown = stripPositions(maskSecrets(editing, deps.environments()));
    out.push('## The flow to change', '', 'Keep the ids of the steps you do not change (other flows and templates refer to them).', '', '```json', JSON.stringify(shown, null, 2), '```', '');
  }

  out.push('## How to answer', '');
  out.push(
    `- Reply with **one** \`\`\`json code block holding the complete flow document${editing ? ' (the whole flow, not a diff)' : ''}. For several flows, a JSON list of flow documents.`,
    `- Write \`name\`, \`description\`, labels and messages in ${lang}; keep ids and JSON keys in English.`,
    '- Only use the node types and parameters listed below. Do not invent fields.',
    '- If something needs a value you do not know (a URL, a product id, a password), use an environment variable or an input and say so after the JSON.',
    '- After the JSON, list in two or three short lines what the tester has to set up (environment variables, inputs, app id).',
    '',
  );

  out.push(RULES, '');
  out.push('## Node types', '', catalogMarkdown());

  out.push('## A complete example', '', '```json', JSON.stringify(EXAMPLE, null, 2), '```', '');

  const context: string[] = [];
  if (inc.flows) {
    const flows = deps.flows.list().filter((f) => f.id !== editing?.id);
    if (flows.length) {
      context.push('### Flows that exist (`flow.call` can run them)', '');
      for (const f of flows.slice(0, 60)) {
        const ins = (f.inputs ?? []).map((i) => `${i.name}${i.required ? '*' : ''}`).join(', ');
        const outs = (f.outputs ?? []).map((o) => o.name).join(', ');
        context.push(`- \`${f.id}\` — ${f.name}${f.description ? `: ${f.description}` : ''}${ins ? ` · inputs: ${ins}` : ''}${outs ? ` · outputs: ${outs}` : ''}`);
      }
      context.push('');
    }
  }
  if (inc.environments) {
    const envs = deps.environments().environments;
    const keys = [...new Set(envs.flatMap((e) => e.vars.map((v) => v.key)))];
    if (keys.length) {
      context.push('### Environment variables that exist', '', `Environments: ${envs.map((e) => e.name).join(', ')}. Variables: ${keys.map((k) => `\`{{env.${k}}}\``).join(', ')}. Use these names; add new ones only when needed.`, '');
    }
  }
  const appIds = [...new Set([...deps.hub.getApps().map((a) => `${a.app.id} (${a.app.name})`), ...deps.hub.getDeviceApps().map((a) => a.id)])].slice(0, 30);
  if (req.appId || appIds.length) {
    context.push('### App', '');
    if (req.appId) context.push(`The flow is for \`${req.appId}\`: set \`"target": { "appId": "${req.appId}" }\`.`);
    else context.push(`Apps seen in Dürbün: ${appIds.map((a) => `\`${a}\``).join(', ')}.`);
    const platforms = [...new Set(deps.hub.getDevices().filter((d) => d.state === 'online' && d.id !== 'desktop').map((d) => `${d.platform} ${d.kind}`))];
    if (platforms.length) context.push(`Connected devices: ${platforms.join(', ')}.`);
    context.push('');
  }
  if (inc.requests) {
    const lines = recentRequests(deps, req);
    if (lines.length) context.push('### Requests the app sent recently (query values and ids in paths hidden)', '', ...lines, '');
  }
  if (context.length) out.push("## What this Dürbün knows", '', ...context);

  if (inc.schema) {
    out.push('## JSON Schema of a flow', '', '```json', JSON.stringify(flowJsonSchema()), '```', '');
  }
  return { markdown: out.join('\n'), flow: editing };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The flow with secret values (secret environment variables, secret input defaults) replaced by the template that
 * reads them: a token pasted into a header becomes `{{env.token}}` before the AI sees it.
 */
function maskSecrets(flow: FlowDoc, envs: FlowEnvironments): FlowDoc {
  const secrets = new Map<string, string>();
  for (const i of flow.inputs ?? []) if (i.secret && i.default !== undefined && String(i.default).length >= 3) secrets.set(String(i.default), `{{input.${i.name}}}`);
  for (const e of envs.environments) for (const v of e.vars) if (v.secret && v.value.length >= 3 && !secrets.has(v.value)) secrets.set(v.value, `{{env.${v.key}}}`);
  if (secrets.size === 0) return flow;
  const list = [...secrets.entries()].sort((a, b) => b[0].length - a[0].length);
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mask = (text: string): string => {
    let out = text;
    for (const [value, template] of list) {
      if (out === value) return template;
      if (value.length < 4 || !out.includes(value)) continue;
      // Long secrets anywhere; short ones only as a whole word ("Bearer 1234", not "/items/12345").
      out = value.length >= 12 ? out.split(value).join(template) : out.replace(new RegExp(`(?<![A-Za-z0-9])${escape(value)}(?![A-Za-z0-9])`, 'g'), () => template);
    }
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return mask(v);
    if (typeof v === 'number' && secrets.has(String(v)) && String(v).length >= 4) return `${secrets.get(String(v))!.slice(0, -2)} | number}}`;
    if (Array.isArray(v)) return v.map(walk);
    if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const copy = structuredClone(flow);
  if (copy.description) copy.description = mask(copy.description);
  for (const n of copy.nodes) {
    if (n.params) n.params = walk(n.params) as Record<string, unknown>;
    if (n.label) n.label = mask(n.label);
    if (n.note) n.note = mask(n.note);
  }
  for (const o of copy.outputs ?? []) o.value = mask(o.value);
  for (const i of copy.inputs ?? []) if (!i.secret && typeof i.default === 'string') i.default = mask(i.default);
  return copy;
}

/** A flow without layout and timestamps, to tell whether an import changes it. */
function comparable(flow: FlowDoc): string {
  const copy = structuredClone(flow);
  for (const n of copy.nodes) delete n.position;
  delete copy.createdAt;
  delete copy.updatedAt;
  return JSON.stringify(copy);
}

function stripPositions(flow: FlowDoc): FlowDoc {
  const copy = structuredClone(flow);
  for (const n of copy.nodes) delete n.position;
  // A secret input's default is a password or a token: the AI needs the name only.
  for (const i of copy.inputs ?? []) if (i.secret) delete i.default;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy;
}

/* ────────────────────────────── reading an answer ────────────────────────────── */

/** JSON with comments and trailing commas (what AIs and people write) → strict JSON text. */
export function relaxJson(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function parseLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(relaxJson(text));
  }
}

/** The balanced {...} or [...] that starts at `start`, matched with strings in mind. */
function balancedAt(text: string, start: number): string | undefined {
  const open = text[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/** Does a parsed value hold a flow (a flow, a list of flows, a package, `{ "flow": … }`)? */
function holdsFlow(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(holdsFlow);
  if (!isRecord(v)) return false;
  return Array.isArray(v.nodes) || Array.isArray(v.flows) || v.format === PACKAGE_FORMAT || isRecord(v.flow);
}

/**
 * The JSON in a text without code fences. Prose before it may hold brackets ("see [1]", "{name}"): every `{` / `[`
 * is tried in order, and the first balanced block that parses and holds a flow wins; otherwise the first one that
 * parses, otherwise the first balanced one (its parse error is reported).
 */
function outerJson(text: string): string | undefined {
  let firstParsed: string | undefined;
  let firstBalanced: string | undefined;
  let tries = 0;
  for (let i = text.search(/[[{]/); i >= 0 && i < text.length && tries < 200; i++) {
    const c = text[i];
    if (c !== '{' && c !== '[') continue;
    tries++;
    const block = balancedAt(text, i);
    if (!block) continue;
    firstBalanced ??= block;
    let value: unknown;
    try {
      value = parseLoose(block);
    } catch {
      continue;
    }
    if (holdsFlow(value)) return block;
    firstParsed ??= block;
  }
  return firstParsed ?? firstBalanced;
}

/** Code blocks of a Markdown text: a fence line (``` or longer, with an optional language) up to a line with the same fence. */
function codeBlocks(text: string): { lang: string; body: string }[] {
  const blocks: { lang: string; body: string }[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)/.exec(lines[i]!);
    if (!open) continue;
    const fence = open[1]!;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const t = lines[j]!.trim();
      if (t.startsWith(fence[0]!.repeat(fence.length)) && /^(`+|~+)$/.test(t) && t[0] === fence[0]) break;
      body.push(lines[j]!);
    }
    blocks.push({ lang: open[2]!.toLowerCase(), body: body.join('\n') });
    i = j;
  }
  return blocks;
}

const JSON_LANGS = new Set(['', 'json', 'jsonc', 'json5', 'javascript', 'js']);

/** Flow documents found in an AI answer, a flow file, a list of flows or a Dürbün package. */
export function extractFlowDocs(text: string): { docs: unknown[]; problems: string[] } {
  const problems: string[] = [];
  const candidates: string[] = [];
  // Blocks in another language (a shell command, a YAML sample) are not flows; skip them quietly.
  for (const b of codeBlocks(text)) if (JSON_LANGS.has(b.lang) || /^\s*[[{]/.test(b.body)) candidates.push(b.body);
  if (candidates.length === 0) {
    const trimmed = text.trim();
    candidates.push(/^[[{]/.test(trimmed) ? trimmed : (outerJson(trimmed) ?? ''));
  }
  const docs: unknown[] = [];
  for (const c of candidates) {
    if (!c.trim()) continue;
    let value: unknown;
    try {
      value = parseLoose(c.trim());
    } catch (err) {
      const inner = outerJson(c);
      try {
        if (!inner) throw err;
        value = parseLoose(inner);
      } catch (err2) {
        problems.push(`Not valid JSON: ${(err2 as Error).message}`);
        continue;
      }
    }
    const add = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(add);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (o.format === PACKAGE_FORMAT && o.contents && typeof o.contents === 'object') add((o.contents as Record<string, unknown>).flows ?? []);
        else if (Array.isArray(o.flows) && !Array.isArray(o.nodes)) add(o.flows);
        else if (o.flow && typeof o.flow === 'object' && !Array.isArray(o.nodes)) add(o.flow);
        else if (Array.isArray(o.nodes)) docs.push(o);
        else if (!('$schema' in o)) problems.push('A JSON block that is not a flow was ignored');
      }
    };
    add(value);
  }
  if (docs.length === 0 && problems.length === 0) problems.push('No flow JSON was found in the text');
  return { docs, problems };
}

export interface ImportPreviewItem {
  flow: FlowDoc;
  issues: FlowIssue[];
  /** A flow with this id exists here. */
  exists: boolean;
  differs: boolean;
  /** Node count, for the preview. */
  nodes: number;
}

/**
 * Validate what an import would add. Ids that are not file-safe are fixed, and `flow.call` steps of the same import
 * follow the fixed ids. A flow that replaces one here keeps the positions of the steps it shares with it (and the
 * secret input defaults the AI pack left out); only new steps are laid out.
 */
export function previewImport(docs: unknown[], existing: { get(id: string): FlowDoc | undefined; ids(): Set<string> }): { items: ImportPreviewItem[]; problems: string[] } {
  const problems: string[] = [];
  const items: ImportPreviewItem[] = [];
  const flowIdMap = new Map<string, string>();
  for (const d of docs) {
    const id = isRecord(d) && typeof d.id === 'string' ? d.id : '';
    if (id && fixFlowId(id) !== id) flowIdMap.set(id, fixFlowId(id));
  }
  const known = new Set([...existing.ids(), ...docs.map((d) => (isRecord(d) && typeof d.id === 'string' ? fixFlowId(d.id) : '')).filter(Boolean)]);
  const used = new Set<string>();
  for (const raw of docs) {
    const { flow, issues } = validateFlow(raw, { knownFlowIds: known, flowIdMap });
    if (!flow) {
      problems.push(issues[0]?.message ?? 'Not a flow');
      continue;
    }
    if (used.has(flow.id)) {
      problems.push(`Two flows have the id ${flow.id}; the second was left out`);
      continue;
    }
    used.add(flow.id);
    const current = existing.get(flow.id);
    let merged = flow;
    if (current) {
      const before = new Map(current.nodes.map((n) => [n.id, n]));
      merged = {
        ...flow,
        nodes: flow.nodes.map((n) => {
          const old = before.get(n.id);
          return !n.position && old?.position && old.type === n.type ? { ...n, position: { ...old.position } } : n;
        }),
        ...(flow.inputs
          ? {
              inputs: flow.inputs.map((i) => {
                const old = current.inputs?.find((o) => o.name === i.name);
                return i.secret && i.default === undefined && old?.secret && old.default !== undefined ? { ...i, default: old.default } : i;
              }),
            }
          : {}),
      };
    }
    const laid = layoutMissing(merged);
    const differs = !!current && comparable(current) !== comparable(laid);
    items.push({ flow: laid, issues, exists: !!current, differs, nodes: laid.nodes.length });
  }
  return { items, problems };
}
