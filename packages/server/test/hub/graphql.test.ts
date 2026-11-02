import { describe, expect, it } from 'vitest';
import type { WireBody } from '@durbun/protocol';
import { detectGraphql, listOperations, parseGraphqlDocument } from '../../src/hub/graphql';

const json = (value: unknown): WireBody => {
  const data = JSON.stringify(value);
  return { encoding: 'utf8', data, size: Buffer.byteLength(data) };
};

describe('GraphQL document parsing', () => {
  it('finds named queries, mutations and subscriptions', () => {
    expect(parseGraphqlDocument('query GetPetStories($first: Int!) { stories(first: $first) { edges { node { id } } } }')).toEqual({
      operationType: 'query',
      operationName: 'GetPetStories',
    });
    expect(parseGraphqlDocument('mutation LikeStory($id: ID!) { likeStory(storyId: $id) { id likeCount } }')).toEqual({
      operationType: 'mutation',
      operationName: 'LikeStory',
    });
    expect(parseGraphqlDocument('subscription OnMessage { messageAdded { id text } }')).toEqual({
      operationType: 'subscription',
      operationName: 'OnMessage',
    });
  });

  it('handles anonymous and shorthand operations', () => {
    expect(parseGraphqlDocument('{ me { id unreadCount } }')).toEqual({ operationType: 'query' });
    expect(parseGraphqlDocument('query { me { id } }')).toEqual({ operationType: 'query' });
    expect(parseGraphqlDocument('mutation($id: ID!) { archive(id: $id) }')).toEqual({ operationType: 'mutation' });
  });

  it('skips fragments, comments, strings and directives', () => {
    const doc = `
      # fragments first, then the operation
      fragment PetFields on Pet { id name breed }
      fragment Owner on User { id displayName }
      query PetDetail($petId: ID!, $withOwner: Boolean = true) @cached(ttl: 60) {
        pet(id: $petId, note: "query mutation { not an op }") { ...PetFields owner @include(if: $withOwner) { ...Owner } }
      }
    `;
    expect(parseGraphqlDocument(doc)).toEqual({ operationType: 'query', operationName: 'PetDetail' });
    expect(listOperations('"""block query Fake { x }""" query Real { y }')).toEqual([{ type: 'query', name: 'Real' }]);
  });

  it('selects the operation named by operationName among several', () => {
    const doc = 'query A { a } mutation B { b } query C { c }';
    expect(parseGraphqlDocument(doc, 'B')).toEqual({ operationType: 'mutation', operationName: 'B' });
    expect(parseGraphqlDocument(doc)).toEqual({ operationType: 'query', operationName: 'A' });
    expect(parseGraphqlDocument(doc, 'Missing')).toEqual({ operationName: 'Missing' });
  });

  it('returns undefined for text that is not GraphQL', () => {
    expect(parseGraphqlDocument('golden retriever')).toBeUndefined();
    expect(parseGraphqlDocument('')).toBeUndefined();
  });
});

describe('detectGraphql', () => {
  const url = 'https://gql.pati.app/graphql';

  it('detects JSON POST bodies', () => {
    const body = json({
      operationName: 'GetPetStories',
      query: 'query GetPetStories($first: Int!, $after: String) { stories(first: $first, after: $after) { pageInfo { endCursor } } }',
      variables: { first: 10 },
    });
    expect(detectGraphql('POST', url, 'application/json', body)).toEqual({ operationType: 'query', operationName: 'GetPetStories' });
  });

  it('detects batched operations (first one wins) and persisted queries', () => {
    const batch = json([
      { query: 'mutation LikeStory($id: ID!) { likeStory(storyId: $id) { id } }', variables: { id: 's1' } },
      { query: 'query Feed { feed { id } }' },
    ]);
    expect(detectGraphql('POST', url, 'application/json', batch)).toEqual({ operationType: 'mutation', operationName: 'LikeStory' });
    const persisted = json({
      operationName: 'GetPet',
      variables: { id: 42 },
      extensions: { persistedQuery: { version: 1, sha256Hash: 'ecf4edb46db40b5132295c0291d62fb65d6759a9eedfa4d5d612dd5ec54a6b38' } },
    });
    expect(detectGraphql('POST', url, 'application/json', persisted)).toEqual({ operationName: 'GetPet' });
  });

  it('detects application/graphql bodies and GET query parameters', () => {
    const raw: WireBody = { encoding: 'utf8', data: 'query Me { me { id } }', size: 22 };
    expect(detectGraphql('POST', url, 'application/graphql', raw)).toEqual({ operationType: 'query', operationName: 'Me' });
    const getUrl = `${url}?query=${encodeURIComponent('query Notifications { notifications { id } }')}&operationName=Notifications`;
    expect(detectGraphql('GET', getUrl, undefined, undefined)).toEqual({ operationType: 'query', operationName: 'Notifications' });
  });

  it('falls back to a regex scan for truncated JSON bodies', () => {
    const full = JSON.stringify({
      operationName: 'UploadPetPhoto',
      query: 'mutation UploadPetPhoto($file: Upload!) { upload(file: $file) { url } }',
      variables: { file: 'x'.repeat(5000) },
    });
    const body: WireBody = { encoding: 'utf8', data: full.slice(0, 300), size: full.length, truncated: true };
    expect(detectGraphql('POST', url, 'application/json', body)).toEqual({ operationType: 'mutation', operationName: 'UploadPetPhoto' });
  });

  it('decodes base64 text bodies and ignores REST payloads', () => {
    const data = Buffer.from(JSON.stringify({ query: '{ me { id } }' })).toString('base64');
    expect(detectGraphql('POST', url, 'application/json; charset=utf-8', { encoding: 'base64', data, size: 24 })).toEqual({
      operationType: 'query',
    });
    expect(detectGraphql('POST', 'https://api.pati.app/v1/search', 'application/json', json({ query: 'golden retriever', page: 1 }))).toBeUndefined();
    expect(detectGraphql('POST', 'https://es.local/_search', 'application/json', json({ query: { match: { name: 'x' } } }))).toBeUndefined();
    expect(detectGraphql('GET', 'https://api.pati.app/v1/search?query=kedi', undefined, undefined)).toBeUndefined();
    expect(detectGraphql('POST', url, 'image/png', { encoding: 'base64', data: 'iVBORw0KGgo=', size: 8 })).toBeUndefined();
  });
});
