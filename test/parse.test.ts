import { describe, test, expect } from 'bun:test'
import { parseGraphQLBody } from '../src/parse'

describe('parseGraphQLBody', () => {
  test('detects named query', () => {
    const body = JSON.stringify({ query: 'query GetUser { user { name } }' })
    const result = parseGraphQLBody(body)
    expect(result).toEqual({ type: 'query', name: 'GetUser' })
  })

  test('detects named mutation', () => {
    const body = JSON.stringify({
      query: 'mutation CreateUser($input: CreateUserInput!) { createUser(input: $input) { id } }',
    })
    const result = parseGraphQLBody(body)
    expect(result).toEqual({ type: 'mutation', name: 'CreateUser' })
  })

  test('detects named subscription', () => {
    const body = JSON.stringify({ query: 'subscription OnMessage { messageAdded { text } }' })
    const result = parseGraphQLBody(body)
    expect(result).toEqual({ type: 'subscription', name: 'OnMessage' })
  })

  test('detects anonymous query (shorthand { ... })', () => {
    const body = JSON.stringify({ query: '{ user { name } }' })
    const result = parseGraphQLBody(body)
    expect(result).toEqual({ type: 'query', name: undefined })
  })

  test('detects unnamed explicit query', () => {
    const body = JSON.stringify({ query: 'query { user { name } }' })
    const result = parseGraphQLBody(body)
    expect(result).toEqual({ type: 'query', name: undefined })
  })

  test('handles query with variables', () => {
    const body = JSON.stringify({
      query: 'query GetUser($id: ID!) { user(id: $id) { name email } }',
      variables: { id: '123' },
    })
    const result = parseGraphQLBody(body)
    expect(result).toEqual({ type: 'query', name: 'GetUser' })
  })

  test('handles mutation with variables', () => {
    const body = JSON.stringify({
      query: `mutation UpdateUser($id: ID!, $name: String!) {
        updateUser(id: $id, name: $name) {
          id
          name
        }
      }`,
      variables: { id: '123', name: 'Alice' },
    })
    const result = parseGraphQLBody(body)
    expect(result).toEqual({ type: 'mutation', name: 'UpdateUser' })
  })

  test('handles document with fragments — returns first operation', () => {
    const body = JSON.stringify({
      query: `
        query GetUser {
          user {
            ...UserFields
          }
        }
        fragment UserFields on User {
          name
          email
        }
      `,
    })
    const result = parseGraphQLBody(body)
    expect(result).toEqual({ type: 'query', name: 'GetUser' })
  })

  test('handles document with comments', () => {
    const body = JSON.stringify({
      query: `
        # This deletes a user
        mutation DeleteUser($id: ID!) {
          deleteUser(id: $id)
        }
      `,
    })
    const result = parseGraphQLBody(body)
    expect(result).toEqual({ type: 'mutation', name: 'DeleteUser' })
  })

  test('handles multiline query', () => {
    const body = JSON.stringify({
      query: `
        query ListUsers(
          $first: Int
          $after: String
        ) {
          users(first: $first, after: $after) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      `,
    })
    const result = parseGraphQLBody(body)
    expect(result).toEqual({ type: 'query', name: 'ListUsers' })
  })

  test('returns undefined for invalid JSON', () => {
    expect(parseGraphQLBody('not json')).toBeUndefined()
  })

  test('returns undefined for missing query field', () => {
    const body = JSON.stringify({ variables: {} })
    expect(parseGraphQLBody(body)).toBeUndefined()
  })

  test('returns undefined for empty query string', () => {
    const body = JSON.stringify({ query: '' })
    expect(parseGraphQLBody(body)).toBeUndefined()
  })

  test('returns undefined for non-string query field', () => {
    const body = JSON.stringify({ query: 42 })
    expect(parseGraphQLBody(body)).toBeUndefined()
  })

  test('returns undefined for invalid GraphQL syntax', () => {
    const body = JSON.stringify({ query: 'this is not graphql }{}{' })
    expect(parseGraphQLBody(body)).toBeUndefined()
  })

  test('returns undefined for empty body', () => {
    expect(parseGraphQLBody('')).toBeUndefined()
  })

  test('returns undefined for fragment-only document (no operation)', () => {
    const body = JSON.stringify({
      query: 'fragment UserFields on User { name email }',
    })
    expect(parseGraphQLBody(body)).toBeUndefined()
  })

  test('handles introspection query', () => {
    const body = JSON.stringify({
      query: `query IntrospectionQuery {
        __schema {
          queryType { name }
          mutationType { name }
          types { name kind }
        }
      }`,
    })
    const result = parseGraphQLBody(body)
    expect(result).toEqual({ type: 'query', name: 'IntrospectionQuery' })
  })
})
