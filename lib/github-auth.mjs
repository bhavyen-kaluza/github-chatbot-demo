// Signing in to GitHub with the Cortex GitHub App, and keeping the token.
//
// The flow is the standard OAuth "web application flow":
//   1. we send the browser to GitHub with our app's client id and a random `state`
//   2. the user clicks Authorize
//   3. GitHub sends the browser back to our callback URL with a one-time `code`
//   4. we swap the code for a token by calling GitHub with the client secret
//
// GitHub App user tokens last 8 hours and come with a refresh token that
// rotates on every use. In Cortex the pair lives in an encrypted HttpOnly
// cookie. In this single-user demo it lives in .github-token.json (mode 0600,
// git-ignored) so a login survives between runs.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { PROJECT_DIR } from './env.mjs'

export const USER_AGENT = 'cortex-github-chatbot-demo'
export const TOKEN_FILE = path.join(PROJECT_DIR, '.github-token.json')

/** Refresh when less than this remains, so a call never starts on a token about to die. */
export const REFRESH_BUFFER_MS = 5 * 60 * 1000
/** GitHub does not always say how long the refresh token lives; its documented lifetime is six months. */
const DEFAULT_REFRESH_LIFETIME_S = 180 * 24 * 3600
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

export const authBase = () => (process.env.GITHUB_AUTH_BASE_URL || 'https://github.com').replace(/\/$/, '')
export const apiBase = () => (process.env.GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/$/, '')
export const redirectUri = () => process.env.GITHUB_REDIRECT_URI || 'http://localhost:3000/api/github/oauth/callback'

export class GitHubTokenError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GitHubTokenError'
    this.code = code
  }
  /** The one terminal refresh failure: the grant is gone and only a new login helps. */
  get isBadRefreshToken() { return this.code === 'bad_refresh_token' }
}

function credentials() {
  const clientId = process.env.GITHUB_CLIENT_ID
  const clientSecret = process.env.GITHUB_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new GitHubTokenError('not_configured', 'GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not set')
  return { clientId, clientSecret }
}

export function isConfigured() {
  return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)
}

// ── step 1: the authorize URL ───────────────────────────────────────────────

export function buildAuthorizeUrl(state, redirect = redirectUri()) {
  const { clientId } = credentials()
  const url = new URL(`${authBase()}/login/oauth/authorize`)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirect)
  url.searchParams.set('state', state)
  // No `scope`: this is a GitHub App. Permissions live on the app itself.
  return url.toString()
}

// ── step 4: code (or refresh token) → token ─────────────────────────────────

async function postToken(params) {
  let res
  try {
    res = await fetch(`${authBase()}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams(params),
    })
  } catch (err) {
    throw new GitHubTokenError('network', `Could not reach GitHub: ${err.message}`)
  }
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* handled below */ }
  if (!res.ok) throw new GitHubTokenError(`http_${res.status}`, `GitHub's token endpoint answered HTTP ${res.status}`)
  if (!body) throw new GitHubTokenError('not_json', 'GitHub\'s token endpoint did not return JSON')
  // GitHub answers HTTP 200 with an error object for a bad code, a wrong
  // secret, or a dead refresh token. The status code tells you nothing.
  if (body.error) throw new GitHubTokenError(body.error, body.error_description || body.error)
  if (!body.access_token) throw new GitHubTokenError('no_access_token', 'GitHub\'s token response carried no access_token')
  return body
}

/**
 * Shape a token response into what we store. Returns null when GitHub sent a
 * token that never expires: that means "Expire user authorization tokens" is
 * switched off on the app, and this demo, like Cortex, refuses to hold such a
 * token.
 */
export function payloadFromTokenResponse(body, now = Date.now()) {
  if (!body.refresh_token || !body.expires_in) return null
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: now + Number(body.expires_in) * 1000,
    refreshTokenExpiresAt: now + Number(body.refresh_token_expires_in ?? DEFAULT_REFRESH_LIFETIME_S) * 1000,
  }
}

export async function exchangeCode(code, redirect = redirectUri()) {
  const { clientId, clientSecret } = credentials()
  return postToken({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirect })
}

export async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = credentials()
  return postToken({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken })
}

// ── the token file ──────────────────────────────────────────────────────────

export function loadToken() {
  try {
    const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))
    if (t && t.version === 1 && typeof t.accessToken === 'string') return t
  } catch { /* no file, or unreadable: same as not connected */ }
  return null
}

export function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2) + '\n', { mode: 0o600 })
  try { fs.chmodSync(TOKEN_FILE, 0o600) } catch { /* Windows */ }
}

export function clearToken() {
  try { fs.unlinkSync(TOKEN_FILE) } catch { /* already gone */ }
}

/** What the banners show. Never includes the token itself. */
export function describeStatus(token = loadToken(), now = Date.now()) {
  if (!token) return { connected: false, login: null, expiresAt: null, expiresInMs: null }
  return { connected: true, login: token.login ?? null, expiresAt: token.expiresAt, expiresInMs: token.expiresAt - now }
}

