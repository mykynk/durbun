/**
 * JSON Schema (draft 2020-12) of a flow document, generated from the node catalog. Published as
 * docs/flows/durbun-flow.schema.json (a test keeps that file in sync) and handed to AIs in the AI pack.
 */
import { FLOW_NODE_SPECS, type FlowParamSpec } from './catalog';
import { FLOW_CONDITION_OPS } from './expr';
import { RESERVED_ROOTS } from './template';
import { FLOW_FORMAT, FLOW_VERSION } from './types';
import { FLOW_STATUS_PARAMS, UNSAFE_NAMES } from './validate';

type Schema = Record<string, unknown>;

const RIGHT_DESCRIPTION =
  "Template or literal; required except for exists, notExists, isEmpty, isNotEmpty, isTrue and isFalse. For `in`: a comma-separated list ('a, b') or a JSON list (['a', 'b']).";

const TEMPLATE_STRING: Schema = { type: 'string', pattern: '\\{\\{' };
const NO_TEMPLATE: Schema = { not: { pattern: '\\{\\{' } };
const STATUS_PART = '(\\d[xX]{2}|\\d{3}(\\s*-\\s*\\d{3})?)';
/** '' (any), '2xx', '200', '200,201', '200-299' — or a template. */
const STATUS_PATTERN = `^\\s*$|^\\s*${STATUS_PART}(\\s*,\\s*${STATUS_PART})*\\s*$`;

function paramSchema(p: FlowParamSpec, type: string): Schema {
  let s: Schema;
  switch (p.kind) {
    case 'text':
    case 'longText':
    case 'flowRef':
      s = { type: 'string' };
      if (FLOW_STATUS_PARAMS[type]?.includes(p.name)) s.pattern = p.fixed ? STATUS_PATTERN : `${STATUS_PATTERN}|\\{\\{`;
      if (p.fixed) Object.assign(s, NO_TEMPLATE);
      break;
    case 'number': {
      const n: Schema = { type: 'number' };
      if (p.min !== undefined) n.minimum = p.min;
      if (p.max !== undefined) n.maximum = p.max;
      s = p.fixed ? n : { anyOf: [n, TEMPLATE_STRING] };
      break;
    }
    case 'boolean':
      s = { type: 'boolean' };
      break;
    case 'select':
      s = { enum: p.options?.map((o) => o.value) ?? [] };
      break;
    case 'keyValue':
      s = { $ref: '#/$defs/keyValue' };
      break;
    case 'json':
      s = {};
      break;
    case 'conditions':
      s = { type: 'array', items: { $ref: '#/$defs/condition' } };
      break;
    case 'assertions':
      s = { type: 'array', items: { $ref: '#/$defs/assertion' } };
      break;
    case 'extracts':
      s = { type: 'array', items: { $ref: '#/$defs/extract' } };
      break;
    case 'assignments':
      s = { type: 'array', items: { $ref: '#/$defs/assignment' } };
      break;
    case 'mapping':
      s = { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } };
      break;
    default:
      s = {};
  }
  s.description = p.description;
  if (p.default !== undefined) s.default = p.default;
  if (p.example !== undefined) s.examples = [p.example];
  return s;
}

