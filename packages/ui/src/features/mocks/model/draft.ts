import { GRAPHQL_NAME_RE, type MockAction, type MockGraphqlCondition, type NetworkDetail, type NetworkEntry } from '@durbun/protocol';
import type { MockRuleDraft } from '../../../data';
import type { FailError } from './rules';

/**
 * "Mock oluştur" from a captured request: method + exact URL, the response status, its content-type
 * and body (text or base64). Failed requests become a "fail" rule with the same kind of error. A GraphQL request
 * with a named operation gets that operation as a condition (`when.graphql`), so the rule answers only it; a GET
 * one matches its address without the query string (the variables travel there).
 */

export type DraftNote = 'bodyNotCaptured' | 'bodyTruncated' | 'bodyEvicted' | 'graphqlSharedUrl' | 'noResponse' | 'detailUnavailable';

export function guessFailKind(error: string | undefined): FailError {
  const e = (error ?? '').toLowerCase();
  if (!e) return 'connection';
  if (/time ?out|timed out|zaman aşımı/.test(e)) return 'timeout';
  if (/host lookup|dns|enotfound|nodename|unknownhost|name not resolved|eai_again/.test(e)) return 'dns';
  if (/handshake|certificate|ssl|tls/.test(e)) return 'tls';
  if (/refused|reset|unreachable|socket|connection|network is down|offline/.test(e)) return 'connection';
  return 'custom';
}

function shortName(entry: NetworkEntry): string {
  if (entry.graphql?.operationName) return `${entry.graphql.operationType ?? 'query'} ${entry.graphql.operationName}`;
  const path = entry.path || entry.url;
  const name = `${entry.method === '?' ? '' : `${entry.method} `}${path.split('?')[0]}`;
  return name.length > 80 ? `${name.slice(0, 79)}…` : name;
}

export function draftFromRequest(
  entry: NetworkEntry,
  detail: NetworkDetail | null | undefined,
  bundleId?: string,
): { draft: MockRuleDraft; notes: DraftNote[] } {
  const notes: DraftNote[] = [];
  const operation = entry.graphql?.operationName && GRAPHQL_NAME_RE.test(entry.graphql.operationName) ? entry.graphql.operationName : undefined;
  // An anonymous operation cannot be told apart from the others at that URL.
  if (entry.graphql && !operation) notes.push('graphqlSharedUrl');
  let action: MockAction;
  if (typeof entry.status === 'number' && entry.status >= 100 && entry.status <= 599) {
    action = { type: 'respond', status: entry.status };
    const ct = entry.responseContentType;
    if (ct) action.headers = [['content-type', ct]];
    const body = detail?.responseBody;
    if (!detail) {
      if (entry.hasResponseBody) notes.push(entry.bodyEvicted ? 'bodyEvicted' : 'detailUnavailable');
    } else if (body && body.data === '' && body.truncated && body.size > 0) {
      notes.push('bodyNotCaptured');
    } else if (body && body.data !== '') {
      action.body = body.data;
      action.bodyEncoding = body.encoding === 'base64' ? 'base64' : 'utf8';
      if (body.truncated) notes.push('bodyTruncated');
    } else if (entry.hasResponseBody) {
      notes.push(entry.bodyEvicted ? 'bodyEvicted' : 'bodyNotCaptured');
    }
  } else if (entry.state === 'failed' || entry.state === 'cancelled') {
    const kind = guessFailKind(entry.error);
    action = { type: 'fail', error: kind };
    if (entry.error && kind === 'custom') action.message = entry.error.slice(0, 2000);
  } else {
    notes.push('noResponse');
    action = { type: 'respond', status: 200, headers: [['content-type', 'application/json; charset=utf-8']], body: '{}', bodyEncoding: 'utf8' };
  }
  const method = entry.method && entry.method !== '?' ? entry.method.toUpperCase() : '*';
  const draft: MockRuleDraft = { enabled: true, name: shortName(entry), method, url: entry.url, match: 'exact', action };
  if (operation) {
    const graphql: MockGraphqlCondition = { operationName: operation };
    if (entry.graphql?.operationType) graphql.operationType = entry.graphql.operationType;
    draft.when = { graphql };
    const q = entry.url.indexOf('?');
    if (method === 'GET' && q > 0) {
      draft.url = entry.url.slice(0, q);
      draft.match = 'contains';
    }
  }
  if (bundleId) draft.apps = [bundleId];
  return { draft, notes };
}
