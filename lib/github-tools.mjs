// The six tools the chatbot can call. Same names, inputs and result shapes as
// the six MCP tools in Cortex, so a question that works here works there.
//
// Five tools are one GitHub GraphQL query each (one rate-limit point a call).
// SearchGitHubRepositories is the exception: it uses the REST "installations"
// endpoints, because they are GitHub's exact statement of which repositories
// the app can reach for this user, and GraphQL has no equivalent.
import { githubGraphQL, githubRest, GitHubError, notVisible } from './github-api.mjs'

export const MAX_FILE_TEXT_BYTES = 100 * 1024
export const DEFAULT_WINDOW_DAYS = 14
export const MAX_WINDOW_DAYS = 90
export const DEFAULT_PULL_REQUESTS = 20
export const MAX_PULL_REQUESTS = 50
const INSTALLATION_REPO_PAGES = 5

// ── the GraphQL queries ─────────────────────────────────────────────────────
// Every field here was accepted by api.github.com/graphql with a Cortex GitHub
// App user token against three private repositories (September 2026).
// Never add author { email } or author { name }: identity is the GitHub login or nothing.

const RATE = 'rateLimit { cost remaining }'

const PULL_REQUEST_FIELDS = `
        number
        title
        url
        state
        isDraft
        createdAt
        updatedAt
        mergedAt
        author { login __typename }
        labels(first: 10) { nodes { name } }
        reviewDecision
        reviews(first: 10) { nodes { state author { login } } }
        comments { totalCount }
        additions
        deletions
        changedFiles
        baseRefName
        headRefName
        mergeable
        files(first: 20) { nodes { path additions deletions changeType } }`

const REPOSITORY_OVERVIEW = `query RepositoryOverview($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    owner { login }
    name
    url
    description
    isPrivate
    isArchived
    isFork
    createdAt
    pushedAt
    diskUsage
    licenseInfo { spdxId }
    repositoryTopics(first: 20) { nodes { topic { name } } }
    languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
      totalSize
      edges { size node { name } }
    }
    defaultBranchRef { name }
    readme: object(expression: "HEAD:README.md") { ... on Blob { byteSize isBinary isTruncated text } }
    readmeLower: object(expression: "HEAD:readme.md") { ... on Blob { byteSize isBinary isTruncated text } }
    root: object(expression: "HEAD:") { ... on Tree { entries { name type path } } }
    branches: refs(refPrefix: "refs/heads/", first: 1) { totalCount }
    tags: refs(refPrefix: "refs/tags/", first: 1) { totalCount }
    releases(first: 1) { totalCount }
    openPullRequests: pullRequests(states: OPEN, first: 1) { totalCount }
  }
  ${RATE}
}`

const FILE_AT_PATH = `query FileAtPath($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) {
    url
    defaultBranchRef { name }
    object(expression: $expression) {
      __typename
      ... on Blob { byteSize isBinary isTruncated text }
    }
  }
  ${RATE}
}`

const DIRECTORY_AT_PATH = `query DirectoryAtPath($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    object(expression: $expression) {
      __typename
      ... on Tree { entries { name type path } }
    }
  }
  ${RATE}
}`

const RECENT_CHANGES = `query RecentChanges($owner: String!, $name: String!, $since: GitTimestamp!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      name
      target {
        ... on Commit {
          history(first: 50, since: $since) {
            totalCount
            nodes {
              abbreviatedOid
              url
              messageHeadline
              committedDate
              additions
              deletions
              changedFilesIfAvailable
              author { user { login } }
              associatedPullRequests(first: 1) { nodes { number } }
            }
          }
        }
      }
    }
    pullRequests(first: 20, states: MERGED, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {${PULL_REQUEST_FIELDS}
      }
    }
  }
  ${RATE}
}`

const PULL_REQUESTS = `query PullRequests($owner: String!, $name: String!, $states: [PullRequestState!]!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, states: $states, orderBy: { field: CREATED_AT, direction: DESC }) {
      totalCount
      nodes {${PULL_REQUEST_FIELDS}
      }
    }
  }
  ${RATE}
}`