export function flowJsonSchema(): Schema {
  const nodeSchemas = FLOW_NODE_SPECS.map((spec) => {
    const params: Schema = {
      type: 'object',
      properties: Object.fromEntries(spec.params.map((p) => [p.name, paramSchema(p, spec.type)])),
      additionalProperties: false,
    };
    // Required lists (rules, assertions, assignments) stay required although their default is empty.
    const required = spec.params
      .filter((p) => p.required && (p.default === undefined || p.default === '' || (Array.isArray(p.default) && p.default.length === 0)))
      .map((p) => p.name);
    if (required.length) params.required = required;
    return {
      title: spec.title,
      description: spec.description,
      type: 'object',
      required: ['id', 'type'],
      properties: {
        id: { $ref: '#/$defs/nodeId' },
        type: { const: spec.type },
        label: { type: 'string', maxLength: 200 },
        params,
        position: { $ref: '#/$defs/position' },
        disabled: { type: 'boolean' },
        continueOnError: { type: 'boolean' },
        retry: { $ref: '#/$defs/retry' },
        timeoutMs: { type: 'integer', minimum: 100 },
        note: { type: 'string' },
      },
      additionalProperties: false,
    };
  });
  const ports = ['out', 'true', 'false', 'loop', 'done', 'error'];
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/mykynk/durbun/blob/main/docs/flows/durbun-flow.schema.json',
    title: 'Dürbün flow',
    description: 'A Dürbün flow: nodes (steps) connected by edges, run by the Dürbün Mac app against a device and an app.',
    type: 'object',
    required: ['format', 'version', 'id', 'name', 'nodes', 'edges'],
    properties: {
      format: { const: FLOW_FORMAT },
      version: { const: FLOW_VERSION },
      id: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$', description: 'File-safe id, unique among the flows' },
      name: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      inputs: {
        type: 'array',
        description: 'Values asked for when the flow starts or passed by a calling flow; read as {{input.<name>}}',
        items: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { $ref: '#/$defs/varName' },
            description: { type: 'string' },
            default: { type: ['string', 'number', 'boolean'] },
            required: { type: 'boolean' },
            secret: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      outputs: {
        type: 'array',
        description: 'Values a calling flow reads as {{<call node id>.outputs.<name>}}',
        items: {
          type: 'object',
          required: ['name', 'value'],
          properties: { name: { $ref: '#/$defs/varName' }, value: { type: 'string' }, description: { type: 'string' } },
          additionalProperties: false,
        },
      },
      target: {
        type: 'object',
        properties: { platform: { enum: ['android', 'ios', 'any'] }, appId: { type: 'string', description: 'Bundle id / package name of the app under test' } },
        additionalProperties: false,
      },
      settings: {
        type: 'object',
        properties: {
          onUnsupported: { enum: ['skip', 'fail'] },
          timeoutMs: { type: 'integer', minimum: 1000 },
          recordRequests: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      automation: {
        type: 'object',
        required: ['enabled'],
        properties: { enabled: { type: 'boolean' }, throttleMs: { type: 'integer', minimum: 1000 } },
        additionalProperties: false,
      },
      nodes: { type: 'array', minItems: 1, items: { oneOf: nodeSchemas } },
      edges: {
        type: 'array',
        items: {
          type: 'object',
          required: ['from', 'to'],
          properties: {
            from: { $ref: '#/$defs/nodeId' },
            port: { enum: ports, default: 'out', description: 'out (most nodes), true/false (logic.condition), loop/done (logic.repeat), error (every node with input except flow.end)' },
            to: { $ref: '#/$defs/nodeId' },
          },
          additionalProperties: false,
        },
      },
      createdAt: { type: 'number' },
      updatedAt: { type: 'number' },
    },
    additionalProperties: false,
    $defs: {
      nodeId: {
        type: 'string',
        pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$',
        not: { enum: [...RESERVED_ROOTS, ...UNSAFE_NAMES] },
        description: 'Unique node id; templates read its output as {{<id>.<field>}}',
      },
      varName: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$', not: { enum: [...UNSAFE_NAMES] } },
      position: { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } }, additionalProperties: false },
      retry: { type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 0, maximum: 100 }, delayMs: { type: 'integer', minimum: 0 } }, additionalProperties: false },
      keyValue: { type: 'array', items: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'string' }], minItems: 2, maxItems: 2 } },
      condition: {
        type: 'object',
        required: ['left', 'op'],
        properties: { left: { type: 'string' }, op: { enum: FLOW_CONDITION_OPS.map((o) => o.op) }, right: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: ['string', 'number', 'boolean'] } }], description: RIGHT_DESCRIPTION } },
        additionalProperties: false,
      },
      assertion: {
        type: 'object',
        required: ['left', 'op'],
        properties: { left: { type: 'string' }, op: { enum: FLOW_CONDITION_OPS.map((o) => o.op) }, right: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: ['string', 'number', 'boolean'] } }], description: RIGHT_DESCRIPTION }, message: { type: 'string' } },
        additionalProperties: false,
      },
      extract: {
        type: 'object',
        required: ['name', 'from'],
        properties: {
          name: { $ref: '#/$defs/varName' },
          from: { enum: ['body', 'header', 'status', 'bodyText'] },
          path: { type: 'string', description: 'JSON path for body (items[0].id), header name for header' },
          regex: { type: 'string' },
        },
        additionalProperties: false,
      },
      assignment: {
        type: 'object',
        required: ['name', 'value'],
        properties: { name: { $ref: '#/$defs/varName' }, value: { type: 'string' } },
        additionalProperties: false,
      },
    },
  };
}
