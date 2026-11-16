/**
 * GraphQL operation detection for captured requests: JSON bodies (`{ query, operationName }`, batched
 * arrays, persisted queries), `application/graphql` bodies and GET requests with a `query` parameter.
 */
import type { GraphqlOperationType, WireBody } from '@durbun/protocol';
import { graphqlDocumentOperations, isTextContentType } from '@durbun/protocol';

export type { GraphqlOperationType };

export interface GraphqlInfo {
  operationName?: string;
  operationType?: GraphqlOperationType;
}

interface OperationDef {
  type: GraphqlOperationType;
  name?: string;
}

/** Bodies larger than this are only scanned with regexes (never JSON-parsed) to keep ingestion cheap. */
const MAX_PARSE_CHARS = 512 * 1024;

/** Lists the operation definitions of a GraphQL document (fragments and SDL are skipped): the protocol's scanner. */
export function listOperations(doc: string): OperationDef[] {
  return graphqlDocumentOperations(doc);
}

/** Operation type/name of a GraphQL document; `operationName` selects among several operations. */
export function parseGraphqlDocument(doc: string, operationName?: string): GraphqlInfo | undefined {
  const ops = listOperations(doc);
  if (ops.length === 0) return operationName ? { operationName } : undefined;
  if (operationName) {
    const op = ops.find((o) => o.name === operationName) ?? (ops.length === 1 ? ops[0] : undefined);
    return op ? { operationName, operationType: op.type } : { operationName };
  }
  const first = ops[0]!;
  return first.name ? { operationName: first.name, operationType: first.type } : { operationType: first.type };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fromJsonPayload(value: unknown): GraphqlInfo | undefined {
  const op = Array.isArray(value) ? value[0] : value;
  if (!isRecord(op)) return undefined;
  const operationName = typeof op.operationName === 'string' && op.operationName ? op.operationName : undefined;
  if (typeof op.query === 'string') {
    const parsed = parseGraphqlDocument(op.query, operationName);
    if (parsed) return parsed;
    return operationName ? { operationName } : undefined;
  }
  // Automatic persisted queries: only a hash + operationName travel.
  if (operationName && isRecord(op.extensions) && isRecord(op.extensions.persistedQuery)) return { operationName };
  return undefined;
}

/** Truncated or huge JSON bodies: regex scan of the beginning of the text. */
function fromJsonText(text: string): GraphqlInfo | undefined {
  const head = text.slice(0, 64 * 1024);
  const nameMatch = /"operationName"\s*:\s*"([_A-Za-z][_0-9A-Za-z]*)"/.exec(head);
  const queryMatch = /"query"\s*:\s*"((?:[^"\\]|\\.){0,4096})/.exec(head);
  const operationName = nameMatch?.[1];
  if (queryMatch) {
    let query = queryMatch[1]!;
    try {
      query = JSON.parse(`"${query.replace(/\\$/, '')}"`) as string;
    } catch {
      query = query.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
    const parsed = parseGraphqlDocument(query, operationName);
    if (parsed) return parsed;
  }
  return operationName && /"(query|extensions)"\s*:/.test(head) ? { operationName } : undefined;
}

export function bodyText(body: WireBody | undefined, contentType: string | undefined, maxChars: number): string | undefined {
  if (!body || typeof body.data !== 'string' || body.data.length === 0) return undefined;
  if (body.encoding === 'utf8') return body.data.length > maxChars ? body.data.slice(0, maxChars) : body.data;
  if (!isTextContentType(contentType)) return undefined;
  try {
    const raw = body.data.length > maxChars * 2 ? body.data.slice(0, maxChars * 2 - ((maxChars * 2) % 4)) : body.data;
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

/** Detects a GraphQL operation in a captured request. */
export function detectGraphql(
  method: string,
  url: string,
  contentType: string | undefined,
  body: WireBody | undefined,
): GraphqlInfo | undefined {
  const ct = (contentType ?? '').toLowerCase();
  const text = bodyText(body, contentType, MAX_PARSE_CHARS * 2);
  if (text) {
    if (ct.includes('application/graphql') && !ct.includes('json')) return parseGraphqlDocument(text);
    const trimmed = text.trimStart();
    const first = trimmed[0];
    if ((first === '{' || first === '[') && (trimmed.includes('"query"') || trimmed.includes('"operationName"'))) {
      if (!body?.truncated && trimmed.length <= MAX_PARSE_CHARS) {
        try {
          return fromJsonPayload(JSON.parse(trimmed));
        } catch {
          // fall through to the regex scan (malformed JSON)
        }
      }
      return fromJsonText(trimmed);
    }
  }
  if (method.toUpperCase() === 'GET' && url.includes('query=')) {
    try {
      const params = new URL(url).searchParams;
      const query = params.get('query');
      const operationName = params.get('operationName') ?? undefined;
      if (query) return parseGraphqlDocument(query, operationName);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
