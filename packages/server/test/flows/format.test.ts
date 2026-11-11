/** Flow format details: template scanning, validation codes, equality, create-from-requests linking, the AI pack round trip. */
import { describe, expect, it } from 'vitest';
import {
  flowFromRequests,
  flowJsonSchema,
  looseEquals,
  resolveTemplate,
  templateSyntaxError,
  validateFlow,
  type FlowDoc,
  type FlowEnvironments,
} from '@durbun/protocol';
import { buildAiPack, extractFlowDocs, previewImport, type AiPackDeps } from '../../src/flows/aiPack';

type RawNode = { id: string; type: string; params?: Record<string, unknown> };
const raw = (nodes: RawNode[], edges: { from: string; to: string; port?: string }[] = []) => ({
  format: 'durbun-flow',
  version: 1,
  id: 't',
  name: 'T',
  nodes: [{ id: 'start', type: 'trigger.manual' }, ...nodes],
  edges: [{ from: 'start', to: nodes[0]!.id }, ...edges],
});
const issues = (r: unknown) => validateFlow(r).issues;
const codes = (r: unknown) => issues(r).map((i) => i.code);

describe('templates', () => {
  it('reads a }} without {{ as text (nested JSON) and reports only an unclosed {{', () => {
    expect(templateSyntaxError('{"data":{"id":1}}')).toBeNull();
    expect(resolveTemplate('{"a":{"b":"{{env.x}}"}}', { env: { x: '1' } })).toBe('{"a":{"b":"1"}}');
    expect(templateSyntaxError('{{a.b')).toContain('Unclosed {{');
    expect(templateSyntaxError('x }} y')).toBeNull();
  });

  it('reads quoted pipe arguments with }} and escaped quotes', () => {
    expect(templateSyntaxError("{{vars.x | default('}}')}}")).toBeNull();
    expect(resolveTemplate("{{vars.x | default('}}')}}", { vars: {} })).toBe('}}');
    expect(resolveTemplate("{{vars.x | default('it\\'s')}}", { vars: {} })).toBe("it's");
    expect(templateSyntaxError("{{vars.x | default('open)}}")).toContain('Unclosed quote');
  });

  it('says a template is a path, not an expression', () => {
    expect(templateSyntaxError('{{login.status > 0}}')).toContain('is not a path');
    expect(templateSyntaxError('{{vars.a + 1}}')).toContain('is not a path');
    expect(templateSyntaxError('{{vars.a || vars.b}}')).not.toBeNull();
    expect(templateSyntaxError("{{login.headers['x > y']}}")).toBeNull();
    expect(templateSyntaxError('{{vars.x | default(vars.y)}}')).toContain('fixed value');
  });
});

describe('equality', () => {
  it('compares canonical decimals as numbers, the rest as text', () => {
    expect(looseEquals('200', 200)).toBe(true);
    expect(looseEquals('1.50', 1.5)).toBe(true);
    expect(looseEquals('007', '7')).toBe(false);
    expect(looseEquals('0x10', 16)).toBe(false);
    expect(looseEquals('1e3', 1000)).toBe(false);
    expect(looseEquals(' 42 ', 42)).toBe(true);
  });
});