// ── what the model sees ─────────────────────────────────────────────────────

const coordinates = {
  owner: { type: 'string', description: 'Repository owner, e.g. "bhavyen-kaluza". Use SearchGitHubRepositories first if the user named the repo loosely.' },
  name: { type: 'string', description: 'Repository name, e.g. "fastify-clone".' },
}

export const TOOL_DEFINITIONS = [
  {
    name: 'SearchGitHubRepositories',
    description: 'List the GitHub repositories this user can reach through the Cortex GitHub App: the intersection of what they can read and where the app is installed. Optionally filter by owner or by a fragment of the name. Use it first when a repository is named loosely ("the fastify one"), and to answer "which repos can I see?". An empty list means the app is not installed anywhere the user can see, usually because an organisation has not installed it yet.',
    input_schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Only repositories owned by this user or organisation.' },
        nameContains: { type: 'string', description: 'Only repositories whose name contains this text (case-insensitive).' },
      },
    },
  },
  {
    name: 'GetGitHubRepository',
    description: 'Overview of one repository: description, languages by share, default branch, topics, licence, README text (up to 100 KB), the top-level folders and files, and counts of branches, tags, releases and open pull requests. Answers "what is this repo?" and "how is it laid out?".',
    input_schema: { type: 'object', properties: coordinates, required: ['owner', 'name'] },
  },
  {
    name: 'GetGitHubFile',
    description: 'Read one file at a path, from the default branch unless a ref (branch, tag or commit) is given. Returns the text (capped at 100 KB), size, whether it is binary, and a link. Returns null when nothing is at that path, or the path is a folder. Read a file before saying what it contains.',
    input_schema: {
      type: 'object',
      properties: {
        ...coordinates,
        path: { type: 'string', description: 'File path from the repository root, e.g. "docs/adr/0001.md". No leading slash.' },
        ref: { type: 'string', description: 'Branch, tag or commit. Default: the default branch.' },
      },
      required: ['owner', 'name', 'path'],
    },
  },
  {
    name: 'ListGitHubDirectory',
    description: 'List one folder: the names, paths and types (FILE, DIRECTORY, SUBMODULE) of its entries. Empty path lists the repository root. Walk a few levels at most.',
    input_schema: {
      type: 'object',
      properties: {
        ...coordinates,
        path: { type: 'string', description: 'Folder path from the repository root, e.g. "docs". Empty or omitted for the root.' },
        ref: { type: 'string', description: 'Branch, tag or commit. Default: the default branch.' },
      },
      required: ['owner', 'name'],
    },
  },
  {
    name: 'GetGitHubRecentChanges',
    description: 'What changed on the default branch since a date: up to 50 commits (headline, author login, additions, deletions, linked PR number) and the pull requests merged in that window. Default window is the last 14 days; windows longer than 90 days are clamped. Authors marked BOT are automated (Dependabot, Actions); leave them out when describing what people did and say how many you excluded.',
    input_schema: {
      type: 'object',
      properties: {
        ...coordinates,
        since: { type: 'string', description: 'ISO date or timestamp, e.g. "2026-08-01". Default: 14 days ago.' },
      },
      required: ['owner', 'name'],
    },
  },
  {
    name: 'GetGitHubPullRequests',
    description: 'Pull requests in one state (OPEN by default; or CLOSED, MERGED), newest first, up to 50. Each carries title, author (with USER/BOT kind), draft flag, labels, review decision, reviews, comment count, size (additions, deletions, changed files), branches, mergeability and up to 20 changed files. Answers "what is open?", "what is waiting for review?", "what did PR #12 change?".',
    input_schema: {
      type: 'object',
      properties: {
        ...coordinates,
        state: { type: 'string', enum: ['OPEN', 'CLOSED', 'MERGED'], description: 'Default OPEN.' },
        first: { type: 'integer', minimum: 1, maximum: 50, description: 'How many, default 20.' },
      },
      required: ['owner', 'name'],
    },
  },
]

