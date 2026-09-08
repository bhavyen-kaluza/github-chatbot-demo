// Talking to GitHub's API with a user token, and turning what goes wrong into
// the five codes the chatbot's instructions know how to explain.
//
//   SERVICE_UNAVAILABLE  GitHub is not connected (no token)
//   UNAUTHENTICATED      the token expired or was revoked: reconnect fixes it
//   FORBIDDEN            the repository is not visible: no access, or the app
//                        is not installed where it lives. GitHub reports both
//                        as "not found", so we never claim a repo does not exist
//   TOO_MANY_REQUESTS    rate limited: wait, do not reconnect
//   BAD_GATEWAY          GitHub could not be reached or answered nonsense
import { apiBase, USER_AGENT } from './github-auth.mjs'

export class GitHubError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'GitHubError'
    this.code = code
    this.details = details
  }
}

export function notVisible(repo) {
  return new GitHubError('FORBIDDEN',
    `${repo} is not visible to you: either you lack access in GitHub or the Cortex GitHub App is not installed where it lives. GitHub reports both as "not found".`)
}

function codeForStatus(status, bodyText) {
  if (status === 401) return 'UNAUTHENTICATED'
  if (status === 429 || (status === 403 && /rate limit/i.test(bodyText))) return 'TOO_MANY_REQUESTS'
  if (status === 403 || status === 404) return 'FORBIDDEN'
  return 'BAD_GATEWAY'
}

function codeForGraphQLErrors(errors) {
  const types = new Set(errors.map(e => e.type).filter(Boolean))
  if (types.has('RATE_LIMITED')) return 'TOO_MANY_REQUESTS'
  if (types.has('FORBIDDEN') || types.has('INSUFFICIENT_SCOPES') || types.has('NOT_FOUND')) return 'FORBIDDEN'
  return 'BAD_GATEWAY'
}

function headers(accessToken, extra) {
  return { Authorization: `Bearer ${accessToken}`, 'User-Agent': USER_AGENT, ...extra }
}

/**
 * One GraphQL query. Returns `{ data, errors, rateLimit }`. A response with
 * partial errors next to data is returned as-is: that is how GitHub marks a
 * field the token may not read, and each tool decides what it means.
 */
export async function githubGraphQL(accessToken, operationName, query, variables) {
  let res
  try {
    res = await fetch(`${apiBase()}/graphql`, {
      method: 'POST',
      headers: headers(accessToken, { Accept: 'application/json', 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query, variables, operationName }),
    })
  } catch (err) {
    throw new GitHubError('BAD_GATEWAY', `GitHub could not be reached: ${err.message}`)
  }
  const text = await res.text()
  if (!res.ok) throw new GitHubError(codeForStatus(res.status, text), `GitHub GraphQL answered HTTP ${res.status}`, { status: res.status })
  let body
  try { body = JSON.parse(text) } catch { throw new GitHubError('BAD_GATEWAY', 'GitHub GraphQL returned a body that is not JSON') }
  const errors = Array.isArray(body.errors) ? body.errors : []
  if (!body.data) {
    throw new GitHubError(codeForGraphQLErrors(errors), errors[0]?.message || 'GitHub GraphQL returned no data', {
      errorTypes: errors.map(e => e.type),
    })
  }
  return { data: body.data, errors, rateLimit: body.data.rateLimit ?? null }
}

/** One REST GET. Used only for the installations endpoints, which have no GraphQL equivalent. */
export async function githubRest(accessToken, path) {
  let res
  try {
    res = await fetch(`${apiBase()}${path}`, {
      headers: headers(accessToken, { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }),
    })
  } catch (err) {
    throw new GitHubError('BAD_GATEWAY', `GitHub could not be reached: ${err.message}`)
  }
  const text = await res.text()
  if (!res.ok) throw new GitHubError(codeForStatus(res.status, text), `GitHub answered HTTP ${res.status} for ${path}`, { status: res.status })
  try { return JSON.parse(text) } catch { throw new GitHubError('BAD_GATEWAY', `GitHub returned a body that is not JSON for ${path}`) }
}