/**
 * A token good for at least the next five minutes, refreshed and re-saved
 * when needed. Null means "not connected": no file, or a grant GitHub has
 * declared dead, in which case the file is removed so the next banner says
 * so. Network trouble during a refresh is thrown, not swallowed, so the
 * caller can report GitHub as unreachable rather than as disconnected.
 */
export async function getValidToken(now = Date.now()) {
  const token = loadToken()
  if (!token) return null
  if (token.expiresAt - now > REFRESH_BUFFER_MS) return token
  if (token.refreshTokenExpiresAt <= now) {
    clearToken()
    return null
  }
  let body
  try {
    body = await refreshAccessToken(token.refreshToken)
  } catch (err) {
    if (err instanceof GitHubTokenError && err.isBadRefreshToken) {
      clearToken()
      return null
    }
    // Still usable for a few minutes: use it and try refreshing on the next call.
    if (token.expiresAt > now) return token
    throw err
  }
  const next = payloadFromTokenResponse(body, now)
  if (!next) {
    clearToken()
    return null
  }
  const saved = { ...token, ...next }
  saveToken(saved)
  return saved
}

// ── completing a login ──────────────────────────────────────────────────────

export async function fetchViewerLogin(accessToken) {
  const res = await fetch(`${apiBase()}/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': USER_AGENT },
  })
  if (!res.ok) throw new GitHubTokenError(`user_${res.status}`, `GET /user answered HTTP ${res.status}`)
  const body = await res.json()
  return body.login
}

/** Exchange a callback code, look up who it belongs to, and save the token. */
export async function completeLogin(code, redirect = redirectUri()) {
  const body = await exchangeCode(code, redirect)
  const payload = payloadFromTokenResponse(body)
  if (!payload) {
    throw new GitHubTokenError('no_refresh',
      'GitHub sent a token that never expires. Switch on "Expire user authorization tokens" in the app settings and sign in again.')
  }
  const login = await fetchViewerLogin(payload.accessToken)
  const token = { version: 1, login, ...payload }
  saveToken(token)
  return token
}

// ── the terminal login: a throwaway web server for one redirect ─────────────

export function openBrowser(target) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [target]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
    : ['xdg-open', [target]]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  } catch { /* the URL is printed regardless */ }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/** Listen at the registered callback URL for exactly one redirect from GitHub. */
export function waitForCallback(redirect, expectedState, { log = () => {} } = {}) {
  const url = new URL(redirect)
  const port = Number(url.port || 80)
  const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname

  return new Promise((resolve, reject) => {
    let timer
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      if (reqUrl.pathname !== url.pathname) { res.writeHead(404); res.end(); return }

      const p = reqUrl.searchParams
      const finish = (status, html, result) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><title>Cortex GitHub demo</title><body style="font-family:system-ui;padding:2rem">${html}</body>`)
        clearTimeout(timer)
        server.close()
        if (result instanceof Error) reject(result); else resolve(result)
      }

      if (p.get('error')) {
        const why = `${p.get('error')}: ${p.get('error_description') || 'no description'}`
        return finish(400, `<h2>GitHub said no</h2><p>${esc(why)}</p>`, new Error(`GitHub returned ${why}`))
      }
      if (p.get('state') !== expectedState) {
        return finish(400, '<h2>State mismatch</h2><p>Go back to the terminal.</p>',
          new Error('state mismatch: this callback did not come from the login this run started. Run it again and use the printed URL.'))
      }
      const code = p.get('code')
      if (!code) return finish(400, '<h2>No code</h2>', new Error('callback carried no code parameter'))
      finish(200, '<h2>Signed in. You can close this tab.</h2><p>Back to the terminal.</p>', code)
    })

    timer = setTimeout(() => {
      server.close()
      reject(new Error(`no callback within ${CALLBACK_TIMEOUT_MS / 60000} minutes`))
    }, CALLBACK_TIMEOUT_MS)

    server.on('error', err => {
      clearTimeout(timer)
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`port ${port} is already in use. Stop whatever is using it (the web demo, or the old probe script) and run this again.`))
      } else {
        reject(err)
      }
    })

    server.listen(port, host, () => log(`Listening on ${url.origin}${url.pathname} for GitHub's redirect`))
  })
}

export async function loginInteractive({ log = console.log } = {}) {
  const redirect = redirectUri()
  const state = crypto.randomBytes(16).toString('hex')
  const url = buildAuthorizeUrl(state, redirect)
  const pending = waitForCallback(redirect, state, { log })
  log(`\nOpen this in your browser if it does not open by itself:\n\n  ${url}\n`)
  openBrowser(url)
  const code = await pending
  log('Callback received, exchanging the code for a token...')
  return completeLogin(code, redirect)
}