// ── helpers ported from Cortex's resolvers ──────────────────────────────────

function badInput(message) {
  return new GitHubError('BAD_USER_INPUT', message)
}

function requireCoordinates(input) {
  const owner = typeof input.owner === 'string' ? input.owner.trim() : ''
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) throw badInput('owner and name must each look like a GitHub name, e.g. owner "bhavyen-kaluza", name "fastify-clone"')
  return { owner, name }
}

function validRef(ref) {
  if (ref == null || String(ref).trim() === '') return 'HEAD'
  const value = String(ref).trim()
  if (/[\s:~^?*[\\]/.test(value) || value.includes('..')) throw badInput(`ref "${value}" is not a valid branch, tag or commit`)
  return value
}

function validPath(path, { allowEmpty }) {
  const value = (path == null ? '' : String(path)).trim().replace(/^\/+/, '').replace(/\/+$/, '')
  if (value === '') {
    if (allowEmpty) return ''
    throw badInput('path is required, e.g. "README.md" or "docs/adr/0001.md"')
  }
  if (value.split('/').some(seg => seg === '' || seg === '.' || seg === '..') || value.includes('\0')) throw badInput(`path "${value}" is not a valid repository path`)
  return value
}

function entryType(type) {
  if (type === 'tree') return 'DIRECTORY'
  if (type === 'commit') return 'SUBMODULE'
  return 'FILE'
}

function fileFrom(blob, path, ref, repoUrl) {
  let text = blob.isBinary ? null : blob.text
  let truncated = Boolean(blob.isTruncated)
  if (text != null && Buffer.byteLength(text, 'utf8') > MAX_FILE_TEXT_BYTES) {
    text = Buffer.from(text, 'utf8').subarray(0, MAX_FILE_TEXT_BYTES).toString('utf8')
    truncated = true
  }
  return {
    path,
    ref,
    url: `${repoUrl}/blob/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`,
    byteSize: blob.byteSize,
    isBinary: Boolean(blob.isBinary),
    isTruncated: truncated,
    text,
  }
}

function actorKind(actor) {
  if (!actor) return 'UNKNOWN'
  if (actor.__typename === 'Bot') return 'BOT'
  if (actor.__typename === 'User') return 'USER'
  return 'UNKNOWN'
}

function pullRequestFrom(pr) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt,
    authorLogin: pr.author?.login ?? null,
    authorKind: actorKind(pr.author),
    labels: (pr.labels?.nodes ?? []).map(l => l.name),
    reviewDecision: pr.reviewDecision ?? null,
    reviews: (pr.reviews?.nodes ?? []).map(r => ({ reviewerLogin: r.author?.login ?? null, state: r.state })),
    commentCount: pr.comments?.totalCount ?? null,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    mergeable: pr.mergeable,
    files: (pr.files?.nodes ?? []).map(f => ({ path: f.path, additions: f.additions, deletions: f.deletions, changeType: f.changeType })),
  }
}

/** Default 14 days back; anything older than 90 days is clamped, not refused. */
export function resolveSince(since, now = Date.now()) {
  const floor = now - MAX_WINDOW_DAYS * 86400_000
  if (since == null || String(since).trim() === '') return new Date(now - DEFAULT_WINDOW_DAYS * 86400_000).toISOString()
  const parsed = Date.parse(String(since))
  if (Number.isNaN(parsed)) throw badInput('since must be an ISO date or timestamp, e.g. "2026-08-01"')
  return new Date(Math.max(parsed, floor)).toISOString()
}

// ── the tools ───────────────────────────────────────────────────────────────