describe('validation', () => {
  it('keeps an object written for a text parameter as JSON text, with a warning', () => {
    const r = validateFlow(raw([{ id: 'n', type: 'output.note', params: { text: { a: 1 } } }]));
    expect(r.flow!.nodes[1]!.params!.text).toBe('{\n  "a": 1\n}');
    expect(r.issues.find((i) => i.code === 'flow.param.jsonText')).toMatchObject({ level: 'warning', params: { param: 'text' } });
  });

  it('checks rules: `in` lists, a missing right side, regexes', () => {
    const r = validateFlow(
      raw([
        {
          id: 'c',
          type: 'logic.condition',
          params: {
            rules: [
              { left: '{{vars.s}}', op: 'in', right: ['paid', 'pending'] },
              { left: '{{vars.s}}', op: 'equals' },
              { left: '{{vars.s}}', op: 'matches', right: '([a-z]+' },
              { left: '{{vars.s}}', op: 'exists' },
            ],
          },
        },
      ]),
    );
    const rules = r.flow!.nodes[1]!.params!.rules as { right?: string }[];
    expect(rules[0]!.right).toBe('paid, pending');
    const found = r.issues.filter((i) => i.level === 'error').map((i) => i.code);
    expect(found).toEqual(['flow.rule.right', 'flow.regex.invalid']);
  });

  it('rejects bad status filters, regexes and delay mocks; templates stay allowed where the engine reads them', () => {
    expect(codes(raw([{ id: 'h', type: 'http.request', params: { url: 'https://x.test', expectStatus: '2XX OK' } }]))).toContain('flow.param.status');
    expect(codes(raw([{ id: 'h', type: 'http.request', params: { url: 'https://x.test', expectStatus: '{{vars.s}}' } }]))).not.toContain('flow.param.status');
    expect(codes(raw([{ id: 'w', type: 'wait.log', params: { text: '([a-z', regex: true } }]))).toContain('flow.regex.invalid');
    expect(codes(raw([{ id: 'w', type: 'wait.log', params: { text: '([a-z', regex: false } }]))).not.toContain('flow.regex.invalid');
    expect(codes(raw([{ id: 'm', type: 'mock.add', params: { url: '/v1/cart', action: 'delay' } }]))).toContain('flow.mock.delay');
  });

  it('rejects templates in parameters read as written', () => {
    expect(issues(raw([{ id: 'e', type: 'flow.end', params: { status: '{{vars.s}}' } }])).find((i) => i.code === 'flow.param.fixed')?.params).toEqual({ param: 'status' });
    const r = issues(
      raw([
        {
          id: 'h',
          type: 'http.request',
          params: {
            url: 'https://x.test',
            extract: [
              { name: 'a', from: 'body', path: '{{vars.p}}' },
              { name: 'b', from: 'body', path: 'items[0' },
            ],
          },
        },
      ]),
    );
    expect(r.map((i) => i.code)).toEqual(expect.arrayContaining(['flow.param.fixed', 'flow.extract.pathSyntax']));
  });

  it('reads a JSONPath-style extract path from the body', () => {
    const r = validateFlow(raw([{ id: 'h', type: 'http.request', params: { url: 'https://x.test', extract: [{ name: 't', from: 'body', path: '$.data.token' }] } }]));
    expect((r.flow!.nodes[1]!.params!.extract as { path: string }[])[0]!.path).toBe('data.token');
    expect(r.issues.find((i) => i.code === 'flow.extract.pathFixed')).toMatchObject({ level: 'warning', params: { from: '$.data.token', to: 'data.token' } });
  });

  it('rejects prototype names as ids and variable names', () => {
    expect(codes(raw([{ id: '__proto__', type: 'output.note', params: { text: 'x' } }]))).toContain('flow.node.reservedId');
    expect(codes(raw([{ id: 's', type: 'logic.setVariables', params: { assignments: [{ name: 'constructor', value: '1' }] } }]))).toContain('flow.name.reserved');
  });

  it('requires lists the step cannot run without', () => {
    expect(issues(raw([{ id: 'a', type: 'check.assert', params: { assertions: [] } }])).find((i) => i.code === 'flow.param.required')?.params).toEqual({ param: 'assertions' });
  });

  it('fixes an id everywhere: edges and templates', () => {
    const r = validateFlow(
      raw(
        [
          { id: 'get-cart', type: 'http.request', params: { url: 'https://x.test' } },
          { id: 'note', type: 'output.note', params: { text: "{{get-cart.status}} {{get-cart.headers['x-id']}}" } },
        ],
        [{ from: 'get-cart', to: 'note' }],
      ),
    );
    expect(r.flow!.nodes.map((n) => n.id)).toEqual(['start', 'get_cart', 'note']);
    expect(r.flow!.edges).toEqual([
      { from: 'start', to: 'get_cart' },
      { from: 'get_cart', to: 'note' },
    ]);
    expect(r.flow!.nodes[2]!.params!.text).toBe("{{get_cart.status}} {{get_cart.headers['x-id']}}");
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('follows fixed flow ids in flow.call within one import', () => {
    const r = validateFlow(raw([{ id: 'c', type: 'flow.call', params: { flowId: 'Login Flow' } }]), {
      flowIdMap: new Map([['Login Flow', 'login-flow']]),
      knownFlowIds: new Set(['login-flow']),
    });
    expect(r.flow!.nodes[1]!.params!.flowId).toBe('login-flow');
    expect(r.issues.map((i) => i.code)).not.toContain('flow.call.unknown');
  });

  it('the schema marks fixed parameters, status filters and the `in` list', () => {
    const text = JSON.stringify(flowJsonSchema());
    expect(text).toContain('"not":{"pattern":"\\\\{\\\\{"}');
    expect(text).toContain('__proto__');
    expect(text).toContain('a JSON list');
  });
});

describe('flowFromRequests', () => {
  const login = {
    method: 'POST',
    url: 'https://api.test/v1/login',
    requestHeaders: [['content-type', 'application/json']] as [string, string][],
    requestBody: '{"username":"qa","password":"hunter22","newPassword":"s3cret-2"}',
    status: 200,
    responseBody: '{"status":"active","order":{"id":"ord_123456","n":123456},"weird":{"it\'s":"abc987654","a\'b\\"c":"zz998877"}}',
  };

  it('links whole ids only, never common words; secrets move to the environment', () => {
    const { flow, envVars } = flowFromRequests(
      [
        login,
        {
          method: 'POST',
          url: 'https://api.test/v1/orders/ord_123456/pay?state=active&token=t0k-xyz&id=abc987654',
          requestHeaders: [['content-type', 'application/json']],
          requestBody: '{"orderNumber":"123456","state":"active","odd":"zz998877","note":"for ord_123456"}',
        },
      ],
      { id: 'f', name: 'F' },
    );
    const login2 = flow.nodes[1]!;
    expect(login2.params!.body).toEqual({ username: 'qa', password: '{{env.password}}', newPassword: '{{env.newPassword}}' });
    const pay = flow.nodes[2]!;
    expect(pay.params!.url).toBe("{{env.baseUrl}}/v1/orders/{{postLogin.body.order.id}}/pay?state=active&token={{env.token | urlencode}}&id={{postLogin.body.weird[\"it's\"] | urlencode}}");
    // A number read as text says so; a key that cannot be written in a path stays a literal; text is not searched.
    expect(pay.params!.body).toEqual({ orderNumber: '{{postLogin.body.order.n | string}}', state: 'active', odd: 'zz998877', note: 'for ord_123456' });
    expect(envVars.filter((e) => e.secret).map((e) => e.key)).toEqual(['password', 'newPassword', 'token']);
  });

  it('links long random tokens inside a text body', () => {
    const { flow } = flowFromRequests(
      [
        { method: 'GET', url: 'https://api.test/v1/session', requestHeaders: [], status: 200, responseBody: '{"key":"AbCdEf0123456789xyz"}' },
        { method: 'POST', url: 'https://api.test/v1/raw', requestHeaders: [['content-type', 'text/plain']], requestBody: 'k=AbCdEf0123456789xyz;x=1' },
      ],
      { id: 'f', name: 'F' },
    );
    expect(flow.nodes[2]!.params!.body).toBe('k={{getSession.body.key}};x=1');
  });
});

describe('AI pack', () => {
  const envs: FlowEnvironments = {
    format: 'durbun-environments',
    version: 1,
    environments: [{ id: 'dev', name: 'Dev', vars: [{ key: 'token', value: 'tok-SECRET-123456', secret: true }, { key: 'pin', value: '4321', secret: true }, { key: 'baseUrl', value: 'https://api.test' }] }],
  } as FlowEnvironments;
  const editing: FlowDoc = {
    format: 'durbun-flow',
    version: 1,
    id: 'edit-me',
    name: 'Edit me',
    inputs: [{ name: 'pw', secret: true, default: 'pw-987654' }],
    nodes: [
      { id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } },
      {
        id: 'login',
        type: 'http.request',
        position: { x: 280, y: 0 },
        params: { url: 'https://api.test/v1/login?pin=4321&v=43210', headers: [['authorization', 'Bearer tok-SECRET-123456']], bodyType: 'json', body: { password: 'pw-987654' } },
      },
    ],
    edges: [{ from: 'start', to: 'login' }],
  };
  const deps = (network: unknown[] = []): AiPackDeps =>
    ({
      hub: { getNetwork: () => network, getApps: () => [], getDeviceApps: () => [], getDevices: () => [] },
      flows: { list: () => [editing], get: (id: string) => (id === editing.id ? editing : undefined) },
      environments: () => envs,
    }) as unknown as AiPackDeps;

  it('hides ids, tokens and e-mails in request paths', () => {
    const { markdown } = buildAiPack(
      deps([
        { deviceId: 'android:1', method: 'GET', url: 'https://api.test/v1/users/123456/orders/9f1c2d3e-1111-4222-8333-944445555666?x=1', state: 'done', status: 200 },
        { deviceId: 'android:1', method: 'GET', url: 'https://api.test/v1/users/qa%40example.com/reset/eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl', state: 'done', status: 200 },
        { deviceId: 'android:1', method: 'GET', url: 'https://api.test/v2/oauth2/items', state: 'done', status: 200 },
      ]),
      {},
    );
    expect(markdown).toContain('`GET https://api.test/v1/users/:id/orders/:id?x=…`');
    expect(markdown).toContain('`GET https://api.test/v1/users/:email/reset/:token`');
    expect(markdown).toContain('`GET https://api.test/v2/oauth2/items`');
    expect(markdown).not.toContain('123456');
  });

  it('masks secret values in the flow to change', () => {
    const { markdown } = buildAiPack(deps(), { flowId: 'edit-me', include: { requests: false, schema: false } });
    expect(markdown).not.toContain('tok-SECRET-123456');
    expect(markdown).not.toContain('pw-987654');
    expect(markdown).toContain('Bearer {{env.token}}');
    expect(markdown).toContain('"password": "{{input.pw}}"');
    // Short secrets only as a whole word.
    expect(markdown).toContain('pin={{env.pin}}&v=43210');
  });

  it('lists helper and pipe signatures, argument rules and the `in` syntax', () => {
    const { markdown } = buildAiPack(deps(), { include: { schema: false } });
    expect(markdown).toContain('`$randomInt(min, max)`');
    expect(markdown).toContain("`| default('x')`");
    expect(markdown).toContain('An argument cannot read a path');
    expect(markdown).toContain('"right": ["pending", "paid"]');
    expect(markdown).toContain('Ports: none (the run ends here)');
    expect(markdown).toContain('Written as is');
  });

  it('finds the flow in prose with brackets and among other code blocks', () => {
    const flow = { format: 'durbun-flow', version: 1, id: 'x', name: 'X', nodes: [{ id: 'start', type: 'trigger.manual' }], edges: [] };
    expect(extractFlowDocs(`See [1] and {name}. Here it is: ${JSON.stringify(flow)} Done.`)).toEqual({ docs: [flow], problems: [] });
    const withFence = { ...flow, nodes: [...flow.nodes, { id: 'n', type: 'output.note', params: { text: 'use ``` fences' } }] };
    const answer = ['Run this first:', '```bash', 'echo hi', '```', '', '```json', JSON.stringify(withFence, null, 2), '```', 'Set `baseUrl`.'].join('\n');
    expect(extractFlowDocs(answer)).toEqual({ docs: [withFence], problems: [] });
  });

  it('an imported edit keeps the layout and secret defaults; flow ids follow their fixes', () => {
    const answer = structuredClone(editing) as FlowDoc;
    for (const n of answer.nodes) delete n.position;
    delete answer.inputs![0]!.default;
    answer.nodes.push({ id: 'after', type: 'output.note', params: { text: 'done' } }, { id: 'call', type: 'flow.call', params: { flowId: 'Other Flow' } });
    answer.edges.push({ from: 'login', to: 'after' }, { from: 'after', to: 'call' });
    const other = { format: 'durbun-flow', version: 1, id: 'Other Flow', name: 'Other', nodes: [{ id: 'start', type: 'trigger.manual' }], edges: [] };
    const { items, problems } = previewImport([answer, other], { get: (id) => (id === editing.id ? editing : undefined), ids: () => new Set([editing.id]) });
    expect(problems).toEqual([]);
    const [edited, second] = items;
    expect(edited!.flow.nodes.slice(0, 2).map((n) => n.position)).toEqual([
      { x: 0, y: 0 },
      { x: 280, y: 0 },
    ]);
    expect(edited!.flow.nodes[2]!.position).toBeDefined();
    expect(edited!.flow.inputs![0]!.default).toBe('pw-987654');
    expect(edited!.flow.nodes[3]!.params!.flowId).toBe('other-flow');
    expect(edited!.issues.map((i) => i.code)).not.toContain('flow.call.unknown');
    expect(edited!.differs).toBe(true);
    expect(second!.flow.id).toBe('other-flow');
  });
});
