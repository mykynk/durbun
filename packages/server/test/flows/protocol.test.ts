/** The flow format in @durbun/protocol: templates, rules, validation, layout, schema, create-from-requests. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateRule,
  flowFromRequests,
  flowJsonSchema,
  FLOW_NODE_SPECS,
  layoutFlow,
  layoutMissing,
  renameTemplateRoot,
  resolveTemplate,
  resolveText,
  slugifyFlowId,
  statusMatches,
  suggestNodeType,
  templateSyntaxError,
  TemplateError,
  urlMatches,
  validateFlow,
  type FlowDoc,
} from '@durbun/protocol';

const scope = {
  login: { body: { token: 'tok', items: [{ id: 7 }, { id: 8 }], total: 42.5 }, headers: { 'x-req': 'abc' }, status: 201 },
  vars: { n: 3 },
  env: { baseUrl: 'https://api.test' },
};

describe('templates', () => {
  it('reads node outputs, brackets, indexes and keeps the type of a lone template', () => {
    expect(resolveTemplate('{{login.body.token}}', scope)).toBe('tok');
    expect(resolveTemplate("{{login.headers['x-req']}}", scope)).toBe('abc');
    expect(resolveTemplate('{{login.body.items[1].id}}', scope)).toBe(8);
    expect(resolveTemplate('{{login.body.items}}', scope)).toEqual([{ id: 7 }, { id: 8 }]);
    expect(resolveTemplate('{{env.baseUrl}}/v1?n={{vars.n}}', scope)).toBe('https://api.test/v1?n=3');
    expect(resolveText({ a: 1 }, scope)).toBe('{"a":1}');
  });

  it('applies pipes and helpers', () => {
    expect(resolveTemplate('{{login.body.items | length}}', scope)).toBe(2);
    expect(resolveTemplate('{{login.body.items | first | json}}', scope)).toBe('{"id":7}');
    expect(resolveTemplate("{{vars.missing | default('x')}}", scope)).toBe('x');
    expect(resolveTemplate('{{env.baseUrl | urlencode}}', scope)).toBe('https%3A%2F%2Fapi.test');
    expect(resolveTemplate('{{env.baseUrl | upper | base64}}', scope)).toBe(Buffer.from('HTTPS://API.TEST').toString('base64'));
    expect(templateSyntaxError('{{env.baseUrl | base64}}')).toBeNull();
    expect(resolveTemplate('{{$uuid}}', scope)).toMatch(/^[0-9a-f-]{36}$/);
    const n = resolveTemplate('{{$randomInt(5, 6)}}', scope) as number;
    expect([5, 6]).toContain(n);
    expect(resolveTemplate('{{$randomEmail}}', scope)).toMatch(/@/);
  });

  it('throws a coded error for unknown roots, helpers and pipes', () => {
    expect(() => resolveTemplate('{{nope.x}}', scope)).toThrow(TemplateError);
    expect(() => resolveTemplate('{{$nope}}', scope)).toThrow(expect.objectContaining({ code: 'template.unknownHelper' }));
    expect(() => resolveTemplate('{{vars.n | shout}}', scope)).toThrow(expect.objectContaining({ code: 'template.unknownPipe' }));
    expect(resolveTemplate('{{nope.x}}', scope, { strict: false })).toBeUndefined();
  });

  it('checks syntax without a scope and renames roots', () => {
    expect(templateSyntaxError('{{a.b}}')).toBeNull();
    expect(templateSyntaxError('{{a.b')).toBe('Unclosed {{ (every {{ needs a }} after it)');
    expect(templateSyntaxError('{{}}')).toBe('Empty {{ }}');
    expect(templateSyntaxError('{{a | nope}}')).toContain('Unknown pipe');
    expect(renameTemplateRoot({ x: ['{{login.body.token}} and {{loginX.y}}'] }, 'login', 'signIn')).toEqual({ x: ['{{signIn.body.token}} and {{loginX.y}}'] });
  });
});

describe('rules', () => {
  it('compares numbers as numbers and explains itself', () => {
    expect(evaluateRule({ left: '{{login.status}}', op: 'equals', right: '201' }, scope).ok).toBe(true);
    expect(evaluateRule({ left: '{{login.body.total}}', op: 'gt', right: '40' }, scope).ok).toBe(true);
    expect(evaluateRule({ left: '10', op: 'lt', right: '9' }, scope).ok).toBe(false);
    expect(evaluateRule({ left: '{{login.body.items}}', op: 'isNotEmpty' }, scope).ok).toBe(true);
    expect(evaluateRule({ left: 'b', op: 'in', right: 'a, b, c' }, scope).ok).toBe(true);
    expect(evaluateRule({ left: 'abc-123', op: 'matches', right: '^abc-\\d+$' }, scope).ok).toBe(true);
    const r = evaluateRule({ left: '{{login.status}}', op: 'equals', right: '200' }, scope);
    expect(r.explain).toContain('201');
  });

  it('matches status specs and URLs', () => {
    expect(statusMatches(204, '2xx')).toBe(true);
    expect(statusMatches(404, '200,201')).toBe(false);
    expect(statusMatches(250, '200-299')).toBe(true);
    expect(urlMatches('https://a.test/v1/cart?x=1', '/v1/cart', 'contains')).toBe(true);
    expect(urlMatches('https://a.test/v1/cart', 'https://a.test/v1/*', 'glob')).toBe(true);
    expect(urlMatches('https://a.test/v1/cart', 'cart$', 'regex')).toBe(true);
  });
});

describe('validateFlow', () => {
  it('normalizes what AIs and people write', () => {
    const { flow, issues } = validateFlow({
      name: 'Sipariş akışı',
      nodes: [
        { id: 'a', type: 'http.request', params: { url: 'https://x.test', headers: { Accept: 'application/json' }, method: 'post' } },
        { id: 'b', type: 'logic.condition', params: { rules: [{ left: '{{a.status}}', op: '==', right: '200' }] } },
      ],
      edges: [{ source: 'a', target: 'b' }],
    });
    expect(flow!.id).toBe('siparis-akisi');
    expect(flow!.nodes[0]!.type).toBe('trigger.manual');
    expect(flow!.nodes.find((n) => n.id === 'a')!.params!.headers).toEqual([['Accept', 'application/json']]);
    expect(flow!.nodes.find((n) => n.id === 'a')!.params!.method).toBe('POST');
    expect((flow!.nodes.find((n) => n.id === 'b')!.params!.rules as { op: string }[])[0]!.op).toBe('equals');
    expect(issues.map((i) => i.code)).toContain('flow.trigger.added');
  });

  it('reports unknown types with a suggestion, bad ports and unknown references', () => {
    const { issues } = validateFlow({
      id: 'x',
      name: 'x',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        { id: 'req', type: 'http.requst', params: {} },
        { id: 'c', type: 'logic.condition', params: { rules: [{ left: '{{ghost.x}}', op: 'exists' }] } },
        { id: 'call', type: 'flow.call', params: { flowId: 'missing' } },
      ],
      edges: [
        { from: 'start', to: 'c' },
        { from: 'c', port: 'out', to: 'call' },
      ],
    }, { knownFlowIds: new Set() });
    const codes = issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['flow.node.unknownType', 'flow.edge.port', 'flow.template.unknownRoot', 'flow.call.unknown']));
    expect(issues.find((i) => i.code === 'flow.node.unknownType')!.message).toContain('http.request');
    expect(suggestNodeType('wait.netwrok')).toBe('wait.network');
  });

  it('accepts every catalog default', () => {
    for (const spec of FLOW_NODE_SPECS) {
      const params = Object.fromEntries(spec.params.filter((p) => p.example !== undefined || p.default !== undefined).map((p) => [p.name, p.example ?? p.default]));
      for (const p of spec.params) if (p.required && params[p.name] === undefined) params[p.name] = p.kind === 'number' ? 1 : p.kind === 'flowRef' ? 'other' : 'x';
      const { issues } = validateFlow(
        { id: 'all', name: 'all', nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'n', type: spec.type, params }], edges: spec.type.startsWith('trigger.') ? [] : [{ from: 'start', to: 'n' }] },
        { knownFlowIds: new Set(['other']) },
      );
      expect(issues.filter((i) => i.level === 'error'), spec.type).toEqual([]);
    }
  });

  it('makes file-safe ids', () => {
    expect(slugifyFlowId('Ödeme → İptal Akışı')).toBe('odeme-iptal-akisi');
  });
});

describe('layout', () => {
  it('places nodes in run order, loops included', () => {
    const flow: FlowDoc = {
      format: 'durbun-flow',
      version: 1,
      id: 'l',
      name: 'l',
      nodes: ['start', 'a', 'b', 'c'].map((id) => ({ id, type: id === 'start' ? 'trigger.manual' : 'output.note' })),
      edges: [
        { from: 'start', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'c', to: 'a' },
      ],
    };
    const laid = layoutFlow(flow);
    const x = Object.fromEntries(laid.nodes.map((n) => [n.id, n.position!.x]));
    expect(x.start).toBeLessThan(x.a!);
    expect(x.a).toBeLessThan(x.b!);
    expect(x.b).toBe(x.c);
    const partial = layoutMissing({ ...laid, nodes: [...laid.nodes, { id: 'd', type: 'output.note' }], edges: [...laid.edges, { from: 'b', to: 'd' }] });
    expect(partial.nodes.find((n) => n.id === 'd')!.position!.x).toBeGreaterThan(x.b!);
  });
});

describe('flowFromRequests', () => {
  it('links values, moves the origin and secrets into the environment', () => {
    const { flow, envVars, links } = flowFromRequests(
      [
        {
          method: 'POST',
          url: 'https://api.test/v1/login',
          requestHeaders: [['content-type', 'application/json'], ['x-api-key', 'key-123456']],
          requestBody: '{"email":"a@b.c"}',
          status: 200,
          responseBody: '{"data":{"token":"tok-abcdef"},"user":{"id":123456}}',
          responseHeaders: [['x-session', 'sess-12345678']],
        },
        {
          method: 'GET',
          url: 'https://api.test/v1/users/123456/orders',
          requestHeaders: [['authorization', 'Bearer tok-abcdef'], ['x-session', 'sess-12345678']],
          status: 200,
        },
      ],
      { id: 'f', name: 'F' },
    );
    const [, login, orders] = flow.nodes;
    expect(login!.id).toBe('postLogin');
    expect(login!.params!.bodyType).toBe('json');
    expect(login!.params!.headers).toEqual([['x-api-key', '{{env.apiKey}}']]);
    expect(orders!.params!.url).toBe('{{env.baseUrl}}/v1/users/{{postLogin.body.user.id}}/orders');
    expect(orders!.params!.headers).toEqual([
      ['authorization', 'Bearer {{postLogin.body.data.token}}'],
      ['x-session', "{{postLogin.headers['x-session']}}"],
    ]);
    expect(envVars).toEqual([
      { key: 'baseUrl', value: 'https://api.test', secret: false },
      { key: 'apiKey', value: 'key-123456', secret: true },
    ]);
    expect(links.length).toBeGreaterThanOrEqual(3);
    expect(validateFlow(flow).issues.filter((i) => i.level === 'error')).toEqual([]);
  });
});

describe('JSON Schema', () => {
  const file = path.resolve(__dirname, '../../../../docs/flows/durbun-flow.schema.json');

  it('docs/flows/durbun-flow.schema.json is up to date (DURBUN_UPDATE_SCHEMA=1 rewrites it)', async () => {
    const text = JSON.stringify(flowJsonSchema(), null, 2) + '\n';
    if (process.env.DURBUN_UPDATE_SCHEMA === '1') {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('has one node schema per catalog type', () => {
    const schema = flowJsonSchema() as { properties: { nodes: { items: { oneOf: { properties: { type: { const: string } } }[] } } } };
    expect(schema.properties.nodes.items.oneOf.map((s) => s.properties.type.const)).toEqual(FLOW_NODE_SPECS.map((s) => s.type));
  });
});
