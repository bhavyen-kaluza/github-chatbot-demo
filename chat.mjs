#!/usr/bin/env node
// Terminal chat. Ask about the repositories your GitHub token can reach.
//
//   npm run chat                       interactive
//   npm run chat -- --ask "question"   one question, then exit
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { loadEnv, requireEnv } from './lib/env.mjs'
import { createClient, currentConnection, runTurn, modelName, fallbacksEnabled, explainApiError } from './lib/agent.mjs'

loadEnv()
requireEnv(['ANTHROPIC_API_KEY'])

const dim = s => `\x1b[2m${s}\x1b[0m`
const bold = s => `\x1b[1m${s}\x1b[0m`
const client = createClient()
const model = modelName()
const messages = []
let atLineStart = true

function write(s) {
  if (!s) return
  stdout.write(s)
  atLineStart = s.endsWith('\n')
}
function traceLine(s) {
  if (!atLineStart) write('\n')
  write(dim(s) + '\n')
}

function hours(ms) { return `${(ms / 3600000).toFixed(1)}h` }

async function banner() {
  const c = await currentConnection()
  console.log(bold('Cortex GitHub chatbot demo'))
  console.log(`  model    ${model}${fallbacksEnabled() ? ' (refusal fallback on)' : ''}`)
  if (c.connected) console.log(`  GitHub   connected as @${c.login ?? 'unknown'}, token expires in ${hours(c.expiresAt - Date.now())} and refreshes itself`)
  else console.log(`  GitHub   ${bold('not connected')}. Run  npm run login  in another terminal, then ask again.`)
  console.log(dim('  /status shows the connection, /reset clears the conversation, /quit exits.\n'))
}

async function ask(question) {
  const mark = messages.length
  messages.push({ role: 'user', content: question })
  const connection = await currentConnection()
  write('\n')
  try {
    const result = await runTurn({
      client,
      model,
      messages,
      connection,
      events: {
        onText: delta => write(delta),
        onToolStart: ({ name, input }) => traceLine(`  → ${name} ${JSON.stringify(input)}`),
        onToolEnd: ({ name, ms, ok, code, rateLimit }) => {
          const cost = rateLimit ? `, GitHub cost ${rateLimit.cost}, ${rateLimit.remaining} points left this hour` : ''
          traceLine(`  ← ${name} ${ok ? 'ok' : code} in ${ms} ms${cost}`)
        },
      },
    })
    if (!atLineStart) write('\n')
    if (result.stopReason === 'refusal') traceLine(`  (the model declined this request${result.stopDetails?.category ? `: ${result.stopDetails.category}` : ''})`)
    if (result.stopReason === 'max_tokens') traceLine('  (answer cut off at the length limit)')
    write('\n')
  } catch (err) {
    messages.length = mark // keep the history valid for the next question
    if (!atLineStart) write('\n')
    console.error(`\n${explainApiError(err)}\n`)
    if (oneShot) process.exit(1)
  }
}

const args = process.argv.slice(2)
const askIndex = args.indexOf('--ask')
const oneShot = askIndex >= 0 ? args.slice(askIndex + 1).join(' ').trim() : null

await banner()

if (oneShot) {
  await ask(oneShot)
  process.exit(0)
}

// Lines are queued rather than read with rl.question(), so input that arrives
// while an answer is streaming (or from a pipe) is processed in order instead
// of being dropped.
const rl = readline.createInterface({ input: stdin, output: stdout })
const queue = []
let ended = false
let wake = null
rl.on('line', line => { queue.push(line); wake?.() })
rl.on('close', () => { ended = true; wake?.() })
rl.on('SIGINT', () => { console.log('\nBye.'); process.exit(0) })

async function nextLine() {
  while (queue.length === 0) {
    if (ended) return null
    await new Promise(resolve => { wake = resolve })
    wake = null
  }
  return queue.shift()
}

while (true) {
  rl.setPrompt(bold('you> '))
  rl.prompt()
  const raw = await nextLine()
  if (raw === null) break
  const line = raw.trim()
  if (!line) continue
  if (line === '/quit' || line === '/exit') break
  if (line === '/reset') { messages.length = 0; console.log(dim('Conversation cleared.\n')); continue }
  if (line === '/status') {
    const c = await currentConnection()
    console.log(c.connected ? dim(`GitHub connected as @${c.login}, token expires in ${hours(c.expiresAt - Date.now())}\n`) : dim('GitHub not connected. Run  npm run login\n'))
    continue
  }
  await ask(line)
}
console.log('Bye.')
rl.close()
process.exit(0)
