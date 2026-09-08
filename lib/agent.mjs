// The chatbot loop: send the conversation to Claude, run any tools it asks for,
// send the results back, repeat until it answers in words.
//
// Streaming manual loop from the Anthropic SDK docs. Text is streamed to the
// caller as it arrives; tool calls are executed in parallel and returned in a
// single message, which is what keeps the model making parallel calls.
import Anthropic from '@anthropic-ai/sdk'
import { TOOL_DEFINITIONS, runGitHubTool } from './github-tools.mjs'
import { GitHubError } from './github-api.mjs'
import { getValidToken, loadToken, GitHubTokenError } from './github-auth.mjs'
import { buildSystemPrompt } from './system-prompt.mjs'

export const DEFAULT_MODEL = 'claude-opus-5'
/** A question should never need more than a handful of round trips; this stops a runaway loop. */
const MAX_TOOL_ROUNDS = 12

export function modelName() {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL
}

/**
 * Server-side refusal fallback: if the model's safety classifiers decline a
 * request, Anthropic re-runs it on a fallback model inside the same call
 * instead of returning a refusal. On by default; CLAUDE_FALLBACKS=off disables
 * it, for keys or gateways that reject the beta header.
 */
export function fallbacksEnabled() {
  return (process.env.CLAUDE_FALLBACKS ?? 'on').toLowerCase() !== 'off'
}

export function createClient() {
  return new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL || undefined })
}

/**
 * Who is connected to GitHub right now. Refreshes the token when it is close
 * to expiry, so the answer reflects what a tool call is about to use.
 */
export async function currentConnection() {
  let token
  try {
    token = await getValidToken()
  } catch {
    token = loadToken() // GitHub unreachable during a refresh: report what we hold
  }
  return {
    connected: Boolean(token),
    login: token?.login ?? null,
    expiresAt: token?.expiresAt ?? null,
    getAccessToken: async () => (await getValidToken())?.accessToken ?? null,
  }
}

async function executeTool(block, connection, events) {
  const started = Date.now()
  events.onToolStart?.({ id: block.id, name: block.name, input: block.input })
  let content
  let isError = false
  let code = null
  let rateLimit = null
  try {
    const token = await connection.getAccessToken()
    const out = await runGitHubTool(block.name, block.input, token)
    rateLimit = out.rateLimit
    content = JSON.stringify(out.result)
  } catch (err) {
    isError = true
    if (err instanceof GitHubError) {
      code = err.code
      content = JSON.stringify({ error: { code: err.code, message: err.message } })
    } else if (err instanceof GitHubTokenError) {
      code = 'BAD_GATEWAY'
      content = JSON.stringify({ error: { code, message: `Refreshing the GitHub token failed: ${err.message}` } })
    } else {
      code = 'BAD_GATEWAY'
      content = JSON.stringify({ error: { code, message: err?.message || String(err) } })
    }
  }
  events.onToolEnd?.({ id: block.id, name: block.name, ms: Date.now() - started, ok: !isError, code, rateLimit })
  return { type: 'tool_result', tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) }
}

/**
 * Run one user turn. `messages` is the API-shaped history and is appended to in
 * place: the assistant's reply and every tool round trip stay in it, so the
 * next question can build on this one.
 *
 * events: onText(delta), onToolStart({id, name, input}), onToolEnd({id, name, ms, ok, code, rateLimit})
 * Returns { text, stopReason, stopDetails, usage }.
 */
export async function runTurn({ client, model = modelName(), messages, connection, events = {} }) {
  const system = buildSystemPrompt({ githubConnected: connection.connected, login: connection.login })
  let rounds = 0
  let text = ''
  let usage = null

  while (true) {
    const params = { model, max_tokens: 16000, system, tools: TOOL_DEFINITIONS, messages }
    const stream = fallbacksEnabled()
      ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : client.messages.stream(params)
    stream.on('text', delta => {
      text += delta
      events.onText?.(delta)
    })
    const message = await stream.finalMessage()
    usage = message.usage
    // Push the whole content, thinking and tool_use blocks included: the API
    // needs them back unchanged on the next request of this turn.
    messages.push({ role: 'assistant', content: message.content })

    if (message.stop_reason === 'tool_use') {
      rounds += 1
      const toolUses = message.content.filter(b => b.type === 'tool_use')
      const results = await Promise.all(toolUses.map(b => executeTool(b, connection, events)))
      messages.push({ role: 'user', content: results })
      if (rounds >= MAX_TOOL_ROUNDS) {
        messages.push({ role: 'user', content: 'Stop calling tools now and answer with what you have.' })
      }
      continue
    }
    if (message.stop_reason === 'pause_turn') continue

    return { text, stopReason: message.stop_reason, stopDetails: message.stop_details ?? null, usage }
  }
}

/** A short, honest sentence for an Anthropic API failure. */
export function explainApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key. Check ANTHROPIC_API_KEY in .env.'
  if (err instanceof Anthropic.BadRequestError && fallbacksEnabled() && /fallback|beta/i.test(err.message)) {
    return `Anthropic rejected the request: ${err.message}\nThis key or gateway may not support the fallback beta. Add CLAUDE_FALLBACKS='off' to .env and try again.`
  }
  if (err instanceof Anthropic.NotFoundError) return `Anthropic answered "not found": ${err.message}\nIs ANTHROPIC_MODEL spelled right? Default is ${DEFAULT_MODEL}.`
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic is rate limiting this key. Wait a moment and try again.'
  if (err instanceof Anthropic.APIConnectionError) return `Could not reach Anthropic: ${err.message}. Check the network, or ANTHROPIC_BASE_URL if you set one.`
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`
  return err?.stack || String(err)
}
