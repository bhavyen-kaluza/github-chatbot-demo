#!/usr/bin/env node
// The web demo: one small server on port 3000 that does what cortex-app and
// cortex-api do together for GitHub.
//
//   GET  /                            the chat page
//   GET  /api/github/status           who is connected
//   GET  /api/github/oauth/start      send the browser to GitHub
//   GET  /api/github/oauth/callback   GitHub sends the browser back here with a code
//   POST /api/github/disconnect       forget the token
//   POST /api/chat                    ask a question; the answer streams back
//
// Port 3000 because that is where the GitHub App's callback URL points. It is
// also why this cannot run at the same time as `npm run login`, which listens
// on the same port for the same redirect.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { loadEnv, requireEnv, PROJECT_DIR } from './lib/env.mjs'
import { buildAuthorizeUrl, completeLogin, clearToken, redirectUri, GitHubTokenError } from './lib/github-auth.mjs'
import { createClient, currentConnection, runTurn, modelName, fallbacksEnabled, explainApiError } from './lib/agent.mjs'

loadEnv()
requireEnv(['ANTHROPIC_API_KEY', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'])

const callback = new URL(redirectUri())
const PORT = Number(process.env.PORT || callback.port || 3000)
const HOST = '127.0.0.1'
const STATE_TTL_MS = 10 * 60 * 1000
const MAX_HISTORY = 40
const MAX_MESSAGE_CHARS = 20_000

const client = createClient()
const pageFile = path.join(PROJECT_DIR, 'public', 'index.html')
/** Login attempts in flight: state → expiry. The callback must present one of these. */
const pendingStates = new Map()

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' })
  res.end()
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => {
      data += chunk
      if (data.length > 2_000_000) { reject(new Error('body too large')); req.destroy() }
    })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch { reject(new Error('body is not JSON')) }
    })
    req.on('error', reject)
  })
}

function newState() {
  const now = Date.now()
  for (const [state, expires] of pendingStates) if (expires < now) pendingStates.delete(state)
  const state = crypto.randomBytes(16).toString('hex')
  pendingStates.set(state, now + STATE_TTL_MS)
  return state
}

/** Turn the browser's plain-text history into API messages, refusing anything odd. */
function historyFrom(body) {
  const input = Array.isArray(body?.messages) ? body.messages : null
  if (!input || input.length === 0 || input.length > MAX_HISTORY) throw new Error(`messages must be a list of 1 to ${MAX_HISTORY} turns`)
  const messages = input.map(m => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') throw new Error('each turn needs a role of user or assistant and string content')
    if (m.content.length > MAX_MESSAGE_CHARS) throw new Error(`a turn is longer than ${MAX_MESSAGE_CHARS} characters`)
    return { role: m.role, content: m.content }
  })
  if (messages[0].role !== 'user' || messages[messages.length - 1].role !== 'user') throw new Error('the conversation must start and end with a user turn')
  return messages
}

async function handleChat(req, res) {
  let messages
  try {
    messages = historyFrom(await readJson(req))
  } catch (err) {
    return send(res, 400, { error: err.message })
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const connection = await currentConnection()
  emit('status', { connected: connection.connected, login: connection.login })
  try {
    const result = await runTurn({
      client,
      messages,
      connection,
      events: {
        onText: delta => emit('text', { delta }),
        onToolStart: ({ id, name, input }) => emit('tool_start', { id, name, input }),
        onToolEnd: ({ id, name, ms, ok, code, rateLimit }) => emit('tool_end', { id, name, ms, ok, code, rateLimit }),
      },
    })
    emit('done', { text: result.text, stopReason: result.stopReason, stopDetails: result.stopDetails })
  } catch (err) {
    emit('error', { message: explainApiError(err) })
  }
  res.end()
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, fs.readFileSync(pageFile), 'text/html; charset=utf-8')
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204)
      return res.end()
    }
    if (req.method === 'GET' && url.pathname === '/api/github/status') {
      const c = await currentConnection()
      return send(res, 200, { connected: c.connected, login: c.login, expiresAt: c.expiresAt, model: modelName(), fallbacks: fallbacksEnabled() })
    }
    if (req.method === 'GET' && url.pathname === '/api/github/oauth/start') {
      return redirect(res, buildAuthorizeUrl(newState(), redirectUri()))
    }
    if (req.method === 'GET' && url.pathname === callback.pathname) {
      const state = url.searchParams.get('state') ?? ''
      const known = pendingStates.get(state)
      pendingStates.delete(state)
      if (url.searchParams.get('error')) return redirect(res, '/?github_error=declined')
      if (!known || known < Date.now()) return redirect(res, '/?github_error=state')
      const code = url.searchParams.get('code')
      if (!code) return redirect(res, '/?github_error=unknown')
      try {
        const token = await completeLogin(code, redirectUri())
        console.log(`[web] GitHub connected as @${token.login}`)
        return redirect(res, '/')
      } catch (err) {
        const reason = err instanceof GitHubTokenError ? err.code : 'unknown'
        console.error(`[web] GitHub login failed: ${err.message}`)
        return redirect(res, `/?github_error=${encodeURIComponent(reason)}`)
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/github/disconnect') {
      clearToken()
      res.writeHead(204)
      return res.end()
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      return handleChat(req, res)
    }
    send(res, 404, { error: 'not found' })
  } catch (err) {
    console.error('[web]', err)
    if (!res.headersSent) send(res, 500, { error: err.message })
    else res.end()
  }
})

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop  npm run login  or the old probe script, then try again.`)
  } else {
    console.error(err)
  }
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`Cortex GitHub demo:  http://localhost:${PORT}`)
  console.log(`  model    ${modelName()}${fallbacksEnabled() ? ' (refusal fallback on)' : ''}`)
  console.log(`  callback ${redirectUri()}  (must match the GitHub App settings exactly)`)
  console.log('  Ctrl+C stops it.')
})