async function searchRepositories(token, input) {
  const wantOwner = typeof input.owner === 'string' && input.owner.trim() ? input.owner.trim().toLowerCase() : null
  const wantName = typeof input.nameContains === 'string' && input.nameContains.trim() ? input.nameContains.trim().toLowerCase() : null

  const list = await githubRest(token, '/user/installations?per_page=100')
  const repos = []
  const installations = []
  for (const installation of list.installations ?? []) {
    installations.push({ account: installation.account?.login ?? null, type: installation.target_type ?? null, repositorySelection: installation.repository_selection ?? null })
    if (wantOwner && installation.account?.login?.toLowerCase() !== wantOwner) continue
    for (let page = 1; page <= INSTALLATION_REPO_PAGES; page += 1) {
      const body = await githubRest(token, `/user/installations/${installation.id}/repositories?per_page=100&page=${page}`)
      repos.push(...(body.repositories ?? []))
      if (repos.length >= (body.total_count ?? 0) || (body.repositories ?? []).length < 100) break
    }
  }

  const repositories = repos
    .filter(r => !wantName || r.name.toLowerCase().includes(wantName))
    .sort((a, b) => (b.pushed_at ?? '').localeCompare(a.pushed_at ?? ''))
    .map(r => ({
      nameWithOwner: r.full_name,
      owner: r.owner.login,
      name: r.name,
      url: r.html_url,
      description: r.description,
      isPrivate: r.private,
      isArchived: r.archived,
      defaultBranch: r.default_branch,
      pushedAt: r.pushed_at,
      primaryLanguage: r.language,
    }))
  return { result: { installedOn: installations, repositories }, rateLimit: null }
}

async function getRepository(token, input) {
  const { owner, name } = requireCoordinates(input)
  const { data, rateLimit } = await githubGraphQL(token, 'RepositoryOverview', REPOSITORY_OVERVIEW, { owner, name })
  const r = data.repository
  if (!r) throw notVisible(`${owner}/${name}`)
  const branch = r.defaultBranchRef?.name ?? ''
  const totalSize = r.languages?.totalSize ?? 0
  const readme = r.readme ?? r.readmeLower
  return {
    rateLimit,
    result: {
      nameWithOwner: r.nameWithOwner,
      owner: r.owner.login,
      name: r.name,
      url: r.url,
      description: r.description,
      isPrivate: r.isPrivate,
      isArchived: r.isArchived,
      isFork: r.isFork,
      defaultBranch: branch,
      createdAt: r.createdAt,
      pushedAt: r.pushedAt,
      diskUsageKb: r.diskUsage,
      licenseSpdxId: r.licenseInfo?.spdxId ?? null,
      topics: (r.repositoryTopics?.nodes ?? []).map(n => n.topic.name),
      languages: (r.languages?.edges ?? []).map(e => ({ name: e.node.name, percent: totalSize ? Math.round((e.size / totalSize) * 100) : 0 })),
      readme: readme ? fileFrom(readme, r.readme ? 'README.md' : 'readme.md', branch || 'HEAD', r.url) : null,
      topLevel: (r.root?.entries ?? []).map(e => ({ name: e.name, path: e.path, type: entryType(e.type) })),
      branchCount: r.branches?.totalCount ?? null,
      tagCount: r.tags?.totalCount ?? null,
      releaseCount: r.releases?.totalCount ?? null,
      openPullRequestCount: r.openPullRequests?.totalCount ?? null,
    },
  }
}

async function getFile(token, input) {
  const { owner, name } = requireCoordinates(input)
  const path = validPath(input.path, { allowEmpty: false })
  const ref = validRef(input.ref)
  const { data, rateLimit } = await githubGraphQL(token, 'FileAtPath', FILE_AT_PATH, { owner, name, expression: `${ref}:${path}` })
  const r = data.repository
  if (!r) throw notVisible(`${owner}/${name}`)
  if (!r.object || r.object.__typename !== 'Blob') return { rateLimit, result: null }
  const reportedRef = ref === 'HEAD' ? (r.defaultBranchRef?.name ?? 'HEAD') : ref
  return { rateLimit, result: fileFrom(r.object, path, reportedRef, r.url) }
}

async function listDirectory(token, input) {
  const { owner, name } = requireCoordinates(input)
  const path = validPath(input.path, { allowEmpty: true })
  const ref = validRef(input.ref)
  const { data, rateLimit } = await githubGraphQL(token, 'DirectoryAtPath', DIRECTORY_AT_PATH, { owner, name, expression: `${ref}:${path}` })
  const r = data.repository
  if (!r) throw notVisible(`${owner}/${name}`)
  if (!r.object || r.object.__typename !== 'Tree') return { rateLimit, result: null }
  return {
    rateLimit,
    result: {
      path,
      ref: ref === 'HEAD' ? (r.defaultBranchRef?.name ?? 'HEAD') : ref,
      entries: (r.object.entries ?? []).map(e => ({ name: e.name, path: e.path, type: entryType(e.type) })),
    },
  }
}

async function getRecentChanges(token, input) {
  const { owner, name } = requireCoordinates(input)
  const since = resolveSince(input.since)
  const { data, rateLimit } = await githubGraphQL(token, 'RecentChanges', RECENT_CHANGES, { owner, name, since })
  const r = data.repository
  if (!r) throw notVisible(`${owner}/${name}`)
  const history = r.defaultBranchRef?.target?.history
  const sinceMs = Date.parse(since)
  return {
    rateLimit,
    result: {
      branch: r.defaultBranchRef?.name ?? '',
      since,
      commitCount: history?.totalCount ?? 0,
      commits: (history?.nodes ?? []).map(c => ({
        abbreviatedOid: c.abbreviatedOid,
        url: c.url,
        messageHeadline: c.messageHeadline,
        committedDate: c.committedDate,
        authorLogin: c.author?.user?.login ?? null,
        additions: c.additions,
        deletions: c.deletions,
        changedFiles: c.changedFilesIfAvailable ?? null,
        pullRequestNumber: c.associatedPullRequests?.nodes?.[0]?.number ?? null,
      })),
      mergedPullRequests: (r.pullRequests?.nodes ?? [])
        .filter(pr => pr.mergedAt != null && Date.parse(pr.mergedAt) >= sinceMs)
        .map(pullRequestFrom),
    },
  }
}

async function getPullRequests(token, input) {
  const { owner, name } = requireCoordinates(input)
  const state = ['OPEN', 'CLOSED', 'MERGED'].includes(input.state) ? input.state : 'OPEN'
  const requested = Number.isFinite(Number(input.first)) && input.first != null ? Number(input.first) : DEFAULT_PULL_REQUESTS
  const first = Math.min(Math.max(Math.trunc(requested), 1), MAX_PULL_REQUESTS)
  const { data, rateLimit } = await githubGraphQL(token, 'PullRequests', PULL_REQUESTS, { owner, name, states: [state], first })
  const r = data.repository
  if (!r) throw notVisible(`${owner}/${name}`)
  return {
    rateLimit,
    result: {
      state,
      totalCount: r.pullRequests?.totalCount ?? null,
      pullRequests: (r.pullRequests?.nodes ?? []).map(pullRequestFrom),
    },
  }
}

const IMPLEMENTATIONS = {
  SearchGitHubRepositories: searchRepositories,
  GetGitHubRepository: getRepository,
  GetGitHubFile: getFile,
  ListGitHubDirectory: listDirectory,
  GetGitHubRecentChanges: getRecentChanges,
  GetGitHubPullRequests: getPullRequests,
}

export const TOOL_NAMES = Object.keys(IMPLEMENTATIONS)

/**
 * Run one tool. `accessToken` null means GitHub is not connected, which is an
 * error the chatbot is told how to explain, never an empty result.
 * Returns `{ result, rateLimit }`; throws GitHubError.
 */
export async function runGitHubTool(name, input, accessToken) {
  const impl = IMPLEMENTATIONS[name]
  if (!impl) throw new GitHubError('BAD_USER_INPUT', `Unknown tool ${name}`)
  if (!accessToken) throw new GitHubError('SERVICE_UNAVAILABLE', 'GitHub is not connected for this user. They need to connect GitHub before any repository can be read.')
  return impl(accessToken, input ?? {})
}
